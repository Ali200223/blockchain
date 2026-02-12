import argparse, json
import numpy as np
import httpx

from propagation import build_adjacency, diffuse_feature

def rolling_mean_prev(x, w):
    # mean of previous window: out[i] uses x[i-w:i]
    out = np.full_like(x, np.nan, dtype=float)
    n = len(x)
    if w <= 0 or n <= w:
        return out

    c = np.cumsum(np.insert(x.astype(float), 0, 0.0))  # length n+1
    # for i = w..n-1: sum(x[i-w:i]) = c[i] - c[i-w]
    sums = c[w:n] - c[: n - w]  # length n-w
    out[w:] = sums / w
    return out

    # mean of previous window: for i uses x[i-w:i]
    out = np.full_like(x, np.nan, dtype=float)
    if w <= 0 or len(x) <= w:
        return out
    c = np.cumsum(np.insert(x.astype(float), 0, 0.0))
    # sum over [i-w, i)
    sums = c[w:] - c[:-w]
    out[w:] = sums / w
    return out

def rolling_std_prev(x, w):
    out = np.full_like(x, np.nan, dtype=float)
    n = len(x)
    if w <= 1 or n <= w:
        return out

    for i in range(w, n):
        window = x[i - w : i]
        if np.any(np.isnan(window)):
            continue
        out[i] = float(np.std(window))
    return out

    out = np.full_like(x, np.nan, dtype=float)
    if w <= 1 or len(x) <= w:
        return out
    # previous-window std: for i uses x[i-w:i]
    for i in range(w, len(x)+1):
        window = x[i-w:i]
        if np.any(np.isnan(window)):
            continue
        out[i-1] = float(np.std(window))
    return out

def compute_features(close, volume, L):
    # match Person C window ratios
    clamp = lambda v, m=5: max(int(np.floor(v)), m)
    short_w = clamp(L * 0.2)
    long_w  = clamp(L * 0.5)
    vol_w   = clamp(L * 0.3)
    mom_w   = clamp(L * 0.2)
    volr_w  = clamp(L * 0.3)

    ret = np.full_like(close, np.nan, dtype=float)
    ret[1:] = (close[1:] - close[:-1]) / close[:-1]

    ma_short = rolling_mean_prev(close, short_w)
    ma_long  = rolling_mean_prev(close, long_w)

    volatility = rolling_std_prev(ret, vol_w)
    momentum = np.full_like(close, np.nan, dtype=float)
    if mom_w < len(close):
        momentum[mom_w:] = close[mom_w:] - close[:-mom_w]

    vol_mean = rolling_mean_prev(volume, volr_w)
    volume_ratio = np.full_like(close, np.nan, dtype=float)
    ok = (vol_mean > 0) & ~np.isnan(vol_mean)
    volume_ratio[ok] = volume[ok] / vol_mean[ok]

    trend = np.full_like(close, 0.0, dtype=float)
    ok2 = (ma_short > 0) & (ma_long > 0) & ~np.isnan(ma_short) & ~np.isnan(ma_long)
    trend[ok2] = (ma_short[ok2] / ma_long[ok2]) - 1.0

    # momentum scaling logic similar to ML service (keep name momentum_5 for training compatibility)
    momentum_5 = momentum.copy()
    ok3 = (~np.isnan(momentum_5)) & (np.abs(momentum_5) > 5.0) & (ma_long > 0) & ~np.isnan(ma_long)
    momentum_5[ok3] = momentum_5[ok3] / ma_long[ok3]

    return {
        "ret_1": ret,
        "ma_short": ma_short,
        "ma_long": ma_long,
        "trend": trend,
        "momentum_5": momentum_5,
        "volatility": volatility,
        "volume_ratio": volume_ratio,
    }

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", required=True)   # Person C server_2, e.g. http://localhost:4000
    ap.add_argument("--symbols", required=True)    # comma list
    ap.add_argument("--interval", default="1h")
    ap.add_argument("--limit", type=int, default=2000)
    ap.add_argument("--lookback", type=int, default=480)
    ap.add_argument("--horizon", type=int, default=24)
    ap.add_argument("--out", default="price_weights.jsonl")
    ap.add_argument("--top-k", type=int, default=8)
    ap.add_argument("--steps", type=int, default=3)
    ap.add_argument("--decay", type=float, default=0.6)
    ap.add_argument("--api-key", default="")       # MARKET_DATA_SERVICE_API_KEY (if enabled)
    ap.add_argument("--api-key-header", default="x-api-key")
    args = ap.parse_args()

    symbols = [s.strip().upper() for s in args.symbols.split(",") if s.strip()]
    if not symbols:
        raise SystemExit("No symbols provided")

    headers = {}
    if args.api_key:
        headers[args.api_key_header] = args.api_key

    # 1) fetch influence graph once (good enough for training baseline)
    with httpx.Client(timeout=10.0, headers=headers) as client:
        g = client.get(f"{args.base_url.rstrip('/')}/v1/ml/influence_graph",
                       params={"interval": args.interval, "window": 240}).json()
        edges = g.get("edges", []) or []

        # 2) fetch candles
        c = client.get(f"{args.base_url.rstrip('/')}/v1/ml/candles",
                       params={"symbols": ",".join(symbols), "interval": args.interval, "limit": args.limit}).json()
        items = c.get("items", []) or []

    # group candles by symbol
    by_sym = {s: [] for s in symbols}
    for it in items:
        s = str(it.get("symbol", "")).upper()
        if s in by_sym:
            by_sym[s].append(it)

    # sort ascending by openTime
    for s in symbols:
        by_sym[s].sort(key=lambda x: int(x.get("openTime", 0)))

    # build timestamp intersection
    ts_sets = []
    for s in symbols:
        ts_sets.append(set(int(x["openTime"]) for x in by_sym[s] if "openTime" in x))
    common_ts = sorted(set.intersection(*ts_sets)) if ts_sets else []
    if len(common_ts) < (args.lookback + args.horizon + 10):
        raise SystemExit(f"Not enough aligned data. common_ts={len(common_ts)}")

    # build arrays aligned by common_ts
    aligned = {}
    idx_map = {s: {int(x["openTime"]): x for x in by_sym[s]} for s in symbols}
    for s in symbols:
        close = np.array([float(idx_map[s][t]["close"]) for t in common_ts], dtype=float)
        vol = np.array([float(idx_map[s][t].get("volume", 0.0) or 0.0) for t in common_ts], dtype=float)
        aligned[s] = {"close": close, "volume": vol}

    # compute per-symbol features
    feats = {}
    for s in symbols:
        feats[s] = compute_features(aligned[s]["close"], aligned[s]["volume"], args.lookback)

    # adjacency for propagation
    adj = build_adjacency(edges, symbols, top_k=args.top_k)

    # 3) write dataset rows
    out_n = 0
    with open(args.out, "w", encoding="utf-8") as f:
        # start where features are valid and we have horizon ahead
        start = args.lookback
        end = len(common_ts) - args.horizon - 1

        for i in range(start, end):
            # features_by_symbol at time i
            features_by_symbol = {}
            for s in symbols:
                row = {k: float(feats[s][k][i]) for k in ["ret_1","momentum_5","trend","volatility","volume_ratio"]}
                if any(np.isnan(v) for v in row.values()):
                    break
                features_by_symbol[s] = row
            else:
                # compute nbr_ret_1 with diffusion
                for s in symbols:
                    nbr = diffuse_feature(s, "ret_1", features_by_symbol, adj, steps=args.steps, decay=args.decay)
                    y = (aligned[s]["close"][i + args.horizon] - aligned[s]["close"][i]) / aligned[s]["close"][i]
                    rec = {
                        "symbol": s,
                        "ret_1": features_by_symbol[s]["ret_1"],
                        "nbr_ret_1": float(nbr),
                        "momentum_5": features_by_symbol[s]["momentum_5"],
                        "trend": features_by_symbol[s]["trend"],
                        "volatility": features_by_symbol[s]["volatility"],
                        "volume_ratio": features_by_symbol[s]["volume_ratio"],
                        "y_exp_return": float(y),
                    }
                    f.write(json.dumps(rec) + "\n")
                    out_n += 1

    print(f"Wrote {out_n} rows -> {args.out}")

if __name__ == "__main__":
    main()
