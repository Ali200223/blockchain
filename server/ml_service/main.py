from __future__ import annotations

import math
import time
from typing import Any, Dict, List, Optional, Union

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from settings import settings
from data_client import DataClient
from model import SimpleGraphReturnModel
from propagation import (
    build_adjacency,
    diffuse_feature,
    top_neighbor_contributions,
    indirect_contributions_2hop,
    indirect_contributions_3hop,  
)
from security_anomaly import SecurityAnomalyModel


app = FastAPI(title="Crypto ML Service", version="0.2.1")
model = SimpleGraphReturnModel()
security_model = SecurityAnomalyModel.from_path(getattr(settings, "SECURITY_MODEL_PATH", ""))


def _to_bool(v: Any) -> bool:
    """Parse env-like values safely. (bool('false') is True, so parse strings explicitly.)"""
    if isinstance(v, bool):
        return v
    if v is None:
        return False
    if isinstance(v, (int, float)):
        return v != 0
    if isinstance(v, str):
        return v.strip().lower() in ("1", "true", "yes", "y", "on")
    return False


# ML-service-side debug injection gate (defense in depth).
ALLOW_DEBUG_INJECTION: bool = _to_bool(getattr(settings, "ALLOW_DEBUG_INJECTION", False))

# Optional Person C data service client (may be None)
data_client: Optional[DataClient] = None


@app.on_event("startup")
async def _startup():
    """Initialize DataClient on startup (safer than import-time init)."""
    global data_client

    market_url = getattr(settings, "MARKET_DATA_SERVICE_URL", "") or ""
    if not market_url:
        data_client = None
        return

    api_key = getattr(settings, "MARKET_DATA_SERVICE_API_KEY", "") or ""
    timeout_s = float(getattr(settings, "MARKET_DATA_TIMEOUT_S", 3.0) or 3.0)
    api_key_header = getattr(settings, "MARKET_DATA_API_KEY_HEADER", "x-api-key") or "x-api-key"

    # Support both DataClient signatures
    try:
        data_client = DataClient(
            market_url,
            api_key,
            timeout_s=timeout_s,
            api_key_header=api_key_header,
        )
    except TypeError:
        data_client = DataClient(
            market_url,
            api_key,
            timeout_s=timeout_s,
        )


@app.on_event("shutdown")
async def _shutdown():
    """Cleanly close httpx client if present (supports both .aclose() styles)."""
    global data_client
    if data_client is None:
        return

    try:
        if hasattr(data_client, "aclose"):
            await data_client.aclose()  # type: ignore[attr-defined]
        elif hasattr(data_client, "client") and hasattr(data_client.client, "aclose"):
            await data_client.client.aclose()
    except Exception:
        pass
    finally:
        data_client = None


class PredictRequest(BaseModel):
    # Core fields
    symbols: List[str] = Field(min_length=1, max_length=50)
    interval: str = Field(default=getattr(settings, "DEFAULT_INTERVAL", "1h"))

    # Canonical fields (current implementation)
    horizon: int = Field(default=getattr(settings, "DEFAULT_HORIZON", 24), ge=1, le=240)
    asOf: Optional[Union[int, str]] = None

    includePropagation: bool = True

    # Plan/UI naming compatibility
    horizonSteps: Optional[int] = Field(default=None, ge=1, le=240)
    asOfTime: Optional[Union[int, str]] = None

    # Debug injection (only allowed when ALLOW_DEBUG_INJECTION=true on ML service)
    debugFeatures: Optional[Dict[str, Dict[str, float]]] = None
    debugEdges: Optional[List[Dict[str, Any]]] = None


def check_service_key(x_service_key: Optional[str]) -> None:
    expected = getattr(settings, "SERVICE_KEY", "") or ""
    if expected and (x_service_key or "") != expected:
        raise HTTPException(status_code=401, detail="Invalid service key")


def sigmoid(z: float) -> float:
    return 1.0 / (1.0 + math.exp(-z))


def normalize_edges(edges: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for e in edges or []:
        src = str(e.get("src", "")).strip().upper()
        dst = str(e.get("dst", "")).strip().upper()
        if not src or not dst:
            continue

        w = float(e.get("weight", 0.0) or 0.0)
        if w == 0.0:
            continue

        out.append(
            {
                "src": src,
                "dst": dst,
                "weight": w,
                "lag": int(e.get("lag", 0) or 0),
            }
        )
    return out


class SecurityAnomalyRequest(BaseModel):
    """
    Accepts BOTH:
      A) canonical schema: { stats, drift, flags, extra }
      B) nested features: { features: { ... } }
      C) flat features at root: { login_fail_15m: 12, ipDrift: 1, ... }
    """
    stats: Dict[str, Any] = Field(default_factory=dict)
    drift: Dict[str, Any] = Field(default_factory=dict)
    flags: Dict[str, Any] = Field(default_factory=dict)
    extra: Dict[str, Any] = Field(default_factory=dict)

    features: Optional[Dict[str, Any]] = None
    userId: Optional[str] = None
    intent: Optional[str] = None
    sessionId: Optional[str] = None

    # allow flat feature keys at root
    model_config = {"extra": "allow"}


def _coerce_dict(v: Any) -> Dict[str, Any]:
    return v if isinstance(v, dict) else {}


def _extract_features_payload(body: Dict[str, Any]) -> Dict[str, Any]:
    stats = _coerce_dict(body.get("stats"))
    drift = _coerce_dict(body.get("drift"))
    flags = _coerce_dict(body.get("flags"))
    extra = _coerce_dict(body.get("extra"))

    nested = body.get("features")
    nested_features = nested if isinstance(nested, dict) else {}

    known = {"stats", "drift", "flags", "extra", "features", "userId", "intent", "sessionId"}
    flat_features: Dict[str, Any] = {}
    for k, v in (body or {}).items():
        if k in known:
            continue
        flat_features[k] = v

    features: Dict[str, Any] = {}
    if nested_features:
        features.update(nested_features)
    if flat_features:
        features.update(flat_features)

    drift_keys = {"ipdrift", "uadrift", "ip_drift", "ua_drift"}
    for k, v in (features or {}).items():
        k_str = str(k)
        k_norm = k_str.strip().lower()
        if k_norm in drift_keys:
            drift[k_str] = v
        else:
            stats[k_str] = v

    return {"stats": stats, "drift": drift, "flags": flags, "extra": extra}


@app.get("/security/anomaly-model")
async def security_model_info(x_service_key: Optional[str] = Header(default=None, alias="x-service-key")):
    check_service_key(x_service_key)
    return {
        "ok": True,
        "model": {
            "name": "security_anomaly",
            "version": security_model.model_version,
            "loadedArtifact": bool(security_model.loaded),
        },
    }


@app.post("/security/anomaly-score")
async def security_anomaly_score(
    req: SecurityAnomalyRequest,
    x_service_key: Optional[str] = Header(default=None, alias="x-service-key"),
):
    check_service_key(x_service_key)

    body = req.model_dump() or {}
    payload = _extract_features_payload(body)

    out = security_model.score(payload)
    return {"ok": True, "anomaly": out}


def adapt_features(x: Dict[str, Any]) -> Dict[str, float]:
    """
    Accept Person C schema + our internal schema.
    Normalizes to internal feature names used by the model.
    """

    def pick(*keys: str, default: float = 0.0) -> float:
        for k in keys:
            if k in x and x[k] is not None:
                try:
                    return float(x[k])
                except Exception:
                    pass
        return default

    ret_1 = pick("ret_1", "return", default=0.0)

    ma_short = pick("ma_short", default=0.0)
    ma_long = pick("ma_long", default=0.0)
    trend = (ma_short / ma_long - 1.0) if (ma_short > 0 and ma_long > 0) else 0.0

    mom_raw = pick("momentum_5", "momentum", default=0.0)
    momentum_5 = (mom_raw / ma_long) if (abs(mom_raw) > 5.0 and ma_long > 0) else mom_raw

    return {
        "ret_1": float(ret_1),
        "momentum_5": float(momentum_5),
        "volatility": float(pick("volatility", default=0.0)),
        "volume_ratio": float(pick("volume_ratio", default=1.0)),
        "ma_short": float(ma_short),
        "ma_long": float(ma_long),
        "trend": float(trend),
    }


@app.get("/health")
async def health():
    return {"ok": True, "model": {"name": model.info.name, "version": model.info.version}}


@app.post("/predict")
async def predict(req: PredictRequest, x_service_key: Optional[str] = Header(default=None, alias="x-service-key")):
    check_service_key(x_service_key)

    # Canonicalize aliases from plan/UI
    horizon_eff = req.horizonSteps if req.horizonSteps is not None else req.horizon
    asof_eff = req.asOfTime if req.asOfTime is not None else req.asOf

    # Defense-in-depth: block debug injection at ML service level too
    if (req.debugFeatures or req.debugEdges) and not ALLOW_DEBUG_INJECTION:
        raise HTTPException(status_code=403, detail="Debug injection disabled")

    symbols = [s.strip().upper() for s in (req.symbols or []) if s and s.strip()]
    symbols = list(dict.fromkeys(symbols))  # unique, preserve order
    if not symbols:
        raise HTTPException(status_code=400, detail="symbols must not be empty")

    # Tunables (env-configurable via settings.py)
    graph_top_k = int(getattr(settings, "GRAPH_TOP_K", 8) or 8)
    prop_steps = int(getattr(settings, "PROP_STEPS", 3) or 3)
    prop_decay = float(getattr(settings, "PROP_DECAY", 0.6) or 0.6)
    drivers_top_n = int(getattr(settings, "DRIVERS_TOP_N", 3) or 3)

    features_by_symbol: Dict[str, Dict[str, float]] = {s: {} for s in symbols}
    edges: List[dict] = []
    as_of_time: Any = asof_eff
    debug_used = bool(req.debugFeatures or req.debugEdges)

    # 1) debug overrides first
    if req.debugFeatures:
        for sym, feats in (req.debugFeatures or {}).items():
            s = str(sym).strip().upper()
            if s in features_by_symbol and isinstance(feats, dict):
                features_by_symbol[s] = adapt_features(feats)

    if req.debugEdges:
        edges = normalize_edges(req.debugEdges)

    # 2) Person C data fill (only if not overridden)
    if data_client is not None:
        if not req.debugFeatures:
            try:
                feat = await data_client.get_features_latest(symbols, req.interval, lookback=480, as_of=asof_eff)
                as_of_time = feat.get("asOfTime", as_of_time)
                for row in feat.get("features", []) or []:
                    sym = str(row.get("symbol", "")).strip().upper()
                    if sym in features_by_symbol:
                        x = row.get("x", {}) or {}
                        features_by_symbol[sym] = adapt_features(x)
            except Exception:
                pass

        if req.includePropagation and not req.debugEdges:
            try:
                try:
                    g = await data_client.get_influence_graph(
                        interval=req.interval,
                        window=240,
                        as_of=asof_eff,
                        method="corr",
                        symbols=symbols,
                    )
                except TypeError:
                    g = await data_client.get_influence_graph(
                        interval=req.interval,
                        window=240,
                        as_of=asof_eff,
                        method="corr",
                    )

                edges = normalize_edges(g.get("edges", []) or [])
                as_of_time = g.get("asOfTime", as_of_time)
            except Exception:
                edges = edges or []

    # 3) graph + rows
    adj = build_adjacency(edges, symbols, top_k=graph_top_k)

    rows: List[Dict[str, Any]] = []
    drivers: Dict[str, List[dict]] = {}

    for sym in symbols:
        x = features_by_symbol.get(sym, {}) or {}

        nbr_ret_1 = (
            diffuse_feature(sym, "ret_1", features_by_symbol, adj, steps=prop_steps, decay=prop_decay)
            if req.includePropagation
            else 0.0
        )

        row = {
            "symbol": sym,
            "ret_1": float(x.get("ret_1", 0.0) or 0.0),
            "momentum_5": float(x.get("momentum_5", 0.0) or 0.0),
            "nbr_ret_1": float(nbr_ret_1),
            "volatility": float(x.get("volatility", 0.0) or 0.0),
            "volume_ratio": float(x.get("volume_ratio", 1.0) or 1.0),
            "trend": float(x.get("trend", 0.0) or 0.0),
        }
        rows.append(row)

        d: List[dict] = []
        if req.includePropagation and sym in adj:
            for item in top_neighbor_contributions(sym, "ret_1", features_by_symbol, adj, top_n=drivers_top_n):
                d.append({"type": "neighbor", **item})

            for item in indirect_contributions_2hop(
                sym, "ret_1", features_by_symbol, adj, decay=prop_decay, top_n=drivers_top_n
            ):
                d.append({"type": "indirect", **item})

            if prop_steps >= 3:
                for item in indirect_contributions_3hop(
                    sym, "ret_1", features_by_symbol, adj, decay=prop_decay, top_n=drivers_top_n
                ):
                    d.append({"type": "indirect", **item})

        expl = model.explain(row) or {}
        d += [
            {"type": "self", "feature": "ret_1", "impact": float(expl.get("ret_1", 0.0))},
            {"type": "self", "feature": "nbr_ret_1", "impact": float(expl.get("nbr_ret_1", 0.0))},
            {"type": "self", "feature": "momentum_5", "impact": float(expl.get("momentum_5", 0.0))},
            {"type": "self", "feature": "trend", "impact": float(expl.get("trend", 0.0))},
            {"type": "self", "feature": "volatility", "impact": float(expl.get("volatility", 0.0))},
            {"type": "self", "feature": "volume_ratio", "impact": float(expl.get("volume_ratio", 0.0))},
        ]
        drivers[sym] = d

    # 4) predict
    y = model.predict_many(rows)

    preds = []
    for i, sym in enumerate(symbols):
        exp_ret = float(y[i])
        p_up = sigmoid(exp_ret * 35.0)
        conf = float(min(1.0, max(0.0, abs(p_up - 0.5) * 2)))

        preds.append(
            {
                "symbol": sym,
                "p_up": float(p_up),
                "exp_return": exp_ret,
                "confidence": conf,
                "drivers": drivers.get(sym, []),
            }
        )

    return {
        # Compatibility: return both names (safe for UI + backend)
        "asOfTime": as_of_time,
        "asOf": as_of_time,

        "interval": req.interval,

        "horizon": horizon_eff,
        "horizonSteps": horizon_eff,

        "debugUsed": debug_used,
        "predictions": preds,
        "model": {"name": model.info.name, "version": model.info.version},
        "createdAtMs": int(time.time() * 1000),
    }
@app.post("/admin/reload")
async def admin_reload_models(x_service_key: Optional[str] = Header(default=None, alias="x-service-key")):
    """
    Reload model weights + security anomaly artifact from disk
    without restarting the ML service process.
    """
    check_service_key(x_service_key)

    global model, security_model

    # Reload price model weights from MODEL_WEIGHTS_PATH
    model = SimpleGraphReturnModel()

    # Reload security anomaly artifact from SECURITY_MODEL_PATH
    security_model = SecurityAnomalyModel.from_path(getattr(settings, "SECURITY_MODEL_PATH", ""))

    return {
        "ok": True,
        "priceModel": {"name": model.info.name, "version": model.info.version},
        "securityModel": {"version": security_model.model_version, "loadedArtifact": bool(security_model.loaded)},
    }
