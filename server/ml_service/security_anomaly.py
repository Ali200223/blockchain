from __future__ import annotations

import hashlib
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

try:
    import joblib  # scikit-learn dependency
except Exception:  # pragma: no cover
    joblib = None


def _sigmoid(x: float) -> float:
    return 1.0 / (1.0 + math.exp(-x))


def _clamp01(x: float) -> float:
    return 0.0 if x < 0.0 else (1.0 if x > 1.0 else x)


def _sha12(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()[:12]


def _to_float(v: Any, default: float = 0.0) -> float:
    try:
        if v is None:
            return default
        return float(v)
    except Exception:
        return default


@dataclass(frozen=True)
class FeatureBaseline:
    mean: float
    std: float


DEFAULT_BASELINE: Dict[str, FeatureBaseline] = {
    # These baselines are intentionally conservative for cold-start.
    # Once you train a model (Step 2B), we will replace them with learned stats.
    "login_fail_15m": FeatureBaseline(mean=0.2, std=1.0),
    "login_success_5m": FeatureBaseline(mean=0.8, std=1.2),
    "login_success_1h": FeatureBaseline(mean=2.0, std=2.5),
    "distinct_ip_24h": FeatureBaseline(mean=1.2, std=1.0),
    "distinct_ip_7d": FeatureBaseline(mean=1.8, std=1.5),
    "distinct_ua_7d": FeatureBaseline(mean=1.3, std=1.0),
    "distinct_device_30d": FeatureBaseline(mean=1.6, std=1.6),
    "ipDrift": FeatureBaseline(mean=0.05, std=0.25),
    "uaDrift": FeatureBaseline(mean=0.05, std=0.25),
}


def flatten_features(payload: Dict[str, Any]) -> Dict[str, float]:
    """
    Accepts the same conceptual structure your session risk scorer already produces:
      - stats: { login_success_5m, login_success_1h, login_fail_15m, distinct_ip_24h, distinct_ua_7d, ... }
      - drift: { distinct_device_30d, distinct_ip_7d, ... }
      - flags: { ipDrift, uaDrift }
    """
    stats = payload.get("stats") or {}
    drift = payload.get("drift") or {}
    flags = payload.get("flags") or {}

    out = {
        "login_fail_15m": _to_float(stats.get("login_fail_15m"), 0.0),
        "login_success_5m": _to_float(stats.get("login_success_5m"), 0.0),
        "login_success_1h": _to_float(stats.get("login_success_1h"), 0.0),
        "distinct_ip_24h": _to_float(stats.get("distinct_ip_24h"), 0.0),
        "distinct_ua_7d": _to_float(stats.get("distinct_ua_7d"), 0.0),
        "distinct_ip_7d": _to_float(drift.get("distinct_ip_7d"), 0.0),
        "distinct_device_30d": _to_float(drift.get("distinct_device_30d"), 0.0),
        # booleans → 0/1
        "ipDrift": 1.0 if bool(flags.get("ipDrift")) else 0.0,
        "uaDrift": 1.0 if bool(flags.get("uaDrift")) else 0.0,
    }

    # Allow pass-through of any additional numeric features if you later extend
    extra = payload.get("extra") or {}
    if isinstance(extra, dict):
        for k, v in extra.items():
            if k in out:
                continue
            fv = _to_float(v, None)
            if fv is not None:
                out[str(k)] = float(fv)

    return out


class SecurityAnomalyModel:
    """
    Cold-start capable anomaly scorer.
    - If a trained IsolationForest artifact exists, uses it as primary signal.
    - Always computes robust z-score style feature deviations for explainability.
    """

    def __init__(self, artifact_path: Optional[Path] = None):
        self.artifact_path = artifact_path
        self.iforest = None
        self.learned_baseline: Optional[Dict[str, FeatureBaseline]] = None
        self.loaded: bool = False
        self.model_version: str = "security_anomaly_coldstart_v0"

        if artifact_path and artifact_path.exists():
            self._load_artifact(artifact_path)

    @classmethod
    def from_path(cls, path_str: str) -> "SecurityAnomalyModel":
        p = Path(path_str) if path_str else None
        return cls(p)

    def _load_artifact(self, p: Path) -> None:
        if joblib is None:
            # Artifact exists but joblib not importable; stay in cold-start
            return

        obj = joblib.load(p)
        # expected structure from Step 2B:
        # { "iforest": fitted_model, "baseline": {feature: {mean, std}}, "meta": {...} }
        self.iforest = obj.get("iforest")
        baseline = obj.get("baseline")
        if isinstance(baseline, dict):
            parsed: Dict[str, FeatureBaseline] = {}
            for k, v in baseline.items():
                if isinstance(v, dict):
                    parsed[k] = FeatureBaseline(
                        mean=_to_float(v.get("mean"), 0.0),
                        std=max(1e-6, _to_float(v.get("std"), 1.0)),
                    )
            self.learned_baseline = parsed

        self.loaded = True
        self.model_version = f"security_iforest_{_sha12(p)}"

    def _baseline(self) -> Dict[str, FeatureBaseline]:
        return self.learned_baseline or DEFAULT_BASELINE

    def score(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        feats = flatten_features(payload)
        baseline = self._baseline()

        # z-scores for explainability (feature deviation)
        z_abs: Dict[str, float] = {}
        for k, v in feats.items():
            b = baseline.get(k)
            if not b:
                continue
            z = (float(v) - b.mean) / (b.std if b.std > 1e-9 else 1.0)
            z_abs[k] = abs(float(z))

        # top contributors
        top = sorted(z_abs.items(), key=lambda kv: kv[1], reverse=True)[:6]
        contributors = [
            {"feature": k, "zAbs": float(z), "value": float(feats.get(k, 0.0))}
            for k, z in top
        ]

        # secondary score from z-max (cold-start reliable)
        zmax = max(z_abs.values(), default=0.0)
        z_score = _clamp01(zmax / 5.0)  # normalize: z>=5 becomes 1.0

        # primary score from isolation forest if available
        if_score = None
        if self.iforest is not None:
            # sklearn IsolationForest: decision_function > 0 normal, < 0 anomalous
            keys = sorted(feats.keys())
            X = np.array([[float(feats[k]) for k in keys]], dtype=float)

            try:
                df = float(self.iforest.decision_function(X)[0])
            except Exception:
                df = 0.0

            # map: df in [-0.5..0.5] roughly → [0..1] anomaly
            if_score = _clamp01(_sigmoid((-df) * 6.0))

        # combined score
        # iforest dominates when available; otherwise z_score is the primary signal
        if if_score is None:
            combined = z_score
        else:
            combined = _clamp01(0.65 * if_score + 0.35 * z_score)

        # explicit drift flags increase severity slightly (still ML output; Node can re-weight)
        if feats.get("ipDrift", 0.0) >= 1.0:
            combined = _clamp01(combined + 0.08)
        if feats.get("uaDrift", 0.0) >= 1.0:
            combined = _clamp01(combined + 0.06)

        if combined >= 0.75:
            label = "ANOMALOUS"
        elif combined >= 0.45:
            label = "SUSPICIOUS"
        else:
            label = "NORMAL"

        risk_points = int(round(combined * 40.0))  # 0..40

        return {
            "score": float(combined),          # 0..1
            "riskPoints": int(risk_points),    # 0..40
            "label": label,
            "modelVersion": self.model_version,
            "loadedArtifact": bool(self.loaded),
            "iforestScore": (None if if_score is None else float(if_score)),
            "zScore": float(z_score),
            "features": feats,
            "topContributors": contributors,
        }
