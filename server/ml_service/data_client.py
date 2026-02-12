from __future__ import annotations

from typing import Any, Dict, List, Optional
import asyncio
import httpx


class DataClient:
    def __init__(
        self,
        base_url: str,
        api_key: Optional[str] = None,
        timeout_s: float = 3.0,
        api_key_header: str = "x-api-key",
        retries: int = 1,
    ):
        self.base_url = (base_url or "").rstrip("/")
        if not self.base_url:
            raise ValueError("base_url is required")

        self.api_key = api_key or ""
        self.api_key_header = (api_key_header or "x-api-key").strip() or "x-api-key"
        self.retries = max(0, int(retries))

        timeout = httpx.Timeout(
            timeout=float(timeout_s),
            connect=float(timeout_s),
            read=float(timeout_s),
            write=float(timeout_s),
            pool=float(timeout_s),
        )

        limits = httpx.Limits(
            max_connections=20,
            max_keepalive_connections=10,
            keepalive_expiry=30.0,
        )

        self.client = httpx.AsyncClient(
            timeout=timeout,
            limits=limits,
            headers={"user-agent": "crypto-ml-service/0.2.0"},
        )

    def _headers(self) -> Dict[str, str]:
        h: Dict[str, str] = {}
        if self.api_key:
            h[self.api_key_header] = self.api_key
        return h

    async def _get_json(self, url: str, params: Dict[str, Any]) -> httpx.Response:
        """
        Single GET with tiny retry/backoff on transient errors.
        """
        last_err: Optional[Exception] = None
        attempts = 1 + self.retries

        for i in range(attempts):
            try:
                r = await self.client.get(url, params=params, headers=self._headers())
                return r
            except (httpx.TimeoutException, httpx.TransportError) as e:
                last_err = e
                # backoff: 150ms, 300ms, 600ms...
                if i < attempts - 1:
                    await asyncio.sleep(0.15 * (2**i))
                    continue
                raise e
            except Exception as e:
                last_err = e
                raise e

        raise last_err or RuntimeError("request failed")

    async def _get_first_ok(self, paths: List[str], params: Dict[str, Any]) -> Dict[str, Any]:
        """
        Try multiple candidate endpoints; skip 404; otherwise raise last error.
        """
        last_err: Optional[Exception] = None

        for p in paths:
            url = f"{self.base_url}{p}"
            try:
                r = await self._get_json(url, params=params)

                if r.status_code == 404:
                    continue

                r.raise_for_status()
                return r.json()
            except Exception as e:
                last_err = e
                continue

        raise last_err or RuntimeError("No endpoint succeeded")

    @staticmethod
    def _norm_symbols(symbols: List[str]) -> List[str]:
        out: List[str] = []
        seen = set()
        for s in symbols or []:
            ss = str(s).strip().upper()
            if not ss or ss in seen:
                continue
            seen.add(ss)
            out.append(ss)
        return out

    async def get_features_latest(
        self,
        symbols: List[str],
        interval: str,
        lookback: int = 480,
        as_of: Any = None,
    ) -> Dict[str, Any]:
        symbols = self._norm_symbols(symbols)
        params: Dict[str, Any] = {
            "symbols": ",".join(symbols),
            "interval": interval,
            "lookback": int(lookback),
        }
        if as_of is not None:
            # Person C uses asOfTime per earlier screenshot/contract
            params["asOfTime"] = as_of

        return await self._get_first_ok(
            paths=[
                "/v1/ml/latest_features",
                "/v1/ml/features/latest",
            ],
            params=params,
        )

    async def get_influence_graph(
        self,
        interval: str,
        window: int = 240,
        as_of: Any = None,
        method: str = "corr",
        symbols: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        params: Dict[str, Any] = {
            "interval": interval,
            "window": int(window),
            "method": method,
        }
        if as_of is not None:
            params["asOfTime"] = as_of
        if symbols:
            s2 = self._norm_symbols(symbols)
            if s2:
                params["symbols"] = ",".join(s2)

        return await self._get_first_ok(
            paths=[
                "/v1/ml/influence_graph",
                "/v1/ml/influence-graph",
                "/v1/ml/graph/influence",
                "/v1/ml/influenceGraph",
            ],
            params=params,
        )

    async def aclose(self) -> None:
        await self.client.aclose()
