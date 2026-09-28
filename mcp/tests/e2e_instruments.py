"""e2e for the all-instruments port in dhan_mcp.py (+ mcp/instruments.py):
every script runs through the REAL `dhan_mcp.py --exec -` subprocess (the
same path run_python and the watcher sweeper use) against a fake Dhan that
records calls + serves a tiny scrip master. No network, no Neon.
Run: cd zap-claude-mcp && uv run python ../zap-eve-agent/mcp/tests/e2e_instruments.py
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import httpx

TESTDIR = os.path.dirname(os.path.abspath(__file__))
MCPDIR = os.path.dirname(TESTDIR)
PORT = 8992
CALLS: list[dict] = []
LOCK = threading.Lock()
CSV = open(os.path.join(TESTDIR, "fixture_scrip_master.csv")).read()
CHAIN_OK = {(13, "IDX_I"), (25, "IDX_I"), (51, "IDX_I"), (83, "IDX_I"), (850, "IDX_I"),
            (2885, "NSE_EQ"), (500325, "BSE_EQ"), (114, "MCX_COMM"), (294, "MCX_COMM"), (568, "MCX_COMM")}

passed = failed = 0


def check(name, ok, detail=""):
    global passed, failed
    passed += ok
    failed += not ok
    print(("✓ " if ok else "✗ ") + name + ("" if ok else f"  -- {str(detail)[:300]}"))


class Fake(BaseHTTPRequestHandler):
    def _send(self, code, payload, ctype="application/json"):
        data = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/scrip-master.csv":
            return self._send(200, CSV.encode(), "text/csv")
        if self.path == "/_calls":
            with LOCK:
                return self._send(200, CALLS)
        if self.path == "/_reset":
            with LOCK:
                CALLS.clear()
            return self._send(200, {"ok": True})
        return self._handle(None)

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(n) or b"null") if n else None
        return self._handle(body)

    def _handle(self, body):
        path = self.path
        with LOCK:
            CALLS.append({"path": path, "body": body})
        if path == "/fundlimit":
            return self._send(200, {"availabelBalance": 100.0})
        if path == "/marketfeed/ltp":
            return self._send(200, {"data": {seg: {str(i): {"last_price": 100.0 + i % 7} for i in ids} for seg, ids in (body or {}).items()}, "status": "success"})
        if path in ("/charts/intraday", "/charts/historical"):
            ts = [1757475900, 1757476800]
            d = {"timestamp": ts, "open": [1, 2], "high": [2, 3], "low": [1, 1], "close": [1.5, 2.5], "volume": [10, 20]}
            if (body or {}).get("oi"):
                d["open_interest"] = [5, 6]
            return self._send(200, d)
        if path in ("/optionchain/expirylist", "/optionchain"):
            key = (int((body or {}).get("UnderlyingScrip", -1)), (body or {}).get("UnderlyingSeg"))
            if key not in CHAIN_OK:
                return self._send(400, {"data": {"813": "Invalid SecurityId"}, "status": "failure"})
            if path.endswith("expirylist"):
                return self._send(200, {"data": ["2026-10-30", "2026-09-25"], "status": "success"})
            oc = {f"{k:.6f}": {"ce": {"last_price": 1, "oi": 10, "security_id": 580000 + k // 100}, "pe": {"last_price": 2, "oi": 20, "security_id": 590000 + k // 100}} for k in range(8700, 9100, 50)}
            return self._send(200, {"data": {"last_price": 8861, "oc": oc}, "status": "success"})
        if path == "/charts/rollingoption":
            return self._send(200, {"data": {"ce": {"timestamp": [1757475900], "close": [1.0], "iv": [20.0]}, "pe": {"timestamp": [1757475900], "close": [2.0], "iv": [21.0]}}, "status": "success"})
        return self._send(404, {"errorMessage": f"no fake for {path}"})

    def log_message(self, *a):
        pass


def run(code: str, env_extra: dict | None = None) -> str:
    env = {
        "PATH": os.environ["PATH"], "HOME": os.environ.get("HOME", "/tmp"),
        "DHAN_CLIENT_ID": "1000000001", "DHAN_ACCESS_TOKEN": "tok", "DHAN_BASE_URL": f"http://127.0.0.1:{PORT}",
        "DHAN_MCP_SCRIP_MASTER_URL": f"http://127.0.0.1:{PORT}/scrip-master.csv",
        "DHAN_MCP_CACHE_DIR": CACHE, "DHAN_MCP_TODAY": "2026-09-10",
    }
    env.update(env_extra or {})
    p = subprocess.run([sys.executable, os.path.join(MCPDIR, "dhan_mcp.py"), "--exec", "-", "--env-file", os.devnull],
                       input=code, env=env, capture_output=True, text=True, timeout=120)
    return (p.stdout + p.stderr).strip()


def calls():
    return httpx.get(f"http://127.0.0.1:{PORT}/_calls").json()


def reset():
    httpx.get(f"http://127.0.0.1:{PORT}/_reset")


def last(path):
    c = [x for x in calls() if x["path"] == path]
    return c[-1]["body"] if c else None


CACHE = tempfile.mkdtemp(prefix="dhan-mcp-cache-")


def main() -> int:
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Fake)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        # ---- byte-identical behaviour for the built-in universe --------------
        out = run("print(json.dumps(dict(resolve_underlying('NIFTY')))); print(json.dumps(dict(resolve_underlying('RELIANCE'))))")
        a, b = out.splitlines()[:2]
        check("resolve_underlying NIFTY unchanged", json.loads(a) == {"scrip": 13, "seg": "IDX_I", "name": "NIFTY"}, out)
        check("resolve_underlying RELIANCE unchanged", json.loads(b) == {"scrip": 2885, "seg": "NSE_EQ", "name": "RELIANCE"}, out)
        out = run("print(guess_instrument('NSE_FNO', 'NIFTY-Sep2026-24700-CE'), guess_instrument('NSE_FNO', 'RELIANCE-Sep2026-FUT'), guess_instrument('NSE_EQ'), guess_instrument('IDX_I'))")
        check("guess_instrument NSE unchanged", out == "OPTIDX FUTSTK EQUITY INDEX", out)
        reset()
        run("intraday_candles(2885, 'NSE_EQ', interval=15, days_back=1); daily_candles(13, 'IDX_I', days_back=5); option_candles(45623, 'NIFTY')")
        c = [x["body"] for x in calls() if x["path"].startswith("/charts")]
        check("equity/index candles: EQUITY/INDEX, oi False (as before)", [(x["instrument"], x["oi"]) for x in c[:2]] == [("EQUITY", False), ("INDEX", False)], c)
        check("option_candles(id, 'NIFTY') unchanged → NSE_FNO OPTIDX oi", (c[2]["exchangeSegment"], c[2]["instrument"], c[2]["oi"]) == ("NSE_FNO", "OPTIDX", True), c)
        reset()
        run("expired_options('NIFTY', 'CALL', '2026-09-01', '2026-09-05')")
        check("expired_options NIFTY still WEEK / NSE_FNO / OPTIDX", {k: last("/charts/rollingoption")[k] for k in ("expiryFlag", "exchangeSegment", "instrument")} == {"expiryFlag": "WEEK", "exchangeSegment": "NSE_FNO", "instrument": "OPTIDX"}, last("/charts/rollingoption"))
        out = run("try:\n    resolve_underlying('FOOBAR')\nexcept ValueError as e:\n    print('VE', str(e)[:60])")
        check("unknown underlying still a clear ValueError", out.startswith("VE") and "FOOBAR" in out, out)

        # ---- new: resolve_symbol across segments ------------------------------
        out = run("""for n, kw in [('GOLD', {}), ('SILVER', {}), ('crude', {}), ('NIFTY', {}), ('Bank Nifty', {}), ('TCS', {}), ('RELIANCE', {'exchange_segment': 'BSE_EQ'}), ('SILVER', {'kind': 'equity'}), ('USDINR', {}), ('NOPE', {})]:
    r = resolve_symbol(n, **kw)
    print(n, '|', r and (r['security_id'], r['exchange_segment'], r['kind']))""")
        want = {"GOLD": "('483079', 'MCX_COMM', 'commodity_future')", "SILVER": "('470100', 'MCX_COMM', 'commodity_future')",
                "crude": "('569900', 'MCX_COMM', 'commodity_future')", "NIFTY": "('13', 'IDX_I', 'index')", "Bank Nifty": "('25', 'IDX_I', 'index')",
                "TCS": "('11536', 'NSE_EQ', 'equity')", "RELIANCE": "('500325', 'BSE_EQ', 'equity')", "USDINR": "None", "NOPE": "None"}
        lines = [ln.split(" | ") for ln in out.splitlines() if " | " in ln]
        got = {k: v for k, v in lines[:7]}  # first 7 are the plain lookups (SILVER recurs later with kind=equity)
        got.update({"USDINR": lines[8][1], "NOPE": lines[9][1]})
        for k, v in want.items():
            check(f"resolve_symbol {k}", got.get(k) == v, got.get(k))
        check("resolve_symbol SILVER kind=equity → ETF", "NSE_EQ" in out.splitlines()[7], out)

        # ---- new: MCX / BSE instrument typing + OI -----------------------------
        out = run("print(guess_instrument('MCX_COMM', 'GOLD-Oct2026-FUT'), guess_instrument('MCX_COMM', 'CRUDEOIL-Oct2026-8850-CE'), guess_instrument('MCX_COMM', 'MCXBULLDEX-Oct2026-FUT'), instrument_for(483079, 'MCX_COMM'), instrument_for(580006, 'MCX_COMM'))")
        check("guess_instrument MCX: FUTCOM / OPTFUT / FUTIDX + master lookup", out == "FUTCOM OPTFUT FUTIDX FUTCOM OPTFUT", out)
        reset()
        run("intraday_candles(483079, 'MCX_COMM', interval=60, days_back=1)\ndaily_candles(1141132, 'BSE_FNO', days_back=5)\nintraday_candles(483079, 'MCX_COMM', oi=False)")
        c = [x["body"] for x in calls() if x["path"].startswith("/charts")]
        check("MCX future candles: FUTCOM from master, OI on", (c[0]["instrument"], c[0]["oi"]) == ("FUTCOM", True), c)
        check("BSE stock option daily: OPTSTK, OI on", (c[1]["instrument"], c[1]["oi"]) == ("OPTSTK", True), c)
        check("explicit oi=False still wins", c[2]["oi"] is False, c)
        out = run("c = intraday_candles(483079, 'MCX_COMM', interval=60, days_back=1); print('openInterest' in c[-1], len(c))")
        check("MCX candle rows carry openInterest", out == "True 2", out)

        # ---- new: options on MCX / BSE ---------------------------------------
        reset()
        out = run("print(expiry_list('GOLD')); print(nearest_expiry('CRUDEOIL'))")
        el = [x["body"] for x in calls() if x["path"] == "/optionchain/expirylist"]
        check("expiry_list GOLD → 114/MCX_COMM, nearest_expiry CRUDEOIL → 294/MCX_COMM", el == [{"UnderlyingScrip": 114, "UnderlyingSeg": "MCX_COMM"}, {"UnderlyingScrip": 294, "UnderlyingSeg": "MCX_COMM"}] and "2026-09-25" in out, (el, out))
        reset()
        out = run("ch = option_chain('CRUDEOIL', strikes_around=2); print(ch['underlying'], len(ch['strikes']), ch['strikes'][2]['ce']['securityId'])")
        check("option_chain CRUDEOIL → 294/MCX_COMM, trimmed ±2", last("/optionchain")["UnderlyingScrip"] == 294 and last("/optionchain")["UnderlyingSeg"] == "MCX_COMM" and out.startswith("CRUDEOIL 5"), (last("/optionchain"), out))
        reset()
        run("u = resolve_underlying('RELIANCE', exchange='BSE'); option_chain(u, expiry='2026-10-30', strikes_around=1)")
        check("RELIANCE on BSE → 500325/BSE_EQ", last("/optionchain") == {"UnderlyingScrip": 500325, "UnderlyingSeg": "BSE_EQ", "Expiry": "2026-10-30"}, last("/optionchain"))
        reset()
        run("option_candles(580006)\noption_candles(1141132)")
        c = [x["body"] for x in calls() if x["path"] == "/charts/intraday"]
        check("option_candles(id) w/o underlying: MCX_COMM/OPTFUT then BSE_FNO/OPTSTK", [(x["exchangeSegment"], x["instrument"], x["oi"]) for x in c] == [("MCX_COMM", "OPTFUT", True), ("BSE_FNO", "OPTSTK", True)], c)
        out = run("try:\n    option_candles(2885)\nexcept ValueError as e:\n    print('VE', str(e)[:50])")
        check("option_candles on a non-option id → ValueError", out.startswith("VE"), out)
        reset()
        run("expired_options('GOLD', 'CALL', '2026-09-01', '2026-09-05')\nexpired_options('RELIANCE', 'PUT', '2026-09-01', '2026-09-05')")
        r = [x["body"] for x in calls() if x["path"] == "/charts/rollingoption"]
        check("expired_options GOLD → MCX_COMM OPTFUT 114 MONTH", (r[0]["exchangeSegment"], r[0]["instrument"], r[0]["securityId"], r[0]["expiryFlag"]) == ("MCX_COMM", "OPTFUT", "114", "MONTH"), r[0])
        check("expired_options RELIANCE (built-in) keeps WEEK default", r[1]["expiryFlag"] == "WEEK" and r[1]["instrument"] == "OPTSTK", r[1])
        out = run("print([ (x['security_id'], x['strike_price']) for x in find_option_contracts('GOLD', option_type='CE')])")
        check("find_option_contracts GOLD CE", "580006" in out and "116500" in out, out)

        # ---- new: unserved segments + market_status ---------------------------
        reset()
        out = run("for fn in (lambda: ltp({'NSE_CURRENCY': [1]}), lambda: ltp_of(1, 'BSE_CURRENCY'), lambda: intraday_candles(1, 'NSE_COMM')):\n    try:\n        fn(); print('no error')\n    except ValueError as e:\n        print('VE', str(e)[:40])")
        check("currency / NSE_COMM rejected before HTTP", out.count("VE") == 3 and not [x for x in calls() if x["path"] != "/scrip-master.csv"], (out, calls()))
        out = run("m = market_status('2026-09-28 20:00'); print(m['nse_bse']['open'], m['mcx']['open'], m['open']); m = market_status('2026-09-26 12:00'); print(m['open'])")
        check("market_status: Monday 20:00 → NSE closed, MCX open; Saturday closed", out == "False True True\nFalse", out)
        out = run("print(help_api())")
        check("help_api lists the new functions", all(f"{n}:" in out for n in ("resolve_symbol", "search_instruments", "find_option_contracts", "market_status", "instrument_for")), out[:300])
        out = run("print(ltp({'MCX_COMM': [483079]}))")
        check("ltp on MCX_COMM passes through", "483079" in out, out)
    finally:
        srv.shutdown()
    print(f"\n{passed} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
