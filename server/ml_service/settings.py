import os
from dataclasses import dataclass
from pathlib import Path
from dotenv import load_dotenv

# Base dir of ml_service (folder containing this file)
BASE_DIR = Path(__file__).resolve().parent

# Always load the ml_service/.env next to this file
load_dotenv(dotenv_path=BASE_DIR / ".env")


def _resolve_path(p: str, default_abs: Path) -> str:
    """
    Resolve a path from env:
    - If env value is empty -> use default_abs
    - If env value is relative -> resolve relative to BASE_DIR
    - If env value is absolute -> keep it
    """
    raw = (p or "").strip()
    if not raw:
        return str(default_abs)
    pp = Path(raw)
    if pp.is_absolute():
        return str(pp)
    return str((BASE_DIR / pp).resolve())


def _bool(name: str, default: str = "false") -> bool:
    return (os.getenv(name, default) or "").strip().lower() in ("1", "true", "yes", "y", "on")


def _int(name: str, default: str) -> int:
    try:
        return int((os.getenv(name, default) or default).strip())
    except Exception:
        return int(default)


def _float(name: str, default: str) -> float:
    try:
        return float((os.getenv(name, default) or default).strip())
    except Exception:
        return float(default)


@dataclass(frozen=True)
class Settings:
    # Node -> ML auth (FastAPI checks header: x-service-key)
    SERVICE_KEY: str = os.getenv("ML_SERVICE_API_KEY", "")

    # Defense-in-depth debug gate (ML side)
    ALLOW_DEBUG_INJECTION: bool = _bool("ALLOW_DEBUG_INJECTION", "false")

    # Person C data service (empty until live)
    MARKET_DATA_SERVICE_URL: str = os.getenv("MARKET_DATA_SERVICE_URL", "")
    MARKET_DATA_SERVICE_API_KEY: str = os.getenv("MARKET_DATA_SERVICE_API_KEY", "")

    # Optional tuning
    MARKET_DATA_API_KEY_HEADER: str = os.getenv("MARKET_DATA_API_KEY_HEADER", "x-api-key")
    MARKET_DATA_TIMEOUT_S: float = _float("MARKET_DATA_TIMEOUT_S", "3.0")

    DEFAULT_INTERVAL: str = os.getenv("ML_DEFAULT_INTERVAL", "1h")
    DEFAULT_HORIZON: int = _int("ML_DEFAULT_HORIZON", "24")

    # Graph propagation / explainability tuning (Week 3)
    GRAPH_TOP_K: int = _int("ML_GRAPH_TOP_K", "8")
    PROP_STEPS: int = _int("ML_PROP_STEPS", "3")
    PROP_DECAY: float = _float("ML_PROP_DECAY", "0.6")
    DRIVERS_TOP_N: int = _int("ML_DRIVERS_TOP_N", "3")

    # Model artifacts (resolve relative paths safely)
    MODEL_WEIGHTS_PATH: str = _resolve_path(
        os.getenv("MODEL_WEIGHTS_PATH", ""),
        BASE_DIR / "models" / "weights.json",
    )

    SECURITY_MODEL_PATH: str = _resolve_path(
        os.getenv("SECURITY_MODEL_PATH", ""),
        BASE_DIR / "models" / "security_iforest.joblib",
    )


settings = Settings()
