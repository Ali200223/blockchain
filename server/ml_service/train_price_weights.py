from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Tuple

import numpy as np
from sklearn.linear_model import Ridge
from sklearn.metrics import mean_absolute_error, mean_squared_error

FEATURES = ["ret_1", "nbr_ret_1", "momentum_5", "trend", "volatility", "volume_ratio"]

def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")

def read_jsonl(path: Path) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            s = line.strip()
            if s:
                rows.append(json.loads(s))
    return rows

def to_matrix(rows: List[Dict[str, Any]]) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    n = len(rows)
    X = np.zeros((n, len(FEATURES)), dtype=float)
    y = np.zeros((n,), dtype=float)
    ts = np.zeros((n,), dtype=np.int64)

    for i, r in enumerate(rows):
        ts[i] = int(r.get("ts", 0))
        y[i] = float(r.get("y_exp_return", 0.0))
        for j, f in enumerate(FEATURES):
            X[i, j] = float(r.get(f, 0.0) or 0.0)

    return X, y, ts

def walk_forward_splits(ts: np.ndarray, n_folds: int = 5):
    order = np.argsort(ts)
    idx = order
    n = len(idx)
    fold_size = max(1, n // (n_folds + 1))
    splits = []

    for k in range(1, n_folds + 1):
        cut = k * fold_size
        cut2 = min(n, (k + 1) * fold_size)
        train_idx = idx[:cut]
        val_idx = idx[cut:cut2]
        if len(val_idx) < 50:
            break
        splits.append((train_idx, val_idx))
    return splits

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", required=True, help="Path to JSONL dataset")
    ap.add_argument("--out", dest="out", required=True, help="Output weights JSON path")
    ap.add_argument("--alpha", type=float, default=1.0, help="Ridge alpha")
    ap.add_argument("--folds", type=int, default=5, help="Walk-forward folds")
    args = ap.parse_args()

    in_path = Path(args.inp)
    rows = read_jsonl(in_path)
    if not rows:
        raise SystemExit("Empty dataset")

    X, y, ts = to_matrix(rows)

    splits = walk_forward_splits(ts, n_folds=int(args.folds))
    metrics = []
    for train_idx, val_idx in splits:
        m = Ridge(alpha=float(args.alpha), fit_intercept=True, random_state=42)
        m.fit(X[train_idx], y[train_idx])
        pred = m.predict(X[val_idx])

        rmse = float(np.sqrt(mean_squared_error(y[val_idx], pred)))
        mae = float(mean_absolute_error(y[val_idx], pred))
        dir_acc = float(np.mean((pred > 0) == (y[val_idx] > 0)))

        metrics.append({"rmse": rmse, "mae": mae, "directional_acc": dir_acc, "n_val": int(len(val_idx))})

    final = Ridge(alpha=float(args.alpha), fit_intercept=True, random_state=42)
    final.fit(X, y)

    weights = {
        "version": utc_now_iso(),
        "bias": float(final.intercept_),
        "ret_1": float(final.coef_[0]),
        "nbr_ret_1": float(final.coef_[1]),
        "momentum_5": float(final.coef_[2]),
        "trend": float(final.coef_[3]),
        "volatility": float(final.coef_[4]),
        "volume_ratio": float(final.coef_[5]),
        "training": {
            "trainedAt": utc_now_iso(),
            "input": {"path": str(in_path), "n": int(len(rows))},
            "model": {"type": "Ridge", "alpha": float(args.alpha)},
            "features": FEATURES,
            "walkForward": metrics,
        },
    }

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(weights, indent=2), encoding="utf-8")

    print(f"[OK] wrote weights: {out_path}")
    if metrics:
        print("[OK] walk-forward metrics:", json.dumps(metrics, indent=2))

if __name__ == "__main__":
    main()
