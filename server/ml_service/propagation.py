from __future__ import annotations

from typing import Any, Dict, List, Tuple

# adjacency: dst -> [(src, weight_used_norm, weight_raw, lag)]
Adjacency = Dict[str, List[Tuple[str, float, float, int]]]


def build_adjacency(edges: List[Dict[str, Any]], symbols: List[str], top_k: int = 8) -> Adjacency:
    symset = set([s.upper() for s in symbols])
    by_dst: Dict[str, List[Tuple[str, float, int]]] = {}

    for e in edges or []:
        src = str(e.get("src", "")).strip().upper()
        dst = str(e.get("dst", "")).strip().upper()
        if not src or not dst:
            continue
        if src not in symset or dst not in symset:
            continue

        w_raw = float(e.get("weight", 0.0) or 0.0)
        lag = int(e.get("lag", 0) or 0)

        if w_raw == 0.0:
            continue

        by_dst.setdefault(dst, []).append((src, w_raw, lag))

    # Top-k by |w|, then normalize per dst so sum(|w_used|)=1 (stability)
    adj: Adjacency = {}
    for dst, lst in by_dst.items():
        lst.sort(key=lambda t: abs(t[1]), reverse=True)
        lst = lst[: max(1, int(top_k))]

        denom = sum(abs(w) for (_src, w, _lag) in lst) or 1.0

        adj[dst] = [
            (src, float(w_raw) / float(denom), float(w_raw), int(lag))
            for (src, w_raw, lag) in lst
        ]

    return adj


def propagate_feature(
    dst: str,
    feature_name: str,
    features_by_symbol: Dict[str, Dict[str, float]],
    adj: Adjacency,
) -> float:
    """1-hop only: sum_{src in N(dst)} w_used * x(src)"""
    dst = dst.upper()
    total = 0.0
    for (src, w_used, _w_raw, _lag) in adj.get(dst, []):
        x = float(features_by_symbol.get(src, {}).get(feature_name, 0.0) or 0.0)
        total += float(w_used) * x
    return float(total)


def diffuse_feature(
    dst: str,
    feature_name: str,
    features_by_symbol: Dict[str, Dict[str, float]],
    adj: Adjacency,
    steps: int = 3,
    decay: float = 0.6,
) -> float:
    """
    Multi-hop diffusion:
      hop1 = A x
      hop2 = A (A x)
      ...
    total = hop1[dst] + decay*hop2[dst] + decay^2*hop3[dst] + ...
    """
    dst = dst.upper()
    nodes = list(features_by_symbol.keys())

    prev = {n: float(features_by_symbol.get(n, {}).get(feature_name, 0.0) or 0.0) for n in nodes}

    total_dst = 0.0
    for step in range(1, max(1, int(steps)) + 1):
        nxt = {n: 0.0 for n in nodes}
        for d in nodes:
            s = 0.0
            for (src, w_used, _w_raw, _lag) in adj.get(d, []):
                s += float(w_used) * float(prev.get(src, 0.0))
            nxt[d] = float(s)

        scale = (decay ** (step - 1))
        total_dst += float(scale) * float(nxt.get(dst, 0.0))
        prev = nxt

    return float(total_dst)


def top_neighbor_contributions(
    dst: str,
    feature_name: str,
    features_by_symbol: Dict[str, Dict[str, float]],
    adj: Adjacency,
    top_n: int = 3,
) -> List[dict]:
    """Explain direct neighbors: impactUsed = w_used * x(src), impactRaw = w_raw * x(src)"""
    dst = dst.upper()
    items = []

    for (src, w_used, w_raw, lag) in adj.get(dst, []):
        x = float(features_by_symbol.get(src, {}).get(feature_name, 0.0) or 0.0)

        items.append({
            "symbol": src,
            # keep backward-compat alias:
            "weight": float(w_used),
            "weightUsed": float(w_used),
            "weightRaw": float(w_raw),
            "lag": int(lag),
            "impact": float(w_used * x),
            "impactUsed": float(w_used * x),
            "impactRaw": float(w_raw * x),
        })

    items.sort(key=lambda r: abs(r["impact"]), reverse=True)
    return items[: max(1, int(top_n))]


def indirect_contributions_2hop(
    dst: str,
    feature_name: str,
    features_by_symbol: Dict[str, Dict[str, float]],
    adj: Adjacency,
    decay: float = 0.6,
    top_n: int = 3,
) -> List[dict]:
    """
    Explain 2-hop contributions matching diffuse_feature step2:
      decay * sum_{u in N(dst)} w_used(u->dst) * sum_{v in N(u)} w_used(v->u) * x(v)
    """
    dst = dst.upper()
    paths = []

    for (u, w_ud_used, w_ud_raw, lag_ud) in adj.get(dst, []):
        for (v, w_vu_used, w_vu_raw, lag_vu) in adj.get(u, []):
            x_v = float(features_by_symbol.get(v, {}).get(feature_name, 0.0) or 0.0)

            impact_used = float(decay) * float(w_ud_used) * float(w_vu_used) * x_v
            impact_raw = float(decay) * float(w_ud_raw) * float(w_vu_raw) * x_v

            if abs(impact_used) < 1e-12:
                continue

            paths.append({
                "path": [v, u, dst],
                "hop": 2,  # ✅ added for clarity/consistency
                "impact": float(impact_used),
                "impactUsed": float(impact_used),
                "impactRaw": float(impact_raw),

                "w1Used": float(w_vu_used),
                "w2Used": float(w_ud_used),
                "w1Raw": float(w_vu_raw),
                "w2Raw": float(w_ud_raw),

                "lag1": int(lag_vu),
                "lag2": int(lag_ud),
            })

    paths.sort(key=lambda r: abs(r["impact"]), reverse=True)
    return paths[: max(1, int(top_n))]


def indirect_contributions_3hop(
    dst: str,
    feature_name: str,
    features_by_symbol: Dict[str, Dict[str, float]],
    adj: Adjacency,
    decay: float = 0.6,
    top_n: int = 3,
) -> List[dict]:
    """
    Explain 3-hop contributions matching diffuse_feature step3:
      decay^2 * sum_{u in N(dst)} w(u->dst)
             * sum_{m in N(u)}  w(m->u)
             * sum_{v in N(m)}  w(v->m) * x(v)

    Path format returned: [v, m, u, dst] with hop=3
    """
    dst = dst.upper()
    paths: List[dict] = []

    scale = float(decay) * float(decay)

    for (u, w_ud_used, w_ud_raw, lag_ud) in adj.get(dst, []):
        for (m, w_mu_used, w_mu_raw, lag_mu) in adj.get(u, []):
            for (v, w_vm_used, w_vm_raw, lag_vm) in adj.get(m, []):
                x_v = float(features_by_symbol.get(v, {}).get(feature_name, 0.0) or 0.0)

                impact_used = scale * float(w_ud_used) * float(w_mu_used) * float(w_vm_used) * x_v
                impact_raw = scale * float(w_ud_raw) * float(w_mu_raw) * float(w_vm_raw) * x_v

                if abs(impact_used) < 1e-12:
                    continue

                paths.append({
                    "path": [v, m, u, dst],
                    "hop": 3,
                    "impact": float(impact_used),
                    "impactUsed": float(impact_used),
                    "impactRaw": float(impact_raw),

                    # weights along the path v->m->u->dst
                    "w1Used": float(w_vm_used),
                    "w2Used": float(w_mu_used),
                    "w3Used": float(w_ud_used),
                    "w1Raw": float(w_vm_raw),
                    "w2Raw": float(w_mu_raw),
                    "w3Raw": float(w_ud_raw),

                    "lag1": int(lag_vm),
                    "lag2": int(lag_mu),
                    "lag3": int(lag_ud),
                })

    paths.sort(key=lambda r: abs(r["impact"]), reverse=True)
    return paths[: max(1, int(top_n))]
