from __future__ import annotations
from dataclasses import dataclass
from typing import Dict, List, Any, Optional
import json
import os


@dataclass
class ModelInfo:
    name: str
    version: str


class SimpleGraphReturnModel:
    """
    Still simple (linear baseline) but:
    - uses more features (trend/volatility/volume_ratio)
    - can load weights from JSON to become "trainable" later
    """

    def __init__(self):
        self.info = ModelInfo(name="simple_graph_baseline", version="v2")

        self.weights = {
            "bias": 0.0,
            "ret_1": 0.65,
            "nbr_ret_1": 0.35,
            "momentum_5": 0.10,
            "trend": 0.20,
            "volatility": -0.15,
            "volume_ratio": 0.05,
        }

        path = os.getenv("MODEL_WEIGHTS_PATH", "").strip()
        if path and os.path.exists(path):
            try:
                with open(path, "r", encoding="utf-8") as f:
                    w = json.load(f)
                if isinstance(w, dict):
                    for k, v in w.items():
                        if k in self.weights:
                            self.weights[k] = float(v)
                    self.info = ModelInfo(name="simple_graph_trained", version=w.get("version", "v2"))
            except Exception:
                pass

    def _get(self, row: Dict[str, Any], k: str, default: float = 0.0) -> float:
        try:
            return float(row.get(k, default) or default)
        except Exception:
            return default

    def predict_one(self, row: Dict[str, Any]) -> float:
        b = float(self.weights["bias"])
        y = b
        for k in ("ret_1", "nbr_ret_1", "momentum_5", "trend", "volatility", "volume_ratio"):
            y += float(self.weights.get(k, 0.0)) * self._get(row, k, 0.0)
        return float(y)

    def predict_many(self, rows: List[Dict[str, Any]]) -> List[float]:
        return [self.predict_one(r) for r in rows]

    def explain(self, row: Dict[str, Any]) -> Dict[str, float]:
        out = {}
        for k in ("ret_1", "nbr_ret_1", "momentum_5", "trend", "volatility", "volume_ratio"):
            out[k] = float(self.weights.get(k, 0.0)) * self._get(row, k, 0.0)
        return out