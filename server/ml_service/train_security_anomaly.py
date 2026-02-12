from __future__ import annotations

import argparse
import json
import math
import random
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

import numpy as np
from sklearn.ensemble import IsolationForest

try:
    import joblib
except Exception as e:  # pragma: no cover
    raise SystemExit("joblib is required (it is a scikit-learn dependency).") from e


FEATURES: List[str] = [
    "login_fail_15m",
    "login_success_5m",
    "login_success_1h",
    "distinct_ip_24h",
    "distinct_ip_7d",
    "distinct_ua_7d",
    "distinct_device_30d",
    "ipDrift",
    "uaDrift",
]

COUNT_FEATURES = [
    "login_fail_15m",
    "login_success_5m",
    "login_success_1h",
    "distinct_ip_24h",
    "distinct_ip_7d",
    "distinct_ua_7d",
    "distinct_device_30d",
]

FLAG_FEATURES = ["ipDrift", "uaDrift"]


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def clamp(v: float, lo: float, hi: float) -> float:
    return lo if v < lo else (hi if v > hi else v)


# --- PATCH: finite-safe coercion to prevent NaN/inf poisoning training ---
def _to_float(v: Any, default: float = 0.0) -> float:
    """
    Convert to float, but never return NaN/inf.
    Protects training from invalid exported values.
    """
    try:
        if v is None:
            return default
        x = float(v)
        if not math.isfinite(x):
            return default
        return x
    except Exception:
        return default


def read_jsonl(path: Path) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            s = line.strip()
            if not s:
                continue
            out.append(json.loads(s))
    return out


def extract_feature_rows(rows: List[Dict[str, Any]]) -> List[Dict[str, float]]:
    feats: List[Dict[str, float]] = []
    for r in rows:
        rec: Dict[str, float] = {}
        for k in FEATURES:
            rec[k] = float(_to_float(r.get(k), 0.0))
        feats.append(rec)
    return feats


def to_matrix(samples: List[Dict[str, float]], log1p: bool) -> np.ndarray:
    X = np.zeros((len(samples), len(FEATURES)), dtype=float)
    for i, s in enumerate(samples):
        for j, f in enumerate(FEATURES):
            v = float(s.get(f, 0.0))
            if log1p and f in COUNT_FEATURES:
                v = float(np.log1p(max(0.0, v)))
            X[i, j] = v
    return X


def compute_baseline(samples: List[Dict[str, float]]) -> Dict[str, Dict[str, float]]:
    """
    Baseline mean/std on RAW features (no transform) for the z-score explainability in security_anomaly.py.
    """
    X = to_matrix(samples, log1p=False)
    baseline: Dict[str, Dict[str, float]] = {}
    for j, f in enumerate(FEATURES):
        col = X[:, j]
        mean = float(np.mean(col))
        std = float(np.std(col))
        if std < 1e-6:
            std = 1e-6
        baseline[f] = {"mean": mean, "std": std}
    return baseline


@dataclass(frozen=True)
class RealDistribution:
    mean: Dict[str, float]
    std: Dict[str, float]
    flag_rate: Dict[str, float]


def estimate_distribution(real_samples: List[Dict[str, float]]) -> RealDistribution:
    X = to_matrix(real_samples, log1p=False)
    mean: Dict[str, float] = {}
    std: Dict[str, float] = {}
    for j, f in enumerate(FEATURES):
        col = X[:, j]
        mean[f] = float(np.mean(col))
        stdv = float(np.std(col))
        std[f] = stdv if stdv > 1e-6 else 1e-6

    flag_rate: Dict[str, float] = {}
    for f in FLAG_FEATURES:
        flag_rate[f] = float(clamp(mean[f], 0.0, 1.0))

    return RealDistribution(mean=mean, std=std, flag_rate=flag_rate)


def synth_normal_from_real(rng: random.Random, dist: RealDistribution) -> Dict[str, float]:
    """
    Generate plausible "normal" samples shaped by the real distribution.
    Uses Poisson for counts (lambda from real mean, with small inflation to avoid degenerate training),
    Bernoulli for drift flags (rate from real).
    """
    rec: Dict[str, float] = {}

    # --- PATCH: sanitize Poisson lambda to avoid NaN/inf crashes ---
    for f in COUNT_FEATURES:
        lam = dist.mean.get(f, 0.5)
        if not math.isfinite(lam):
            lam = 0.5
        lam = max(0.05, float(lam)) * 1.15  # light inflation to broaden manifold
        lam = min(lam, 1e6)  # hard cap safety
        rec[f] = float(np.random.poisson(lam=lam))

    for f in FLAG_FEATURES:
        p = clamp(dist.flag_rate.get(f, 0.05), 0.0, 1.0)
        # keep drift rare unless real indicates otherwise
        p = clamp(max(p, 0.03), 0.0, 0.25)
        rec[f] = 1.0 if rng.random() < p else 0.0

    # enforce minimum distinctness realism
    rec["distinct_ip_24h"] = max(1.0, rec["distinct_ip_24h"])
    rec["distinct_ip_7d"] = max(1.0, rec["distinct_ip_7d"])
    rec["distinct_ua_7d"] = max(1.0, rec["distinct_ua_7d"])
    rec["distinct_device_30d"] = max(1.0, rec["distinct_device_30d"])

    return rec


def synth_attack_pattern(rng: random.Random, dist: RealDistribution) -> Dict[str, float]:
    """
    Synthetic anomalous patterns for evaluation sanity, not strictly needed for training,
    but useful to verify separation.
    """
    s = synth_normal_from_real(rng, dist)
    pattern = rng.choice(["bruteforce", "ip_spray", "device_hopping", "ua_drift"])

    if pattern == "bruteforce":
        s["login_fail_15m"] = float(np.random.poisson(lam=8.0) + 6)
        s["login_success_5m"] = float(np.random.poisson(lam=0.1))
        s["login_success_1h"] = float(np.random.poisson(lam=0.4))
    elif pattern == "ip_spray":
        s["distinct_ip_24h"] = float(np.random.poisson(lam=8.0) + 8)
        s["distinct_ip_7d"] = float(np.random.poisson(lam=12.0) + 12)
        s["ipDrift"] = 1.0
    elif pattern == "device_hopping":
        s["distinct_device_30d"] = float(np.random.poisson(lam=9.0) + 8)
        s["distinct_ip_24h"] = float(np.random.poisson(lam=4.0) + 3)
    else:  # ua_drift
        s["distinct_ua_7d"] = float(np.random.poisson(lam=7.0) + 6)
        s["uaDrift"] = 1.0

    return s


def decision_summary(model: IsolationForest, X_norm: np.ndarray, X_anom: np.ndarray) -> Dict[str, float]:
    df_norm = model.decision_function(X_norm)
    df_anom = model.decision_function(X_anom)
    return {
        "norm_p10": float(np.percentile(df_norm, 10)),
        "norm_p50": float(np.percentile(df_norm, 50)),
        "norm_p90": float(np.percentile(df_norm, 90)),
        "anom_p10": float(np.percentile(df_anom, 10)),
        "anom_p50": float(np.percentile(df_anom, 50)),
        "anom_p90": float(np.percentile(df_anom, 90)),
    }


def main():
    ap = argparse.ArgumentParser()

    ap.add_argument("--in", dest="in_path", required=True, help="Input JSONL from exportSecurityFeatures.js")
    ap.add_argument("--out", default="models/security_iforest.joblib", help="Output artifact path")
    ap.add_argument("--seed", type=int, default=1337, help="Random seed")

    ap.add_argument("--target-train", type=int, default=6000, help="Target training rows after augmentation")
    ap.add_argument("--min-real", type=int, default=300, help="If real samples below this, broaden synthetic manifold")
    ap.add_argument("--contamination", type=float, default=0.02, help="IsolationForest contamination")
    ap.add_argument("--log1p", action="store_true", help="Apply log1p transform to count features for model training")

    ap.add_argument("--n-eval-anom", type=int, default=800, help="Eval anomaly samples for sanity check")
    ap.add_argument("--n-eval-norm", type=int, default=400, help="Eval normal samples for sanity check")

    args = ap.parse_args()

    rng = random.Random(args.seed)
    np.random.seed(args.seed)

    in_path = Path(args.in_path)
    if not in_path.exists():
        raise SystemExit(f"Input file not found: {in_path}")

    raw_rows = read_jsonl(in_path)
    real_samples = extract_feature_rows(raw_rows)

    n_real = len(real_samples)
    if n_real == 0:
        raise SystemExit("No real samples found in JSONL.")

    dist = estimate_distribution(real_samples)

    # Decide augmentation volume
    target_train = max(n_real, int(args.target_train))
    n_synth = max(0, target_train - n_real)

    # If real is small, generate a wider synthetic normal manifold
    widen = n_real < int(args.min_real)

    synth_norm: List[Dict[str, float]] = []
    for _ in range(n_synth):
        s = synth_normal_from_real(rng, dist)
        if widen:
            # widen by random multiplicative jitter on counts (kept reasonable)
            for f in COUNT_FEATURES:
                v = s[f]
                mult = clamp(rng.uniform(0.85, 1.35), 0.5, 2.0)
                s[f] = float(max(0.0, round(v * mult)))
        synth_norm.append(s)

    train_samples = real_samples + synth_norm

    # Baseline for explainability:
    # Prefer real-only if decent volume; otherwise use mixed to avoid degenerate std=0.
    baseline_source = real_samples if n_real >= 100 else train_samples
    baseline = compute_baseline(baseline_source)

    X_train = to_matrix(train_samples, log1p=bool(args.log1p))

    iforest = IsolationForest(
        n_estimators=300,
        max_samples="auto",
        contamination=float(args.contamination),
        bootstrap=False,
        n_jobs=-1,
        random_state=int(args.seed),
    )
    iforest.fit(X_train)

    # Sanity evaluation (not a final metric)
    eval_norm = [synth_normal_from_real(rng, dist) for _ in range(int(args.n_eval_norm))]
    eval_anom = [synth_attack_pattern(rng, dist) for _ in range(int(args.n_eval_anom))]

    X_eval_norm = to_matrix(eval_norm, log1p=bool(args.log1p))
    X_eval_anom = to_matrix(eval_anom, log1p=bool(args.log1p))

    summary = {
        "trainedAt": utc_now_iso(),
        "input": {
            "path": str(in_path),
            "nReal": int(n_real),
            "nSynth": int(len(synth_norm)),
            "targetTrain": int(target_train),
            "widenedSynthetic": bool(widen),
        },
        "model": {
            "type": "IsolationForest",
            "n_estimators": 300,
            "contamination": float(args.contamination),
            "seed": int(args.seed),
            "log1p": bool(args.log1p),
        },
        "features": FEATURES,
        "baselineSource": ("real" if baseline_source is real_samples else "mixed"),
        "decisionFunction": decision_summary(iforest, X_eval_norm, X_eval_anom),
    }

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    artifact = {
        "iforest": iforest,
        "baseline": baseline,
        "meta": summary,
    }

    joblib.dump(artifact, out_path)
    report_path = out_path.with_suffix(".report.json")
    report_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")

    print(f"[OK] Wrote artifact: {out_path}")
    print(f"[OK] Wrote report:   {report_path}")
    print(json.dumps(summary["decisionFunction"], indent=2))


if __name__ == "__main__":
    main()
