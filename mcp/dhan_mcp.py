#!/usr/bin/env python3
"""
dhan-data MCP server — one tool, `run_python`.

The model writes a Python script; this server executes it and hands back
whatever it printed. Every Dhan read the zap-eve agent can do is preloaded
into the script's namespace as a plain function (see SKILL.md, which is the
document the model should be given).

Ported from agent/lib/dhan/{client,specs,options-specs,underlying}.ts.
READ-ONLY by design: no order placement, modification, or cancellation exists
anywhere in this file, exactly as in the TypeScript original.

Credentials come from the environment:
    DHAN_CLIENT_ID=...
    DHAN_ACCESS_TOKEN=...        # Dhan tokens last 24h
    DHAN_BASE_URL=...            # optional, defaults to https://api.dhan.co/v2

A `.env` file beside this file or in the repo root is read for any of those
that are not already set (--env-file points somewhere else).

Run:
    pip install "mcp[cli]" httpx
    python mcp/dhan_mcp.py                  # stdio (what MCP clients launch)
    python mcp/dhan_mcp.py --http --port 8931
    python mcp/dhan_mcp.py --check          # smoke-test creds without a client
"""

from __future__ import annotations

import argparse
import ast
import ctypes
import io
import json
import os
import sys
import threading
import time
import traceback
from contextlib import redirect_stderr, redirect_stdout
from datetime import date, datetime, timedelta, timezone
from typing import Any, Iterable, Literal, Sequence

import httpx

DEFAULT_BASE_URL = "https://api.dhan.co/v2"
IST = timezone(timedelta(hours=5, minutes=30))

# How long a submitted script may run before it is interrupted, and how much
# output comes back. Both overridable from the environment.
EXEC_TIMEOUT_S = float(os.environ.get("DHAN_MCP_EXEC_TIMEOUT", "120"))
MAX_OUTPUT_CHARS = int(os.environ.get("DHAN_MCP_MAX_OUTPUT", "100000"))

# ---------------------------------------------------------------------------
# F&O underlying master
# ---------------------------------------------------------------------------
# GENERATED from agent/lib/dhan/fno-underlyings.ts (Dhan detailed scrip
# master, 2026-09-04). Index tickers map to IDX_I security ids, stock tickers
# to NSE_EQ ids; both are the `UnderlyingScrip` the option-chain APIs take.
# The NSETEST placeholder rows in the TS file are dropped here.
FNO_INDICES: dict[str, int] = {
    "BANKEX": 69, "BANKNIFTY": 25, "FINNIFTY": 27, "MIDCPNIFTY": 442, "NIFTY": 13,
    "NIFTYNXT50": 38, "SENSEX": 51, "SNSX50": 83,
}

FNO_STOCKS: dict[str, int] = {
    "360ONE": 13061, "ABB": 13, "ABCAPITAL": 21614, "ADANIENSOL": 10217, "ADANIENT": 25,
    "ADANIGREEN": 3563, "ADANIPORTS": 15083, "ADANIPOWER": 17388, "ALKEM": 11703,
    "AMBER": 1185, "AMBUJACEM": 1270, "ANGELONE": 324, "APLAPOLLO": 25780, "APOLLOHOSP": 157,
    "ASHOKLEY": 212, "ASIANPAINT": 236, "ASTRAL": 14418, "ATHERENERG": 757645, "AUBANK": 21238,
    "AUROPHARMA": 275, "AXISBANK": 5900, "BAJAJ-AUTO": 16669, "BAJAJFINSV": 16675,
    "BAJAJHLDNG": 305, "BAJFINANCE": 317, "BANDHANBNK": 2263, "BANKBARODA": 4668,
    "BANKINDIA": 4745, "BDL": 2144, "BEL": 383, "BHARATFORG": 422, "BHARTIARTL": 10604,
    "BHEL": 438, "BIOCON": 11373, "BLUESTARCO": 8311, "BOSCHLTD": 2181, "BPCL": 526,
    "BRITANNIA": 547, "BSE": 19585, "CAMS": 342, "CANBK": 10794, "CDSL": 21174, "CGPOWER": 760,
    "CHOLAFIN": 685, "CIPLA": 694, "COALINDIA": 20374, "COCHINSHIP": 21508, "COFORGE": 11543,
    "COLPAL": 15141, "CONCOR": 4749, "CROMPTON": 17094, "CUMMINSIND": 1901, "DABUR": 772,
    "DELHIVERY": 9599, "DIVISLAB": 10940, "DIXON": 21690, "DLF": 14732, "DMART": 19913,
    "DRREDDY": 881, "EICHERMOT": 910, "ETERNAL": 5097, "FEDERALBNK": 1023, "FORCEMOT": 11573,
    "FORTIS": 14592, "GAIL": 4717, "GLENMARK": 7406, "GMRAIRPORT": 13528, "GODFRYPHLP": 1181,
    "GODREJCP": 10099, "GODREJPROP": 17875, "GRASIM": 1232, "GVT&D": 16783, "HAL": 2303,
    "HAVELLS": 9819, "HCLTECH": 7229, "HDFCAMC": 4244, "HDFCBANK": 1333, "HDFCLIFE": 467,
    "HEROMOTOCO": 1348, "HINDALCO": 1363, "HINDPETRO": 1406, "HINDUNILVR": 1394,
    "HINDZINC": 1424, "HYUNDAI": 25844, "ICICIBANK": 4963, "ICICIGI": 21770,
    "ICICIPRULI": 18652, "IDEA": 14366, "IDFCFIRSTB": 11184, "IEX": 220, "INDHOTEL": 1512,
    "INDIANB": 14309, "INDIGO": 11195, "INDUSINDBK": 5258, "INDUSTOWER": 29135, "INFY": 1594,
    "INOXWIND": 7852, "IOC": 1624, "IREDA": 20261, "IRFC": 2029, "ITC": 1660,
    "JINDALSTEL": 6733, "JIOFIN": 18143, "JSWENERGY": 17869, "JSWSTEEL": 11723,
    "JUBLFOOD": 18096, "KALYANKJIL": 2955, "KAYNES": 12092, "KEI": 13310, "KFINTECH": 13359,
    "KOTAKBANK": 1922, "KPITTECH": 9683, "LAURUSLABS": 19234, "LICHSGFIN": 1997, "LICI": 9480,
    "LODHA": 3220, "LT": 11483, "LTF": 24948, "LTM": 17818, "LUPIN": 10440, "M&M": 2031,
    "MAHABANK": 11377, "MANAPPURAM": 19061, "MANKIND": 15380, "MARICO": 4067, "MARUTI": 10999,
    "MAXHEALTH": 22377, "MAZDOCK": 509, "MCX": 31181, "MFSL": 2142, "MOTHERSON": 4204,
    "MOTILALOFS": 14947, "MPHASIS": 4503, "MUTHOOTFIN": 23650, "NAM-INDIA": 357,
    "NATIONALUM": 6364, "NAUKRI": 13751, "NBCC": 31415, "NESTLEIND": 17963, "NHPC": 17400,
    "NMDC": 15332, "NTPC": 11630, "NYKAA": 6545, "OBEROIRLTY": 20242, "OFSS": 10738,
    "OIL": 17438, "ONGC": 2475, "PAGEIND": 14413, "PATANJALI": 17029, "PAYTM": 6705,
    "PERSISTENT": 18365, "PETRONET": 11351, "PFC": 14299, "PGEL": 25358, "PHOENIXLTD": 14552,
    "PIDILITIND": 2664, "PIIND": 24184, "PNB": 10666, "PNBHOUSING": 18908, "POLICYBZR": 6656,
    "POLYCAB": 9590, "POWERGRID": 14977, "POWERINDIA": 18457, "PREMIERENE": 25049,
    "PRESTIGE": 20302, "RADICO": 10990, "RBLBANK": 18391, "RECLTD": 15355, "RELIANCE": 2885,
    "RVNL": 9552, "SAGILITY": 27052, "SAIL": 2963, "SBICARD": 17971, "SBILIFE": 21808,
    "SBIN": 3045, "SHREECEM": 3103, "SHRIRAMFIN": 4306, "SIEMENS": 3150, "SOLARINDS": 13332,
    "SONACOMS": 4684, "SRF": 3273, "SUNPHARMA": 3351, "SUPREMEIND": 3363, "SUZLON": 12018,
    "SWIGGY": 27066, "TATACONSUM": 3432, "TATAELXSI": 3411, "TATAPOWER": 3426,
    "TATASTEEL": 3499, "TCS": 11536, "TECHM": 13538, "TIINDIA": 312, "TITAN": 3506,
    "TMPV": 3456, "TORNTPHARM": 3518, "TRENT": 1964, "TVSMOTOR": 8479, "ULTRACEMCO": 11532,
    "UNIONBANK": 10753, "UNITDSPR": 10447, "UNOMINDA": 14154, "UPL": 11287, "VBL": 18921,
    "VEDL": 3063, "VMM": 27969, "VOLTAS": 3718, "WAAREEENER": 25907, "WIPRO": 3787,
    "YESBANK": 11915, "ZYDUSLIFE": 7929,
}

# Trading-symbol spellings that differ from the index row's ticker.
INDEX_ALIASES: dict[str, str] = {
    "SENSEX50": "SNSX50",  # BSE option symbols say SENSEX50; the index row is SNSX50
    "NIFTY 50": "NIFTY",
    "NIFTY50": "NIFTY",
    "NIFTY BANK": "BANKNIFTY",
    "NIFTYBANK": "BANKNIFTY",
    "NIFTY NEXT 50": "NIFTYNXT50",
}

# BSE-listed index underlyings — their option contracts trade on BSE_FNO.
BSE_INDEX_NAMES = {"SENSEX", "BANKEX", "SNSX50"}


class DhanError(RuntimeError):
    """A Dhan API call failed. `status` is the HTTP status (502 = network)."""

    def __init__(self, message: str, status: int, body: Any = None) -> None:
        super().__init__(message)
        self.status = status
        self.body = body


def load_env_file(path: str | os.PathLike[str]) -> int:
    """Fill unset environment variables from a KEY=VALUE file.

    Just enough .env parsing for credentials (no interpolation, no export
    keyword): blank lines and `#` comments are skipped, surrounding quotes are
    stripped, and variables already set in the real environment always win.
    Returns how many variables it set.
    """
    try:
        text = open(path, encoding="utf-8").read()
    except OSError:
        return 0
    n = 0
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip("'\"")
        if key and key not in os.environ:
            os.environ[key] = value
            n += 1
    return n


def _creds() -> tuple[str, str]:
    client_id = os.environ.get("DHAN_CLIENT_ID", "").strip()
    token = os.environ.get("DHAN_ACCESS_TOKEN", "").strip()
    if not client_id or not token:
        raise DhanError(
            "No Dhan credentials: set DHAN_CLIENT_ID and DHAN_ACCESS_TOKEN in the "
            "environment of the MCP server process.",
            401,
        )
    return client_id, token


# ---------------------------------------------------------------------------
# Rate limiting
# ---------------------------------------------------------------------------
# Dhan's buckets, as observed by the TS client:
#   - option chain / expiry list: 1 request per 3 s per UNIQUE (underlying,
#     expiry) combination — distinct combos may go concurrently.
#   - marketfeed (ltp/quote): 1 request per second.
#   - charts: a 5/s bucket; we stay gentle at 4/s.
class _Throttle:
    """Serialize calls in a class and enforce a minimum gap between them."""

    def __init__(self, min_gap_s: float) -> None:
        self._gap = min_gap_s
        self._last = 0.0
        self._lock = threading.Lock()

    def acquire(self) -> None:
        with self._lock:
            wait = self._last + self._gap - time.monotonic()
            if wait > 0:
                time.sleep(wait)
            self._last = time.monotonic()


_chain_throttles: dict[str, _Throttle] = {}
_chain_throttles_lock = threading.Lock()


def _chain_throttle(key: str) -> _Throttle:
    with _chain_throttles_lock:
        t = _chain_throttles.get(key)
        if t is None:
            if len(_chain_throttles) >= 500:  # bounded; drop the oldest
                _chain_throttles.pop(next(iter(_chain_throttles)))
            t = _Throttle(3.1)
            _chain_throttles[key] = t
        return t


_quote_throttle = _Throttle(1.1)
_data_throttle = _Throttle(0.25)

_client: httpx.Client | None = None
_client_lock = threading.Lock()


def base_url() -> str:
    """The Dhan API root (DHAN_BASE_URL overrides the v2 production host)."""
    return os.environ.get("DHAN_BASE_URL") or DEFAULT_BASE_URL


def _http() -> httpx.Client:
    global _client
    with _client_lock:
        if _client is None:
            _client = httpx.Client(base_url=base_url(), timeout=15.0)
        return _client


def _request(
    op: str,
    path: str,
    *,
    method: str = "GET",
    body: Any = None,
    timeout_s: float = 15.0,
) -> Any:
    """One Dhan call. Raises DhanError on anything but a 2xx JSON response.

    Data APIs 401 without a `client-id` header; trading endpoints ignore it —
    so it goes on every call.
    """
    client_id, token = _creds()
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "access-token": token,
        "client-id": client_id,
    }
    try:
        res = _http().request(
            method, path, headers=headers, json=body, timeout=timeout_s
        )
    except Exception as e:  # network / timeout
        raise DhanError(f"Dhan {op} failed: {e}", 502) from e
    try:
        data = res.json()
    except Exception:
        data = None
    if res.status_code >= 400:
        msg = None
        if isinstance(data, dict):
            msg = data.get("errorMessage") or data.get("message")
        raise DhanError(
            f"Dhan {op} failed: {msg or res.reason_phrase or res.status_code}",
            res.status_code,
            data,
        )
    return data


def _unwrap(payload: Any) -> Any:
    """Unwrap Dhan's {data, status} envelope used by the data APIs."""
    if isinstance(payload, dict) and "data" in payload:
        return payload["data"]
    return payload


def _zip_candles(d: Any) -> list[dict[str, Any]]:
    """Dhan chart payloads are column-oriented; zip them into rows."""
    d = d if isinstance(d, dict) else {}
    ts = d.get("timestamp") or []
    oi = d.get("open_interest") or []
    out: list[dict[str, Any]] = []
    for i, t in enumerate(ts):
        def col(name: str, default: Any = None) -> Any:
            seq = d.get(name) or []
            return seq[i] if i < len(seq) else default

        row = {
            "timestamp": int(t),
            "open": _num(col("open")),
            "high": _num(col("high")),
            "low": _num(col("low")),
            "close": _num(col("close")),
            "volume": _num(col("volume", 0)),
        }
        if oi:
            row["openInterest"] = _num(col("open_interest", 0))
        out.append(row)
    return out


def _num(v: Any) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return float("nan")


# ===========================================================================
# Everything below this line is what a submitted script sees in its namespace.
# ===========================================================================

# --- date / time helpers ---------------------------------------------------


def ymd(d: date | datetime) -> str:
    """Format a date as Dhan's YYYY-MM-DD."""
    return d.strftime("%Y-%m-%d")


def today() -> str:
    """Today in IST, as YYYY-MM-DD."""
    return ymd(datetime.now(IST))


def days_ago(n: int) -> str:
    """N calendar days before today (IST), as YYYY-MM-DD."""
    return ymd(datetime.now(IST) - timedelta(days=n))


def tomorrow() -> str:
    """Tomorrow (IST), as YYYY-MM-DD — Dhan's `toDate` is exclusive-ish."""
    return ymd(datetime.now(IST) + timedelta(days=1))


def to_ist(epoch_seconds: float) -> datetime:
    """Convert a Dhan candle timestamp (epoch seconds) to an IST datetime."""
    return datetime.fromtimestamp(float(epoch_seconds), IST)


# --- underlying resolution -------------------------------------------------


class Underlying(dict):
    """{scrip, seg, name} for an F&O underlying; also attribute-accessible."""

    def __getattr__(self, k: str) -> Any:
        try:
            return self[k]
        except KeyError as e:
            raise AttributeError(k) from e


def resolve_underlying(symbol: str) -> Underlying:
    """Look up any F&O underlying by ticker (index or NSE F&O stock).

    >>> resolve_underlying("NIFTY")
    {'scrip': 13, 'seg': 'IDX_I', 'name': 'NIFTY'}

    Raises ValueError with the checked-universe counts if the name is unknown,
    rather than guessing an id.
    """
    name = " ".join(str(symbol).strip().upper().split())
    if not name:
        raise ValueError("Empty underlying symbol.")
    idx = INDEX_ALIASES.get(name, name)
    if idx in FNO_INDICES:
        return Underlying(scrip=FNO_INDICES[idx], seg="IDX_I", name=idx)
    if name in FNO_STOCKS:
        return Underlying(scrip=FNO_STOCKS[name], seg="NSE_EQ", name=name)
    raise ValueError(
        f'"{symbol}" is not a known F&O underlying (checked {len(FNO_INDICES)} '
        f"indices and {len(FNO_STOCKS)} NSE F&O stocks). Use the exchange "
        "ticker, e.g. NIFTY, BANKNIFTY, RELIANCE, BAJAJ-AUTO."
    )


def list_underlyings(kind: Literal["all", "index", "stock"] = "all") -> list[str]:
    """Every F&O underlying ticker this server can resolve."""
    out: list[str] = []
    if kind in ("all", "index"):
        out += sorted(FNO_INDICES)
    if kind in ("all", "stock"):
        out += sorted(FNO_STOCKS)
    return out


def contract_segment(u: Underlying | str) -> str:
    """Exchange segment the underlying's OPTION contracts trade on."""
    u = resolve_underlying(u) if isinstance(u, str) else u
    return "BSE_FNO" if u["name"] in BSE_INDEX_NAMES else "NSE_FNO"


def contract_instrument(u: Underlying | str) -> str:
    """Dhan `instrument` enum for the underlying's option contracts."""
    u = resolve_underlying(u) if isinstance(u, str) else u
    return "OPTIDX" if u["seg"] == "IDX_I" else "OPTSTK"


# --- account / trading reads ----------------------------------------------


def positions() -> list[dict[str, Any]]:
    """All open positions across instruments (Dhan /positions)."""
    return _request("getPositions", "/positions") or []


def holdings() -> list[dict[str, Any]]:
    """Demat delivery holdings: quantity, average cost, ISIN, lastTradedPrice.

    Holdings carry an LTP even on accounts with no Data-API subscription —
    the fallback when marketfeed is unavailable.
    """
    return _request("getHoldings", "/holdings") or []


def funds() -> dict[str, Any]:
    """Fund limits. Dhan spells available balance `availabelBalance` (sic)."""
    return _request("getFundLimit", "/fundlimit") or {}


def orders() -> list[dict[str, Any]]:
    """Today's order book — every status: pending, traded, rejected, cancelled."""
    return _request("getOrderBook", "/orders") or []


def trades() -> list[dict[str, Any]]:
    """Today's executed trades (fills)."""
    return _request("getTradeBook", "/trades") or []


def position_for(
    security_id: str | int,
    exchange_segment: str | None = None,
    product_type: str | None = None,
) -> dict[str, Any] | None:
    """One position row by security id (optionally narrowed by segment/product).

    Falls back to the matching demat holding, since delivery holdings never
    appear in /positions unless they were traded today. Returns None when the
    instrument is neither held nor open.
    """
    sid = str(security_id)
    for p in positions():
        if str(p.get("securityId")) != sid:
            continue
        if exchange_segment and str(p.get("exchangeSegment")) != exchange_segment:
            continue
        if product_type and str(p.get("productType")) != product_type:
            continue
        return {**p, "_source": "positions", "closed": _num(p.get("netQty") or 0) == 0}
    for h in holdings():
        if str(h.get("securityId")) == sid:
            return {**h, "_source": "holdings"}
    return None


# --- market data -----------------------------------------------------------


def _seg_map(
    instruments: dict[str, Sequence[Any]] | None,
    security_id: Any,
    exchange_segment: str | None,
) -> dict[str, list[int]]:
    if instruments:
        return {seg: [int(i) for i in ids] for seg, ids in instruments.items()}
    if security_id is None or not exchange_segment:
        raise ValueError(
            "Pass either instruments={'NSE_EQ': [2885]} or "
            "security_id=... with exchange_segment=...."
        )
    ids = security_id if isinstance(security_id, (list, tuple, set)) else [security_id]
    return {exchange_segment: [int(i) for i in ids]}


def ltp(
    instruments: dict[str, Sequence[Any]] | None = None,
    *,
    security_id: Any = None,
    exchange_segment: str | None = None,
) -> dict[str, dict[str, float]]:
    """Batched last-traded prices.

        ltp({"NSE_EQ": [2885, 1333], "IDX_I": [13]})
        ltp(security_id=2885, exchange_segment="NSE_EQ")

    Returns {segment: {security_id: last_price}}. Paid Data API: accounts
    without a Data-API subscription get Dhan error 806 here (holdings() still
    carries a lastTradedPrice for equities — see ltp_of).
    """
    req = _seg_map(instruments, security_id, exchange_segment)
    _quote_throttle.acquire()
    d = _unwrap(_request("getLtp", "/marketfeed/ltp", method="POST", body=req)) or {}
    out: dict[str, dict[str, float]] = {}
    for seg, rows in d.items():
        out[seg] = {}
        for sid, row in (rows or {}).items():
            v = _num((row or {}).get("last_price"))
            if v == v:  # not NaN
                out[seg][str(sid)] = v
    return out


def ltp_of(security_id: Any, exchange_segment: str) -> float:
    """Last price for a single instrument, with the no-Data-API fallback.

    On a 806 (Data APIs not subscribed) for an equity segment, falls back to
    holdings().lastTradedPrice, which lags the live market slightly.
    """
    sid = str(int(security_id))
    try:
        return ltp(security_id=sid, exchange_segment=exchange_segment)[exchange_segment][sid]
    except DhanError as e:
        if not (is_data_api_error(e) and exchange_segment.endswith("_EQ")):
            raise
        for h in holdings():
            if str(h.get("securityId")) == sid:
                v = _num(h.get("lastTradedPrice"))
                if v == v:
                    return v
        raise
    except KeyError:
        raise DhanError(
            f"No LTP returned for {security_id} in {exchange_segment} — the feed "
            "may be closed or the instrument unsupported.",
            404,
        ) from None


def quote(
    instruments: dict[str, Sequence[Any]] | None = None,
    *,
    security_id: Any = None,
    exchange_segment: str | None = None,
) -> dict[str, dict[str, dict[str, Any]]]:
    """Batched full quotes — LTP, cumulative day volume, day OHLC, last trade time.

    Same call shapes as ltp(). Returns
    {segment: {security_id: {lastPrice, volume, dayOpen, dayHigh, dayLow,
    lastTradeTime}}}.
    """
    req = _seg_map(instruments, security_id, exchange_segment)
    _quote_throttle.acquire()
    d = _unwrap(_request("getQuote", "/marketfeed/quote", method="POST", body=req)) or {}
    out: dict[str, dict[str, dict[str, Any]]] = {}
    for seg, rows in d.items():
        out[seg] = {}
        for sid, q in (rows or {}).items():
            q = q or {}
            lp = _num(q.get("last_price"))
            if lp != lp:
                continue
            ohlc = q.get("ohlc") or {}
            out[seg][str(sid)] = {
                "lastPrice": lp,
                "volume": _num(q.get("volume") or 0),
                "dayOpen": _num(ohlc.get("open")),
                "dayHigh": _num(ohlc.get("high")),
                "dayLow": _num(ohlc.get("low")),
                "lastTradeTime": q.get("last_trade_time"),
            }
    return out


def guess_instrument(exchange_segment: str, symbol: str | None = None) -> str:
    """The Dhan chart `instrument` enum for a segment (+ trading symbol).

    NSE_EQ/BSE_EQ → EQUITY, IDX_I → INDEX, and for *_FNO the symbol decides
    OPTIDX / OPTSTK / FUTIDX / FUTSTK (options look like `NIFTY-Aug2026-24700-CE`).
    """
    seg = exchange_segment.upper()
    if seg.endswith("_EQ"):
        return "EQUITY"
    if seg == "IDX_I":
        return "INDEX"
    sym = (symbol or "").upper()
    is_option = any(f"-{x}" in sym or sym.endswith(x) for x in ("CE", "PE", "CALL", "PUT"))
    head = sym.split("-")[0] if sym else ""
    two = "-".join(sym.split("-")[:2]) if "-" in sym else ""
    name = two if (two in FNO_STOCKS or INDEX_ALIASES.get(two, two) in FNO_INDICES) else head
    is_index = INDEX_ALIASES.get(name, name) in FNO_INDICES
    if is_option:
        return "OPTIDX" if is_index else "OPTSTK"
    return "FUTIDX" if is_index else "FUTSTK"


def intraday_candles(
    security_id: Any,
    exchange_segment: str,
    instrument: str | None = None,
    interval: int = 15,
    days_back: int = 5,
    *,
    symbol: str | None = None,
    from_date: str | None = None,
    to_date: str | None = None,
    oi: bool = False,
) -> list[dict[str, Any]]:
    """Intraday OHLCV candles (plus openInterest when oi=True, F&O only).

    interval is minutes: 1, 5, 15, 25 or 60. Up to 90 days of history.
    `instrument` defaults to guess_instrument(exchange_segment, symbol).
    Each row: {timestamp (epoch s), open, high, low, close, volume[, openInterest]}.
    """
    if interval not in (1, 5, 15, 25, 60):
        raise ValueError("interval must be one of 1, 5, 15, 25, 60 (minutes).")
    _data_throttle.acquire()
    return _zip_candles(
        _request(
            "getIntradayChart",
            "/charts/intraday",
            method="POST",
            body={
                "securityId": str(security_id),
                "exchangeSegment": exchange_segment,
                "instrument": instrument or guess_instrument(exchange_segment, symbol),
                "interval": interval,
                "fromDate": from_date or days_ago(days_back),
                "toDate": to_date or tomorrow(),
                "oi": oi,
            },
        )
    )


def daily_candles(
    security_id: Any,
    exchange_segment: str,
    instrument: str | None = None,
    days_back: int = 90,
    *,
    symbol: str | None = None,
    from_date: str | None = None,
    to_date: str | None = None,
    oi: bool = False,
    expiry_code: int | None = None,
) -> list[dict[str, Any]]:
    """Daily OHLCV candles — trend and level work. Same row shape as intraday."""
    body: dict[str, Any] = {
        "securityId": str(security_id),
        "exchangeSegment": exchange_segment,
        "instrument": instrument or guess_instrument(exchange_segment, symbol),
        "fromDate": from_date or days_ago(days_back),
        "toDate": to_date or tomorrow(),
        "oi": oi,
    }
    if expiry_code is not None:
        body["expiryCode"] = expiry_code
    _data_throttle.acquire()
    return _zip_candles(_request("getHistoricalChart", "/charts/historical", method="POST", body=body))


# --- options ---------------------------------------------------------------


def expiry_list(underlying: str | Underlying) -> list[str]:
    """Available option expiries (YYYY-MM-DD, ascending) for an F&O underlying."""
    u = resolve_underlying(underlying) if isinstance(underlying, str) else underlying
    _chain_throttle(f"{u['seg']}:{u['scrip']}").acquire()
    d = _unwrap(
        _request(
            "getExpiryList",
            "/optionchain/expirylist",
            method="POST",
            body={"UnderlyingScrip": u["scrip"], "UnderlyingSeg": u["seg"]},
        )
    )
    return sorted(d) if isinstance(d, list) else []


def nearest_expiry(underlying: str | Underlying) -> str:
    """The soonest expiry that has not passed (falls back to the first listed)."""
    u = resolve_underlying(underlying) if isinstance(underlying, str) else underlying
    exps = expiry_list(u)
    if not exps:
        raise DhanError(f"Dhan returned no expiries for {u['name']}.", 404)
    t = today()
    future = [e for e in exps if e >= t]
    return future[0] if future else exps[0]


def _side(s: dict[str, Any] | None) -> dict[str, Any] | None:
    if not s:
        return None
    g = s.get("greeks") or {}
    return {
        "ltp": s.get("last_price"),
        "iv": s.get("implied_volatility"),
        "oi": s.get("oi"),
        "oiPrev": s.get("previous_oi"),
        "volume": s.get("volume"),
        "bid": s.get("top_bid_price"),
        "bidQty": s.get("top_bid_quantity"),
        "ask": s.get("top_ask_price"),
        "askQty": s.get("top_ask_quantity"),
        "avgPrice": s.get("average_price"),
        "prevClose": s.get("previous_close_price"),
        "securityId": s.get("security_id"),
        "delta": g.get("delta"),
        "theta": g.get("theta"),
        "gamma": g.get("gamma"),
        "vega": g.get("vega"),
    }


def option_chain(
    underlying: str | Underlying,
    expiry: str | None = None,
    strikes_around: int | None = 10,
) -> dict[str, Any]:
    """Option chain for any F&O underlying, trimmed to ±strikes_around of ATM.

    Per strike and side: ltp, iv, oi, oiPrev, volume, top bid/ask + quantities,
    avgPrice, prevClose, greeks (delta/theta/gamma/vega), and the contract's own
    securityId — feed that to option_candles() to study one strike.

    expiry defaults to nearest_expiry(). strikes_around=None returns every
    strike (large: a full NIFTY chain is a few hundred KB of JSON).

    Rate limit: one call per (underlying, expiry) per 3 s, enforced here by
    sleeping — don't loop over dozens of expiries in one script.

    Returns {underlying, expiry, underlyingLastPrice, strikes: [{strike, ce, pe}]}.
    """
    u = resolve_underlying(underlying) if isinstance(underlying, str) else underlying
    exp = expiry or nearest_expiry(u)
    _chain_throttle(f"{u['seg']}:{u['scrip']}:{exp}").acquire()
    d = _unwrap(
        _request(
            "getOptionChain",
            "/optionchain",
            method="POST",
            body={"UnderlyingScrip": u["scrip"], "UnderlyingSeg": u["seg"], "Expiry": exp},
        )
    )
    oc = (d or {}).get("oc") if isinstance(d, dict) else None
    if not oc:
        raise DhanError("Dhan getOptionChain failed: no chain in response", 502, d)
    spot = _num(d.get("last_price") or 0)

    strikes = sorted(float(k) for k in oc if _num(k) == _num(k))
    if strikes_around is not None and strikes:
        atm = min(range(len(strikes)), key=lambda i: abs(strikes[i] - spot))
        lo = max(0, atm - strikes_around)
        hi = min(len(strikes) - 1, atm + strikes_around)
        strikes = strikes[lo : hi + 1]

    rows = []
    for k in strikes:
        row = oc.get(f"{k:.6f}") or oc.get(str(k)) or {}
        rows.append({"strike": k, "ce": _side(row.get("ce")), "pe": _side(row.get("pe"))})
    return {
        "underlying": u["name"],
        "expiry": exp,
        "underlyingLastPrice": spot,
        "strikes": rows,
    }


def option_candles(
    security_id: Any,
    underlying: str | Underlying,
    interval: int = 15,
    days_back: int = 5,
    *,
    from_date: str | None = None,
    to_date: str | None = None,
) -> list[dict[str, Any]]:
    """Intraday OHLCV + open-interest candles for ONE option contract.

    `security_id` is the per-contract securityId from an option_chain() row;
    `underlying` decides the exchange (NSE_FNO vs BSE_FNO) and instrument type.
    """
    u = resolve_underlying(underlying) if isinstance(underlying, str) else underlying
    return intraday_candles(
        security_id,
        contract_segment(u),
        contract_instrument(u),
        interval,
        days_back,
        from_date=from_date,
        to_date=to_date,
        oi=True,
    )


def expired_options(
    underlying: str | Underlying,
    option_type: Literal["CALL", "PUT"],
    from_date: str,
    to_date: str,
    *,
    strike: str = "ATM",
    expiry_flag: Literal["WEEK", "MONTH"] = "WEEK",
    expiry_code: int = 1,
    interval: int = 60,
    fields: Iterable[str] = ("close", "iv", "oi", "strike", "spot"),
) -> list[dict[str, Any]]:
    """History of EXPIRED contracts (Dhan rolling-option data).

    Addresses contracts by ATM±N notation instead of securityIds, rolling
    across past expiries — for "how did IV behave into last expiry" questions.
    `strike` is 'ATM' or 'ATM+N'/'ATM-N' (indices ±10, stocks ±3). expiry_code
    starts at 1 (nearest expiry of that series at each point in time); 0 is
    rejected by Dhan. `to_date` is non-inclusive.

    SLOW: 11-18 s even for a 2-day window, and Dhan's gateway 504s near 30 s.
    Windows are capped at 7 days here — chunk longer ranges across calls.
    Un-requested `fields` come back as empty arrays, so ask for what you need.
    """
    u = resolve_underlying(underlying) if isinstance(underlying, str) else underlying
    span = (date.fromisoformat(to_date) - date.fromisoformat(from_date)).days
    if span <= 0:
        raise ValueError("to_date must be after from_date.")
    if span > 7:
        raise ValueError(
            "Window too large — the endpoint times out beyond ~7 days. "
            "Chunk the range across calls."
        )
    _data_throttle.acquire()
    d = _unwrap(
        _request(
            "getExpiredOptionData",
            "/charts/rollingoption",
            method="POST",
            body={
                "exchangeSegment": contract_segment(u),
                "securityId": str(u["scrip"]),
                "instrument": contract_instrument(u),
                "expiryCode": expiry_code,
                "expiryFlag": expiry_flag,
                "drvOptionType": option_type,
                "strike": strike,
                "interval": interval,
                "requiredData": list(fields),
                "fromDate": from_date,
                "toDate": to_date,
            },
            timeout_s=60.0,  # 11-18 s even for small windows
        )
    ) or {}
    side = d.get("pe") if option_type == "PUT" else d.get("ce")
    side = side or d.get("ce") or d.get("pe") or {}
    ts = side.get("timestamp") or []
    keys = [k for k in side if k != "timestamp"]
    bars = []
    for i, t in enumerate(ts):
        bar: dict[str, Any] = {"timestamp": int(t)}
        for k in keys:
            seq = side.get(k) or []
            v = _num(seq[i]) if i < len(seq) else float("nan")
            if v == v:
                bar[k] = v
        bars.append(bar)
    return bars


# --- escape hatch ----------------------------------------------------------


def dhan_get(path: str, timeout_s: float = 15.0) -> Any:
    """Raw GET against any other Dhan v2 endpoint (path starts with '/')."""
    return _request("dhan_get", path, timeout_s=timeout_s)


def dhan_post(path: str, body: Any = None, timeout_s: float = 15.0) -> Any:
    """Raw POST against any other Dhan v2 READ endpoint.

    Deliberately not a write path: this server exposes no order placement,
    modification or cancellation, and posting to those endpoints is not the
    intent here.
    """
    return _request("dhan_post", path, method="POST", body=body, timeout_s=timeout_s)


def is_data_api_error(e: BaseException) -> bool:
    """True for Dhan error 806 — 'Data APIs not Subscribed'.

    A 401 from a paid data endpoint is NOT a dead token: trading reads
    (positions, holdings, funds, orders, trades) keep working on such accounts.
    """
    if not isinstance(e, DhanError):
        return False
    raw = f"{e} {json.dumps(e.body, default=str) if e.body is not None else ''}"
    return "806" in raw or "not subscribed" in raw.lower()


def is_auth_error(e: BaseException) -> bool:
    """True for a genuine token rejection (401/403 that is not error 806)."""
    return isinstance(e, DhanError) and e.status in (401, 403) and not is_data_api_error(e)


# --- indicator math --------------------------------------------------------
# Pure-Python, no third-party deps. Every series is aligned to the input:
# same length, leading `None`s until the indicator has warmed up — the same
# contract as lib/indicators.ts on the TypeScript side. Feed CLOSED candles.

Series = list[float | None]


def closes(candles: Sequence[dict[str, Any]], field: str = "close") -> list[float]:
    """Pull one column out of a candle list."""
    return [_num(c.get(field)) for c in candles]


def sma(values: Sequence[float], period: int) -> Series:
    """Simple moving average."""
    out: Series = [None] * len(values)
    if period <= 0:
        raise ValueError("period must be positive")
    total = 0.0
    for i, v in enumerate(values):
        total += v
        if i >= period:
            total -= values[i - period]
        if i >= period - 1:
            out[i] = total / period
    return out


def ema(values: Sequence[float], period: int) -> Series:
    """Exponential moving average, seeded with the first `period` SMA."""
    out: Series = [None] * len(values)
    if len(values) < period or period <= 0:
        return out
    k = 2.0 / (period + 1)
    prev = sum(values[:period]) / period
    out[period - 1] = prev
    for i in range(period, len(values)):
        prev = values[i] * k + prev * (1 - k)
        out[i] = prev
    return out


def rsi(values: Sequence[float], period: int = 14) -> Series:
    """Relative strength index (Wilder smoothing)."""
    out: Series = [None] * len(values)
    if len(values) <= period:
        return out
    gains = losses = 0.0
    for i in range(1, period + 1):
        d = values[i] - values[i - 1]
        gains += max(d, 0.0)
        losses += max(-d, 0.0)
    avg_g, avg_l = gains / period, losses / period
    out[period] = 100.0 if avg_l == 0 else 100 - 100 / (1 + avg_g / avg_l)
    for i in range(period + 1, len(values)):
        d = values[i] - values[i - 1]
        avg_g = (avg_g * (period - 1) + max(d, 0.0)) / period
        avg_l = (avg_l * (period - 1) + max(-d, 0.0)) / period
        out[i] = 100.0 if avg_l == 0 else 100 - 100 / (1 + avg_g / avg_l)
    return out


def macd(
    values: Sequence[float], fast: int = 12, slow: int = 26, signal: int = 9
) -> dict[str, Series]:
    """MACD line, signal line and histogram, all aligned to `values`."""
    f, s = ema(values, fast), ema(values, slow)
    line: Series = [
        (f[i] - s[i]) if (f[i] is not None and s[i] is not None) else None
        for i in range(len(values))
    ]
    start = next((i for i, v in enumerate(line) if v is not None), len(values))
    sig_dense = ema([v for v in line[start:] if v is not None], signal)
    sig: Series = [None] * len(values)
    for j, v in enumerate(sig_dense):
        sig[start + j] = v
    hist: Series = [
        (line[i] - sig[i]) if (line[i] is not None and sig[i] is not None) else None
        for i in range(len(values))
    ]
    return {"macd": line, "signal": sig, "histogram": hist}


def bollinger(
    values: Sequence[float], period: int = 20, stddev: float = 2.0
) -> dict[str, Series]:
    """Bollinger bands: {upper, middle, lower} (population standard deviation)."""
    mid = sma(values, period)
    up: Series = [None] * len(values)
    lo: Series = [None] * len(values)
    for i in range(len(values)):
        m = mid[i]
        if m is None:
            continue
        window = values[i - period + 1 : i + 1]
        var = sum((v - m) ** 2 for v in window) / period
        sd = var**0.5
        up[i], lo[i] = m + stddev * sd, m - stddev * sd
    return {"upper": up, "middle": mid, "lower": lo}


def atr(candles: Sequence[dict[str, Any]], period: int = 14) -> Series:
    """Average true range (Wilder) over candle dicts with high/low/close."""
    n = len(candles)
    out: Series = [None] * n
    if n <= period:
        return out
    tr: list[float] = [_num(candles[0].get("high")) - _num(candles[0].get("low"))]
    for i in range(1, n):
        h, l = _num(candles[i].get("high")), _num(candles[i].get("low"))
        pc = _num(candles[i - 1].get("close"))
        tr.append(max(h - l, abs(h - pc), abs(l - pc)))
    prev = sum(tr[1 : period + 1]) / period
    out[period] = prev
    for i in range(period + 1, n):
        prev = (prev * (period - 1) + tr[i]) / period
        out[i] = prev
    return out


def vwap(candles: Sequence[dict[str, Any]]) -> Series:
    """Running VWAP over typical price. Reset per session yourself if needed."""
    out: Series = [None] * len(candles)
    pv = vol = 0.0
    for i, c in enumerate(candles):
        v = _num(c.get("volume") or 0)
        tp = (_num(c.get("high")) + _num(c.get("low")) + _num(c.get("close"))) / 3
        pv += tp * v
        vol += v
        out[i] = (pv / vol) if vol else None
    return out


def pct_change(values: Sequence[float]) -> Series:
    """Bar-over-bar percentage change (first element is None)."""
    out: Series = [None] * len(values)
    for i in range(1, len(values)):
        prev = values[i - 1]
        out[i] = ((values[i] - prev) / prev * 100) if prev else None
    return out


# ===========================================================================
# Execution engine
# ===========================================================================

# Names exposed to submitted scripts, and the order they are documented in.
_API_NAMES = [
    # account
    "positions", "holdings", "funds", "orders", "trades", "position_for",
    # market data
    "ltp", "ltp_of", "quote", "intraday_candles", "daily_candles",
    # options
    "expiry_list", "nearest_expiry", "option_chain", "option_candles",
    "expired_options",
    # instruments
    "resolve_underlying", "list_underlyings", "contract_segment",
    "contract_instrument", "guess_instrument", "FNO_INDICES", "FNO_STOCKS",
    # indicators
    "closes", "sma", "ema", "rsi", "macd", "bollinger", "atr", "vwap",
    "pct_change",
    # dates
    "today", "days_ago", "tomorrow", "ymd", "to_ist", "IST",
    # errors + escape hatch
    "DhanError", "is_data_api_error", "is_auth_error", "dhan_get", "dhan_post",
]


def help_api() -> str:
    """One line per callable in the namespace — the in-script cheat sheet."""
    g = globals()
    lines = []
    for name in _API_NAMES:
        obj = g.get(name)
        if callable(obj) and obj.__doc__:
            lines.append(f"{name}: {obj.__doc__.strip().splitlines()[0]}")
        elif not callable(obj):
            lines.append(f"{name}: (data)")
    return "\n".join(lines)


def pp(value: Any, limit: int | None = None) -> None:
    """Print any value as indented JSON (falls back to repr for odd types)."""
    if limit is not None and isinstance(value, list):
        value = value[:limit]
    try:
        print(json.dumps(value, indent=2, default=str))
    except Exception:
        print(repr(value))


def _namespace() -> dict[str, Any]:
    import math
    import statistics

    g = globals()
    ns: dict[str, Any] = {name: g[name] for name in _API_NAMES if name in g}
    ns.update(
        {
            "__name__": "__dhan_script__",
            "__builtins__": __builtins__,
            "help_api": help_api,
            "pp": pp,
            "json": json,
            "math": math,
            "statistics": statistics,
            "datetime": datetime,
            "timedelta": timedelta,
            "date": date,
            "timezone": timezone,
        }
    )
    return ns


def _run_code(code: str) -> str:
    """Execute `code`, returning everything it printed.

    A trailing bare expression is echoed the way a REPL would, so a script can
    end in `df_like_summary` instead of wrapping it in print().
    """
    buf = io.StringIO()
    ns = _namespace()
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return "SyntaxError in submitted code:\n" + traceback.format_exc(limit=0)

    tail: ast.Expression | None = None
    if tree.body and isinstance(tree.body[-1], ast.Expr):
        tail = ast.Expression(body=tree.body.pop().value)  # type: ignore[union-attr]

    with redirect_stdout(buf), redirect_stderr(buf):
        try:
            exec(compile(tree, "<submitted>", "exec"), ns)  # noqa: S102
            if tail is not None:
                value = eval(compile(tail, "<submitted>", "eval"), ns)  # noqa: S307
                if value is not None:
                    pp(value)
        except BaseException:  # noqa: BLE001 — report, never crash the server
            buf.write("\n" + _format_exception())
    return buf.getvalue()


def _format_exception() -> str:
    """Traceback with this file's frames stripped — only the script's own."""
    exc_type, exc, tb = sys.exc_info()
    frames = [f for f in traceback.extract_tb(tb) if f.filename == "<submitted>"]
    head = ""
    if frames:
        head = "Traceback (most recent call last):\n" + "".join(traceback.format_list(frames))
    return head + "".join(traceback.format_exception_only(exc_type, exc)).strip()


class ScriptTimeout(Exception):
    """Injected into a script's thread when it overruns EXEC_TIMEOUT_S."""


def _run_with_timeout(code: str, timeout_s: float) -> str:
    """Run the script on a worker thread and interrupt it if it overruns.

    Python cannot hard-kill a thread; the async exception lands at the next
    bytecode boundary, which is enough for a script stuck in a loop or waiting
    on a socket. Output produced before the interrupt still comes back.
    """
    result: dict[str, str] = {}

    def target() -> None:
        result["out"] = _run_code(code)

    worker = threading.Thread(target=target, daemon=True, name="dhan-script")
    worker.start()
    worker.join(timeout_s)
    if worker.is_alive():
        ident = worker.ident
        if ident is not None:
            ctypes.pythonapi.PyThreadState_SetAsyncExc(
                ctypes.c_ulong(ident), ctypes.py_object(ScriptTimeout)
            )
        worker.join(5)
        partial = result.get("out", "")
        return (
            (partial + "\n" if partial else "")
            + f"[timed out after {timeout_s:g}s — the script was interrupted. "
            "Fetch less data per call, or split the work across several calls.]"
        )
    return result.get("out", "")


def execute(code: str) -> str:
    """Run a submitted script and return its output, capped and never raising."""
    out = _run_with_timeout(code, EXEC_TIMEOUT_S)
    if len(out) > MAX_OUTPUT_CHARS:
        keep = MAX_OUTPUT_CHARS // 2
        out = (
            out[:keep]
            + f"\n\n[... {len(out) - MAX_OUTPUT_CHARS} characters elided; "
            "aggregate in the script instead of printing raw rows ...]\n\n"
            + out[-keep:]
        )
    return out or "(the script produced no output — print() what you want back)"


# ===========================================================================
# MCP server — one tool
# ===========================================================================

TOOL_DESCRIPTION = """\
Run a Python script against the user's live Dhan account and return whatever it
printed.

This is the ONLY tool: there is no per-endpoint tool. Write a script that fetches
what you need, does the arithmetic in Python, and prints a small, already-analysed
result. Printing raw candle arrays or a whole option chain wastes the round trip —
aggregate first.

The script runs with the Dhan read API preloaded as plain functions, e.g.:

    positions(), holdings(), funds(), orders(), trades()
    ltp_of(security_id, "NSE_EQ"), quote({"IDX_I": [13]})
    intraday_candles(sid, "NSE_EQ", interval=5, days_back=3)
    daily_candles(sid, "NSE_EQ", days_back=180)
    option_chain("NIFTY"), expiry_list("BANKNIFTY"), nearest_expiry("NIFTY")
    option_candles(contract_security_id, "NIFTY")
    expired_options("NIFTY", "CALL", from_date, to_date)
    resolve_underlying("RELIANCE") -> {"scrip": ..., "seg": ..., "name": ...}
    sma/ema/rsi/macd/bollinger/atr/vwap/pct_change over candle series
    today(), days_ago(n), to_ist(timestamp), pp(value)

Call `print(help_api())` for the full one-line-per-function listing. The
accompanying SKILL.md documents every signature, return shape and Dhan quirk.

Notes: stdout is what comes back (a trailing bare expression is echoed too);
exceptions come back as a traceback rather than failing the tool; scripts are
interrupted after a timeout; Dhan rate limits are enforced inside the functions
by sleeping, so a loop over many option chains will be slow; everything here is
READ-ONLY — there is no way to place, modify, or cancel an order.\
"""


def build_server():  # pragma: no cover - thin wiring
    """Construct the server against whichever Python MCP SDK is installed.

    SDK 2.x renamed FastMCP to MCPServer; the decorator and run() signatures
    we use are the same in both, so one import shim covers it.
    """
    try:
        from mcp.server.mcpserver import MCPServer as _Server  # mcp >= 2
    except ModuleNotFoundError:  # pragma: no cover - mcp 1.x
        from mcp.server.fastmcp import FastMCP as _Server  # type: ignore[assignment]

    server = _Server("dhan-data")

    @server.tool(name="run_python", description=TOOL_DESCRIPTION)
    def run_python(code: str) -> str:
        return execute(code)

    return server


def _self_check() -> int:
    """Exercise credentials and a couple of reads without an MCP client."""
    print(f"base url : {base_url()}")
    try:
        cid, _ = _creds()
        print(f"client id: {cid}")
    except DhanError as e:
        print(f"FAIL: {e}")
        return 1
    print(f"universe : {len(FNO_INDICES)} indices, {len(FNO_STOCKS)} F&O stocks")
    print("--- funds() ---")
    print(execute("pp(funds())").strip()[:600])
    print("--- positions() count ---")
    print(execute("print(len(positions()), 'open positions')").strip()[:600])
    print("--- ltp_of(NIFTY index) ---")
    print(execute('print(ltp_of(13, "IDX_I"))').strip()[:600])
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="dhan_mcp",
        description="MCP server exposing the Dhan read API through one run_python tool.",
    )
    parser.add_argument(
        "--http",
        action="store_true",
        help="serve over streamable HTTP instead of stdio",
    )
    parser.add_argument("--host", default="127.0.0.1", help="bind host for --http")
    parser.add_argument("--port", type=int, default=8931, help="bind port for --http")
    parser.add_argument(
        "--check",
        action="store_true",
        help="run a credential/API smoke test and exit (no MCP client needed)",
    )
    parser.add_argument(
        "--env-file",
        help="KEY=VALUE file to load credentials from "
        "(default: .env beside this file or in its parent directory)",
    )
    parser.add_argument(
        "--exec",
        metavar="CODE",
        help="run one script locally and print the result (debugging aid)",
    )
    args = parser.parse_args(argv)

    here = os.path.dirname(os.path.abspath(__file__))
    for candidate in (
        [args.env_file]
        if args.env_file
        else [os.path.join(here, ".env"), os.path.join(here, os.pardir, ".env")]
    ):
        if candidate and load_env_file(candidate):
            break

    if args.check:
        return _self_check()
    if args.exec is not None:
        code = sys.stdin.read() if args.exec == "-" else args.exec
        print(execute(code))
        return 0

    server = build_server()
    if args.http:
        print(f"dhan-data MCP on http://{args.host}:{args.port}/mcp", file=sys.stderr)
        try:
            server.run(transport="streamable-http", host=args.host, port=args.port)
        except TypeError:  # mcp 1.x takes host/port off settings instead
            server.settings.host = args.host
            server.settings.port = args.port
            server.run(transport="streamable-http")
    else:
        server.run(transport="stdio")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
