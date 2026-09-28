"""Instrument master for dhan_mcp.py — Dhan's detailed scrip-master CSV cached as
SQLite (refreshed daily) + symbol/underlying resolution across EVERY segment
Dhan's API serves: NSE_EQ, BSE_EQ, IDX_I, NSE_FNO, BSE_FNO, MCX_COMM.

Segments Dhan cannot serve are dropped at ingest: currency derivatives (no
live contracts exist any more) and NSE's commodity segment (no API enum).

SYNC NOTE: this file is a copy of zap-claude-mcp/src/zapdhan/instruments.py
with the env-var prefix renamed (DHAN_MCP_ → DHAN_MCP_) and the cache under
~/.dhan-mcp/cache. Keep the two in sync (same rule as the PWA theme files).

Env: DHAN_MCP_CACHE_DIR (default ~/.dhan-mcp/cache) · DHAN_MCP_SCRIP_MASTER_URL
(tests) · DHAN_MCP_TODAY (test clock for live/expired filtering).
"""
from __future__ import annotations

import csv
import json
import os
import sqlite3
import time
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import httpx

SCRIP_MASTER_URL = "https://images.dhan.co/api-data/api-scrip-master-detailed.csv"
MAX_AGE_SECONDS = 24 * 3600
SCHEMA_VERSION = 3  # bump when columns/ingest rules change → cached DB is rebuilt
IST = ZoneInfo("Asia/Kolkata")

# (EXCH_ID, SEGMENT) → Dhan API exchangeSegment. Only segments Dhan's data/trading APIs serve.
SEGMENT_MAP = {
    ("NSE", "E"): "NSE_EQ",
    ("NSE", "D"): "NSE_FNO",
    ("NSE", "I"): "IDX_I",
    ("BSE", "E"): "BSE_EQ",
    ("BSE", "D"): "BSE_FNO",
    ("BSE", "I"): "IDX_I",
    ("MCX", "M"): "MCX_COMM",
}
SUPPORTED_SEGMENTS = tuple(sorted(set(SEGMENT_MAP.values())))
# Known Dhan segment names we deliberately do NOT serve (D12) → clear error instead of empty data.
DROPPED_SEGMENTS = {
    "NSE_CURRENCY": "currency derivatives have no live contracts on Dhan any more",
    "BSE_CURRENCY": "currency derivatives have no live contracts on Dhan any more",
    "NSE_COMM": "NSE commodity derivatives are not served by Dhan's API (use MCX_COMM)",
}
DERIVATIVE_INSTRUMENTS = ("OPTIDX", "OPTSTK", "OPTFUT", "FUTIDX", "FUTSTK", "FUTCOM")

# Human names → the ticker the master uses in UNDERLYING_SYMBOL.
_ALIASES = {
    "NIFTY 50": "NIFTY", "NIFTY50": "NIFTY", "NIFTY-50": "NIFTY",
    "NIFTY BANK": "BANKNIFTY", "BANK NIFTY": "BANKNIFTY", "NIFTYBANK": "BANKNIFTY",
    "NIFTY FIN SERVICE": "FINNIFTY", "NIFTY FINANCIAL SERVICES": "FINNIFTY", "FIN NIFTY": "FINNIFTY",
    "NIFTY MIDCAP SELECT": "MIDCPNIFTY", "MIDCAP NIFTY": "MIDCPNIFTY", "NIFTY MID SELECT": "MIDCPNIFTY",
    "NIFTY NEXT 50": "NIFTYNXT50", "NIFTY NXT 50": "NIFTYNXT50", "NIFTYNEXT50": "NIFTYNXT50",
    "SENSEX50": "SNSX50", "SENSEX 50": "SNSX50", "BSE SENSEX 50": "SNSX50",
    "BSE SENSEX": "SENSEX", "BSE BANKEX": "BANKEX",
    "MCX GOLD": "GOLD", "MCX SILVER": "SILVER", "MCX CRUDE": "CRUDEOIL", "CRUDE": "CRUDEOIL", "CRUDE OIL": "CRUDEOIL",
    "NATURAL GAS": "NATURALGAS", "NAT GAS": "NATURALGAS",
}

_COLUMNS = [
    "exch_id", "segment", "security_id", "isin", "instrument", "underlying_security_id",
    "underlying_symbol", "symbol_name", "display_name", "instrument_type", "series",
    "lot_size", "expiry_date", "strike_price", "option_type", "tick_size", "expiry_flag",
    "exchange_segment",
]
_CSV_TO_COL = {
    "EXCH_ID": "exch_id", "SEGMENT": "segment", "SECURITY_ID": "security_id", "ISIN": "isin",
    "INSTRUMENT": "instrument", "UNDERLYING_SECURITY_ID": "underlying_security_id",
    "UNDERLYING_SYMBOL": "underlying_symbol", "SYMBOL_NAME": "symbol_name",
    "DISPLAY_NAME": "display_name", "INSTRUMENT_TYPE": "instrument_type", "SERIES": "series",
    "LOT_SIZE": "lot_size", "SM_EXPIRY_DATE": "expiry_date", "STRIKE_PRICE": "strike_price",
    "OPTION_TYPE": "option_type", "TICK_SIZE": "tick_size", "EXPIRY_FLAG": "expiry_flag",
}


def cache_dir() -> Path:
    p = Path(os.environ.get("DHAN_MCP_CACHE_DIR") or "~/.dhan-mcp/cache").expanduser()
    p.mkdir(parents=True, exist_ok=True)
    return p


def _db_path() -> Path:
    return cache_dir() / "instruments.sqlite"


def _csv_path() -> Path:
    return cache_dir() / "api-scrip-master-detailed.csv"


def _fresh(p: Path) -> bool:
    return p.exists() and (time.time() - p.stat().st_mtime) < MAX_AGE_SECONDS


def _download_csv(dest: Path) -> None:
    url = os.environ.get("DHAN_MCP_SCRIP_MASTER_URL") or SCRIP_MASTER_URL
    tmp = dest.with_suffix(".csv.part")
    with httpx.stream("GET", url, timeout=120.0, follow_redirects=True) as r:
        r.raise_for_status()
        with tmp.open("wb") as f:
            for chunk in r.iter_bytes():
                f.write(chunk)
    tmp.replace(dest)


def _norm_expiry(v: str) -> str:
    """'' for non-expiring rows (equity '', 'NA'; index rows carry '0001-01-01')."""
    v = (v or "").strip()
    return "" if v in ("", "NA") or v.startswith("0001") else v[:10]


def _build_db(csv_path: Path, db_path: Path) -> None:
    tmp = db_path.with_suffix(".sqlite.part")
    if tmp.exists():
        tmp.unlink()
    con = sqlite3.connect(tmp)
    con.execute(f"CREATE TABLE instruments ({', '.join(c + ' TEXT' for c in _COLUMNS)})")
    con.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)")
    skipped: dict[str, int] = {}
    kept = 0
    with csv_path.open(newline="", encoding="utf-8", errors="replace") as f:
        reader = csv.DictReader(f)
        rows = []
        for rec in reader:
            row = {col: (rec.get(csv_col) or "").strip() for csv_col, col in _CSV_TO_COL.items()}
            seg = SEGMENT_MAP.get((row["exch_id"].upper(), row["segment"].upper()))
            if not seg:  # D12: segments Dhan cannot serve are not stored
                k = f"{row['exch_id']}:{row['segment']}"
                skipped[k] = skipped.get(k, 0) + 1
                continue
            row["exchange_segment"] = seg
            row["expiry_date"] = _norm_expiry(row["expiry_date"])
            row["underlying_symbol"] = row["underlying_symbol"].upper()
            rows.append(tuple(row[c] for c in _COLUMNS))
            kept += 1
            if len(rows) >= 5000:
                con.executemany(f"INSERT INTO instruments VALUES ({','.join('?' * len(_COLUMNS))})", rows)
                rows = []
        if rows:
            con.executemany(f"INSERT INTO instruments VALUES ({','.join('?' * len(_COLUMNS))})", rows)
    con.execute("CREATE INDEX ix_sec ON instruments(security_id, exchange_segment)")
    con.execute("CREATE INDEX ix_und ON instruments(underlying_symbol, instrument, exchange_segment)")
    con.execute("CREATE INDEX ix_sym ON instruments(symbol_name)")
    con.execute("CREATE INDEX ix_disp ON instruments(display_name)")
    con.executemany(
        "INSERT INTO meta VALUES (?, ?)",
        [
            ("schema_version", str(SCHEMA_VERSION)),
            ("built_at", datetime.now(IST).strftime("%Y-%m-%d %H:%M:%S")),
            ("rows", str(kept)),
            ("skipped", json.dumps(skipped, sort_keys=True)),
            ("source", os.environ.get("DHAN_MCP_SCRIP_MASTER_URL") or SCRIP_MASTER_URL),
        ],
    )
    con.commit()
    con.close()
    tmp.replace(db_path)


def _db_schema_version(db: Path) -> int:
    try:
        con = sqlite3.connect(db)
        try:
            r = con.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
            return int(r[0]) if r else 0
        finally:
            con.close()
    except sqlite3.Error:
        return 0


def ensure_master(force: bool = False) -> sqlite3.Connection:
    """Return a connection to the cached instrument master, (re)downloading it if older than 24 h
    and rebuilding the SQLite when the ingest schema changed."""
    db, csv_path = _db_path(), _csv_path()
    if force or not _fresh(csv_path):
        _download_csv(csv_path)
        _build_db(csv_path, db)
    elif not db.exists() or _db_schema_version(db) != SCHEMA_VERSION:
        _build_db(csv_path, db)
    con = sqlite3.connect(db)
    con.row_factory = sqlite3.Row
    return con


def master_status() -> dict:
    """Instrument-master cache info: {schema_version, built_at, rows, skipped, segments}."""
    con = ensure_master()
    try:
        meta = {r["key"]: r["value"] for r in con.execute("SELECT key, value FROM meta")}
    finally:
        con.close()
    return {
        "schema_version": int(meta.get("schema_version", 0)),
        "built_at": meta.get("built_at"),
        "rows": int(meta.get("rows", 0)),
        "skipped": json.loads(meta.get("skipped") or "{}"),
        "segments": list(SUPPORTED_SEGMENTS),
    }


# ---- row shaping ----------------------------------------------------------------

_KIND = {
    "EQUITY": "equity", "INDEX": "index", "FUTCOM": "commodity_future", "FUTIDX": "index_future",
    "FUTSTK": "stock_future", "OPTIDX": "index_option", "OPTSTK": "stock_option", "OPTFUT": "commodity_option",
}


def _row(r: sqlite3.Row) -> dict:
    d = dict(r)
    inst = d["instrument"]
    out = {
        "security_id": d["security_id"],
        "exchange_segment": d["exchange_segment"],
        "symbol": d["underlying_symbol"] or d["symbol_name"],
        "display_name": d["display_name"],
        "symbol_name": d["symbol_name"],
        "instrument": inst,
        "kind": _KIND.get(inst, inst.lower()),
        "instrument_type": d["instrument_type"],
        "series": d["series"] or None,
        "isin": d["isin"] if d["isin"] and d["isin"] != "NA" else None,
        "lot_size": _num(d["lot_size"]),
        "tick_size": _num(d["tick_size"]),
    }
    if inst in DERIVATIVE_INSTRUMENTS:
        out["expiry_date"] = d["expiry_date"] or None
        out["strike_price"] = _num(d["strike_price"]) if inst.startswith("OPT") else None
        out["option_type"] = d["option_type"] if inst.startswith("OPT") else None
        out["underlying_symbol"] = d["underlying_symbol"]
        out["underlying_security_id"] = d["underlying_security_id"] or None
    return out


def _num(v: str | None):
    try:
        return float(v) if v not in (None, "", "NA") else None
    except ValueError:
        return None


def _today() -> str:
    return os.environ.get("DHAN_MCP_TODAY") or datetime.now(IST).strftime("%Y-%m-%d")  # env override = test clock


def _live_sql(include_expired: bool) -> tuple[str, list]:
    if include_expired:
        return "", []
    return " AND (expiry_date = '' OR expiry_date >= ?)", [_today()]


def canonical(raw: str) -> str:
    """Normalise a user-typed name to the master's ticker (aliases: 'Nifty 50'→NIFTY, 'Bank Nifty'→BANKNIFTY, 'Crude'→CRUDEOIL…)."""
    name = " ".join((raw or "").strip().upper().split())
    return _ALIASES.get(name, name)


def check_segment(exchange_segment: str) -> str:
    """Upper-cased segment, or ValueError for segments Dhan cannot serve (D12) / unknown names."""
    seg = (exchange_segment or "").strip().upper()
    if seg in DROPPED_SEGMENTS:
        raise ValueError(f"{seg} is not available on Dhan: {DROPPED_SEGMENTS[seg]}. Supported segments: {', '.join(SUPPORTED_SEGMENTS)}.")
    if seg not in SUPPORTED_SEGMENTS:
        raise ValueError(f"Unknown exchange_segment {exchange_segment!r}. Supported: {', '.join(SUPPORTED_SEGMENTS)}.")
    return seg


# ---- resolution -----------------------------------------------------------------

_KIND_FILTER = {
    "equity": "instrument = 'EQUITY'",
    "index": "instrument = 'INDEX'",
    "commodity": "instrument = 'FUTCOM'",
    "future": "instrument IN ('FUTSTK','FUTIDX','FUTCOM')",
}


def resolve_symbol(symbol: str, exchange_segment: str | None = None, kind: str | None = None) -> dict | None:
    """Resolve ONE ticker to the instrument to quote/chart — "TCS"→NSE share (NSE_EQ), "NIFTY"/"SENSEX"→index (IDX_I), "GOLD"/"CRUDEOIL"/"SILVER"→nearest live MCX future (MCX_COMM). Ranking: index > listed share (NSE, then BSE) > commodity future > index/stock future > ETF/bond; steer with exchange_segment and/or kind (equity|index|commodity|future). Returns {security_id, exchange_segment, symbol, display_name, instrument, kind, isin, lot_size, tick_size, expiry_date (futures)…} or None. Options: use find_option_contracts / get_option_chain."""
    name = canonical(symbol)
    if not name:
        return None
    if kind and kind not in _KIND_FILTER:
        raise ValueError(f"kind must be one of {sorted(_KIND_FILTER)} (options: use find_option_contracts).")
    q = "SELECT * FROM instruments WHERE (upper(underlying_symbol) = ? OR upper(display_name) = ?)"
    args: list = [name, name]
    if exchange_segment:
        q += " AND exchange_segment = ?"
        args.append(check_segment(exchange_segment))
    if kind:
        q += f" AND {_KIND_FILTER[kind]}"
    else:
        q += " AND instrument IN ('INDEX','EQUITY','FUTCOM','FUTIDX','FUTSTK')"
    live, largs = _live_sql(False)
    q += live
    args += largs
    q += """ ORDER BY
        CASE WHEN instrument = 'INDEX' THEN 0 WHEN instrument = 'EQUITY' AND instrument_type = 'ES' THEN 1 WHEN instrument = 'FUTCOM' THEN 2
             WHEN instrument = 'FUTIDX' THEN 3 WHEN instrument = 'FUTSTK' THEN 4 WHEN instrument = 'EQUITY' THEN 5 ELSE 9 END,
        (upper(underlying_symbol) = ?) DESC,
        (exchange_segment IN ('NSE_EQ','NSE_FNO')) DESC,
        (series = 'EQ') DESC, (instrument_type = 'ES') DESC,
        CASE WHEN expiry_date = '' THEN '9999' ELSE expiry_date END,
        CAST(security_id AS INTEGER)
      LIMIT 1"""
    args.append(name)
    con = ensure_master()
    try:
        r = con.execute(q, args).fetchone()
    finally:
        con.close()
    return _row(r) if r else None


def search_instruments(
    query: str,
    exchange_segment: str | None = None,
    instrument: str | None = None,
    limit: int = 20,
    include_expired: bool = False,
) -> list[dict]:
    """Substring search over the master (ticker, display name) when resolve_symbol is not enough; filter by exchange_segment and/or instrument (EQUITY, INDEX, FUTSTK, FUTIDX, FUTCOM, OPTSTK, OPTIDX, OPTFUT). Expired contracts hidden unless include_expired. Returns ≤limit rows shaped like resolve_symbol (+ expiry_date/strike_price/option_type for derivatives)."""
    raw = (query or "").strip().upper()
    name = canonical(raw)
    like = f"%{raw}%"
    q = "SELECT * FROM instruments WHERE (upper(underlying_symbol) LIKE ? OR upper(display_name) LIKE ? OR upper(symbol_name) LIKE ? OR upper(underlying_symbol) = ?)"
    args: list = [like, like, like, name]
    if exchange_segment:
        q += " AND exchange_segment = ?"
        args.append(check_segment(exchange_segment))
    if instrument:
        q += " AND instrument = ?"
        args.append(instrument.upper())
    live, largs = _live_sql(include_expired)
    q += live
    args += largs
    q += """ ORDER BY (upper(underlying_symbol) = ?) DESC, (upper(underlying_symbol) = ?) DESC,
        length(display_name), CASE WHEN expiry_date = '' THEN '9999' ELSE expiry_date END,
        CAST(strike_price AS REAL) LIMIT ?"""
    args += [name, raw, int(limit)]
    con = ensure_master()
    try:
        rows = [_row(r) for r in con.execute(q, args).fetchall()]
    finally:
        con.close()
    return rows


def find_option_contracts(
    underlying: str,
    expiry_date: str | None = None,
    option_type: str | None = None,
    strike_price: float | None = None,
    limit: int = 50,
    exchange: str | None = None,
    include_expired: bool = False,
) -> list[dict]:
    """Option contracts of an underlying (index, NSE/BSE stock or MCX commodity) from the master — no Dhan call: filter by expiry_date YYYY-MM-DD, option_type CE/PE, strike_price, exchange NSE|BSE|MCX. Rows carry security_id, exchange_segment, expiry_date, strike_price, option_type, lot_size."""
    try:
        u = resolve_underlying(underlying, exchange)
    except ValueError:
        if not include_expired:
            return []
        u = None
    names = _names(canonical(underlying))
    q = f"SELECT * FROM instruments WHERE instrument IN ('OPTIDX','OPTSTK','OPTFUT') AND upper(underlying_symbol) IN ({','.join('?' * len(names))})"
    args: list = [*names]
    if u:
        q += " AND exchange_segment = ?"
        args.append(u["contract_segment"])
    if expiry_date:
        q += " AND expiry_date = ?"
        args.append(expiry_date)
    if option_type:
        q += " AND upper(option_type) = ?"
        args.append(option_type.upper())
    if strike_price is not None:
        q += " AND abs(CAST(strike_price AS REAL) - ?) < 0.001"
        args.append(float(strike_price))
    live, largs = _live_sql(include_expired)
    q += live
    args += largs
    q += " ORDER BY expiry_date, CAST(strike_price AS REAL), option_type LIMIT ?"
    args.append(int(limit))
    con = ensure_master()
    try:
        rows = [_row(r) for r in con.execute(q, args).fetchall()]
    finally:
        con.close()
    return rows


def instrument_for(security_id: int | str, exchange_segment: str) -> str:
    """Chart `instrument` enum for a security (EQUITY/INDEX/FUTCOM/OPTFUT/OPTIDX/…) from the master; falls back to EQUITY for *_EQ and INDEX for IDX_I."""
    seg = check_segment(exchange_segment)
    con = ensure_master()
    try:
        r = con.execute(
            "SELECT instrument FROM instruments WHERE security_id = ? AND exchange_segment = ? LIMIT 1",
            [str(security_id), seg],
        ).fetchone()
    finally:
        con.close()
    if r and r["instrument"]:
        return r["instrument"]
    if seg.endswith("_EQ"):
        return "EQUITY"
    if seg == "IDX_I":
        return "INDEX"
    raise ValueError(
        f"Cannot derive the chart instrument for security_id={security_id} on {seg}: not in the scrip master. Pass instrument= explicitly (OPTIDX/OPTSTK/FUTIDX/FUTSTK/FUTCOM/OPTFUT)."
    )


_EXCHANGE_TO_SEGMENT = {"NSE": "NSE_FNO", "BSE": "BSE_FNO", "MCX": "MCX_COMM"}
_SEGMENT_PREFERENCE = ("NSE_FNO", "BSE_FNO", "MCX_COMM")
_underlying_cache: dict[tuple[str, str | None, str], dict] = {}


def _names(name: str) -> list[str]:
    """The canonical ticker plus every alias that maps to it — the master is inconsistent (index row SNSX50, its options SENSEX50)."""
    out = [name] + [k for k, v in _ALIASES.items() if v == name and k != name]
    return out


def _option_listings(con: sqlite3.Connection, name: str, include_expired: bool = False) -> list[sqlite3.Row]:
    live, largs = _live_sql(include_expired)
    names = _names(name)
    return con.execute(
        "SELECT exchange_segment, instrument, underlying_security_id, count(*) AS n, min(expiry_date) AS nearest "
        f"FROM instruments WHERE instrument IN ('OPTIDX','OPTSTK','OPTFUT') AND upper(underlying_symbol) IN ({','.join('?' * len(names))})" + live +
        " GROUP BY exchange_segment, instrument ORDER BY n DESC",
        [*names, *largs],
    ).fetchall()


def _index_id(con: sqlite3.Connection, name: str, exchange: str) -> str | None:
    names = _names(name)
    ph = ",".join("?" * len(names))
    r = con.execute(
        f"SELECT security_id FROM instruments WHERE instrument = 'INDEX' AND exch_id = ? AND (upper(underlying_symbol) IN ({ph}) OR upper(display_name) IN ({ph})) LIMIT 1",
        [exchange, *names, *names],
    ).fetchone()
    return r["security_id"] if r else None


def resolve_underlying(underlying: str, exchange: str | None = None) -> dict:
    """What Dhan's option APIs need for an underlying (any index, NSE/BSE F&O stock or MCX commodity), from the master: {name, scrip, seg, exchange, contract_segment, contract_instrument, kind index|stock|commodity, nearest_expiry}; exchange NSE|BSE|MCX picks the listing (default NSE, else BSE, else MCX). ValueError if no options are listed."""
    name = canonical(underlying)
    if not name:
        raise ValueError("Empty underlying symbol.")
    ex = (exchange or "").strip().upper() or None
    if ex and ex not in _EXCHANGE_TO_SEGMENT:
        raise ValueError(f"exchange must be one of {sorted(_EXCHANGE_TO_SEGMENT)}.")
    key = (name, ex, _today())
    if key in _underlying_cache:
        return dict(_underlying_cache[key])
    con = ensure_master()
    try:
        listings = _option_listings(con, name)
        by_seg = {r["exchange_segment"]: r for r in listings}
        if not by_seg:
            hint = ""
            if resolve_symbol(name):
                hint = " It exists in the master but has no live option contracts."
            raise ValueError(f'"{underlying}" is not an option underlying on NSE, BSE or MCX.{hint} Use the exchange ticker, e.g. NIFTY, BANKNIFTY, SENSEX, RELIANCE, BAJAJ-AUTO, GOLD, CRUDEOIL.')
        if ex:
            seg = _EXCHANGE_TO_SEGMENT[ex]
            if seg not in by_seg:
                have = [k for k, v in _EXCHANGE_TO_SEGMENT.items() if v in by_seg]
                raise ValueError(f"{name} has no options on {ex}; listed on {', '.join(have)}.")
        else:
            seg = next(s for s in _SEGMENT_PREFERENCE if s in by_seg)
        row = by_seg[seg]
        inst = row["instrument"]
        exch = next(k for k, v in _EXCHANGE_TO_SEGMENT.items() if v == seg)
        if seg == "MCX_COMM":
            scrip, useg, kind = row["underlying_security_id"], "MCX_COMM", ("index" if inst == "OPTIDX" else "commodity")
        elif inst == "OPTIDX":
            idx = _index_id(con, name, exch)
            if not idx:
                raise ValueError(f"{name} options are listed on {exch} but the master has no IDX_I index row for it, so Dhan's option-chain APIs cannot be addressed. Use find_option_contracts / get_ltp on the contracts instead.")
            scrip, useg, kind = idx, "IDX_I", "index"
        else:
            scrip, useg, kind = row["underlying_security_id"], f"{exch}_EQ", "stock"
        if not scrip:
            raise ValueError(f"{name}: the master carries no underlying id for its {inst} contracts on {seg}.")
        out = {
            "name": name, "scrip": int(scrip), "seg": useg, "exchange": exch,
            "contract_segment": seg, "contract_instrument": inst, "kind": kind, "nearest_expiry": row["nearest"] or None,
        }
    finally:
        con.close()
    if len(_underlying_cache) > 500:
        _underlying_cache.clear()
    _underlying_cache[key] = out
    return dict(out)


def contract_info(security_id: int | str, exchange_segment: str | None = None) -> dict | None:
    """Master row for a derivative contract id → {exchange_segment, instrument, underlying_symbol, expiry_date, strike_price, option_type…}; None if unknown. Raises if the id exists on several segments and none is given."""
    q = "SELECT * FROM instruments WHERE security_id = ? AND instrument IN ('OPTIDX','OPTSTK','OPTFUT','FUTIDX','FUTSTK','FUTCOM')"
    args: list = [str(security_id)]
    if exchange_segment:
        q += " AND exchange_segment = ?"
        args.append(check_segment(exchange_segment))
    con = ensure_master()
    try:
        rows = con.execute(q, args).fetchall()
    finally:
        con.close()
    if not rows:
        return None
    segs = {r["exchange_segment"] for r in rows}
    if len(segs) > 1:
        raise ValueError(f"security_id {security_id} exists on {sorted(segs)} — pass exchange_segment (or underlying) to disambiguate.")
    return _row(rows[0])
