"""Engine-level e2e for the per-market sweep gate, schema migration and script
spacing in mcp/watchers.py. Stub host (no OAuth, no Neon, no network): the
sweeper's dependencies on dhan_mcp_oauth are replaced by a tiny object.
Run: cd zap-claude-mcp && uv run python ../zap-eve-agent/mcp/tests/e2e_watchers_markets.py
"""
from __future__ import annotations

import os
import sqlite3
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone

TESTDIR = os.path.dirname(os.path.abspath(__file__))
MCPDIR = os.path.dirname(TESTDIR)
sys.path.insert(0, MCPDIR)
DB = os.path.join(tempfile.mkdtemp(prefix="w-markets-"), "watchers.sqlite3")
os.environ["DHAN_MCP_WATCHERS_DB"] = DB
os.environ["WATCHERS_JWT_SECRET"] = "x" * 32
os.environ["WATCHERS_SCRIPT_GAP_S"] = "0.3"

import watchers as W  # noqa: E402

IST = timezone(timedelta(hours=5, minutes=30))
passed = failed = 0
RUNS: list[str] = []


def check(name, ok, detail=""):
    global passed, failed
    passed += ok
    failed += not ok
    print(("✓ " if ok else "✗ ") + name + ("" if ok else f"  -- {str(detail)[:300]}"))


class Host:
    BROKER_MESSAGES = {"not_connected": "nc {app}", "token_expired": "te {app}", "disconnected": "d {app}", "error": "e"}

    def get_active_broker_creds(self, user_id):
        return {"status": "ok", "dhanClientId": "1", "accessToken": "t"}

    def run_script_as(self, script, cid, tok):
        RUNS.append(script)
        return '{"met": false, "value": 1}'

    def probe_token(self, cid, tok):
        return True

    def mark_token_expired(self, uid):
        pass

    def user_email(self, uid):
        return "u@x"

    def app_url(self):
        return "https://app"


def ist(s):
    return datetime.strptime(s, "%Y-%m-%d %H:%M").replace(tzinfo=IST)


def insert(wid, market, script="print('{\"met\": false}')", user="u1"):
    now = int(time.time())
    W._sql().execute(
        "INSERT INTO watchers (id, user_id, email, symbol, label, script, check_every_s, status, baseline_done, latched,"
        " expires_at, created_at, updated_at, market) VALUES (?, ?, 'u@x', 'S', 'L', ?, 60, 'ARMED', 1, 0, ?, ?, ?, ?)",
        (wid, user, script, now + 86400, now, now, market),
    )
    W._sql().commit()


def main() -> int:
    W.H = Host()
    W.send_email = lambda *a, **k: True

    # ---- hours + inference -------------------------------------------------
    check("NSE closed / MCX open on a Monday evening", not W.is_market_open("NSE", ist("2026-09-28 20:00")) and W.is_market_open("MCX", ist("2026-09-28 20:00")))
    check("both open mid-day", W.is_market_open("NSE", ist("2026-09-28 10:00")) and W.is_market_open("MCX", ist("2026-09-28 10:00")))
    check("MCX open at 09:05, NSE not yet", W.is_market_open("MCX", ist("2026-09-28 09:05")) and not W.is_market_open("NSE", ist("2026-09-28 09:05")))
    check("Saturday closed everywhere", not W.is_market_open("MCX", ist("2026-09-26 12:00")) and not W.is_market_open("NSE", ist("2026-09-26 12:00")))
    check("is_nse_open still the NSE window", W.is_nse_open(ist("2026-09-28 15:30")) and not W.is_nse_open(ist("2026-09-28 15:31")))
    check("infer: MCX_COMM in script → MCX", W.infer_market("v = ltp_of(483079, 'MCX_COMM')") == "MCX")
    check("infer: plain script → NSE", W.infer_market("v = ltp_of(2885, 'NSE_EQ')") == "NSE")
    check("infer: explicit wins", W.infer_market("ltp_of(1,'MCX_COMM')", "nse") == "NSE" and W.infer_market("x", "MCX") == "MCX" and W.infer_market("x", "auto") == "NSE")
    try:
        W.infer_market("x", "NYMEX")
        check("infer: bad market rejected", False)
    except ValueError as e:
        check("infer: bad market rejected", "NSE, MCX" in str(e), e)

    # ---- migration: an OLD-schema db gains the market column with default NSE --
    old = sqlite3.connect(DB)
    old.execute("CREATE TABLE watchers (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, email TEXT NOT NULL, symbol TEXT NOT NULL,"
                " label TEXT NOT NULL, script TEXT NOT NULL, check_every_s INTEGER NOT NULL, status TEXT NOT NULL, status_reason TEXT,"
                " baseline_done INTEGER NOT NULL DEFAULT 0, latched INTEGER NOT NULL DEFAULT 0, last_met INTEGER, last_value TEXT,"
                " last_detail TEXT, last_error TEXT, error_count INTEGER NOT NULL DEFAULT 0, last_checked_at INTEGER, last_fired_at INTEGER,"
                " fired_count INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)")
    now = int(time.time())
    old.execute("INSERT INTO watchers (id, user_id, email, symbol, label, script, check_every_s, status, baseline_done, expires_at, created_at, updated_at)"
                " VALUES ('legacy', 'u1', 'u@x', 'NIFTY', 'old row', 'print(1)', 60, 'ARMED', 1, ?, ?, ?)", (now + 86400, now, now))
    old.execute("INSERT INTO watchers (id, user_id, email, symbol, label, script, check_every_s, status, baseline_done, expires_at, created_at, updated_at)"
                " VALUES ('legacy-gold', 'u1', 'u@x', 'GOLD-04DEC2026-FUT', 'pre-migration MCX watcher', 'v = ltp_of(495213, \"MCX_COMM\")', 60, 'PAUSED', 1, ?, ?, ?)", (now + 86400, now, now))
    old.commit()
    old.close()
    cols = {r[1] for r in W._sql().execute("PRAGMA table_info(watchers)")}
    check("migration adds market column", "market" in cols, cols)
    check("legacy row defaults to NSE", W._sql().execute("SELECT market FROM watchers WHERE id='legacy'").fetchone()[0] == "NSE")
    check("legacy MCX_COMM row backfilled to MCX (the live gold watcher case)", W._sql().execute("SELECT market FROM watchers WHERE id='legacy-gold'").fetchone()[0] == "MCX")

    # ---- sweep gate per market ---------------------------------------------
    insert("mcx1", "MCX", "print('{\"met\": false}') # MCX_COMM")
    insert("mcx2", "MCX", "print('{\"met\": false}') # MCX_COMM 2", user="u2")

    W.is_market_open = lambda m, now=None: m == "MCX"      # evening: only MCX
    RUNS.clear()
    r = W.sweep()
    check("evening tick: only MCX watchers checked", r["checked"] == 2 and r["marketsOpen"] == ["MCX"] and r["marketOpen"] is True, r)
    check("legacy NSE row untouched in the evening", W._sql().execute("SELECT last_checked_at FROM watchers WHERE id='legacy'").fetchone()[0] is None)

    W.is_market_open = lambda m, now=None: False           # night
    r = W.sweep()
    check("night tick: nothing runs, marketOpen False", r["checked"] == 0 and r["marketOpen"] is False and r["marketsOpen"] == [], r)

    W.is_market_open = lambda m, now=None: True            # mid-day: everyone due again
    W._sql().execute("UPDATE watchers SET last_checked_at = NULL")
    W._sql().commit()
    RUNS.clear()
    t0 = time.monotonic()
    r = W.sweep()
    el = time.monotonic() - t0
    check("mid-day tick: all 3 checked", r["checked"] == 3 and r["marketsOpen"] == ["MCX", "NSE"], r)
    check("script spacing across users (3 runs ≥ 2 gaps of 0.3 s)", el >= 0.6, f"{el:.2f}s")

    W.is_market_open = lambda m, now=None: False
    W._sql().execute("UPDATE watchers SET last_checked_at = NULL")
    W._sql().commit()
    r = W.sweep(force=True)
    check("force bypasses the market gate (tests / off-hours smoke)", r["checked"] == 3, r)

    print(f"\n{passed} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
