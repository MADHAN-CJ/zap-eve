"""P1 e2e for mcp/watchers.py — engine units + full server matrix.
Fake Dhan (togglable), fake Resend (capture + failure injection), REAL Neon
(test@zaptrade.app + a temporary encrypted broker row, deleted at the end).
Run: cd zap-claude-mcp && uv run --with 'psycopg[binary]' --with cryptography python <this>
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
import sqlite3
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import tempfile
import httpx

HERE = tempfile.gettempdir()  # scratch sqlite files
MCPDIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(MCPDIR)
FAKE_DHAN, FAKE_RESEND, PORT = 8986, 8987, 8988
ISSUER = f"http://127.0.0.1:{PORT}"
OAUTH_DB = os.path.join(HERE, "w-oauth.sqlite3")
WATCH_DB = os.path.join(HERE, "w-watchers.sqlite3")
GOOD = "good-token-12345678"
REDIRECT = "https://claude.ai/api/mcp/auth_callback"
SWEEP_SECRET = "sweep-secret-for-e2e-0123456789"
JWT_SECRET = "jwt-secret-for-e2e-0123456789abc"

passed = failed = 0


def check(name, ok, detail=""):
    global passed, failed
    if ok:
        passed += 1
        print(f"  ok  {name}")
    else:
        failed += 1
        print(f"FAIL  {name}  {str(detail)[:300]}")


# --- fakes -----------------------------------------------------------------

DHAN_STATE = {"balance": 500.0, "mode": "ok"}
SENT: list[dict] = []
RESEND_FAIL = {"n": 0}


class FakeDhan(BaseHTTPRequestHandler):
    def _handle(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n) if n else b""
        if self.path == "/_control":
            DHAN_STATE.update(json.loads(body))
            return self._json(200, {"ok": True})
        if DHAN_STATE["mode"] == "deadtoken" or self.headers.get("access-token") != GOOD:
            return self._json(401, {"errorCode": "DH-901", "errorMessage": "Invalid token"})
        return self._json(200, {"availabelBalance": DHAN_STATE["balance"]})

    def _json(self, code, obj):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    do_GET = do_POST = _handle

    def log_message(self, *a):
        pass


class FakeResend(BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(n) or b"{}")
        if self.path == "/_fail":
            RESEND_FAIL["n"] = int(body.get("n", 1))
            return FakeDhan._json(self, 200, {"ok": True})
        if RESEND_FAIL["n"] > 0:
            RESEND_FAIL["n"] -= 1
            return FakeDhan._json(self, 500, {"error": "injected"})
        SENT.append({"to": body.get("to"), "subject": body.get("subject")})
        return FakeDhan._json(self, 200, {"id": "fake"})

    def log_message(self, *a):
        pass


# --- helpers ---------------------------------------------------------------


class Mcp:
    def __init__(self, base, token):
        self.url, self.h, self.sid, self.n, self.token = base + "/mcp", httpx.Client(timeout=120.0), None, 0, token

    def rpc(self, method, params=None, notify=False):
        self.n += 1
        msg = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            msg["params"] = params
        if not notify:
            msg["id"] = self.n
        headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream",
                   "Authorization": f"Bearer {self.token}"}
        if self.sid:
            headers["mcp-session-id"] = self.sid
        r = self.h.post(self.url, json=msg, headers=headers)
        if "mcp-session-id" in r.headers:
            self.sid = r.headers["mcp-session-id"]
        if notify:
            return None
        for line in r.text.splitlines():
            if line.startswith("data: "):
                d = json.loads(line[6:])
                if d.get("id") == self.n:
                    return d
        raise RuntimeError(f"no rpc response: {r.status_code} {r.text[:200]}")

    def start(self):
        self.rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "e2e", "version": "0"}})
        self.rpc("notifications/initialized", {}, notify=True)

    def tool(self, name, args=None):
        d = self.rpc("tools/call", {"name": name, "arguments": args or {}})
        if "error" in d:
            raise RuntimeError(d["error"])
        return "".join(c.get("text", "") for c in d["result"].get("content", []))


def oauth_login(h: httpx.Client):
    """Full connector flow as test@zaptrade.app; returns (access_token, connector_cookie)."""
    meta = h.get(f"{ISSUER}/.well-known/oauth-authorization-server").json()
    client = h.post(meta["registration_endpoint"], json={
        "redirect_uris": [REDIRECT], "token_endpoint_auth_method": "none",
        "grant_types": ["authorization_code", "refresh_token"], "response_types": ["code"],
        "client_name": "watchers-e2e", "scope": "dhan:read"}).json()
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    r = h.get(meta["authorization_endpoint"], params={
        "response_type": "code", "client_id": client["client_id"], "redirect_uri": REDIRECT,
        "state": "s", "code_challenge": challenge, "code_challenge_method": "S256", "scope": "dhan:read"})
    txn = parse_qs(urlparse(r.headers["location"]).query)["txn"][0]
    h.post(f"{ISSUER}/login/email", data={"txn": txn, "email": "test@zaptrade.app"})
    r = h.post(f"{ISSUER}/login/otp", data={"txn": txn, "code": "123456"})
    cookie = r.headers.get("set-cookie", "")
    code = parse_qs(urlparse(r.headers["location"]).query)["code"][0]
    tok = h.post(meta["token_endpoint"], data={
        "grant_type": "authorization_code", "code": code, "redirect_uri": REDIRECT,
        "client_id": client["client_id"], "code_verifier": verifier}).json()
    return tok["access_token"], cookie


CHECK_SCRIPT = """\
f = funds()
bal = f["availabelBalance"]
if bal == -1:
    raise RuntimeError("boom")
print(json.dumps({"met": bal > 1000, "value": bal, "detail": "balance check"}))
"""


def wdb():
    c = sqlite3.connect(WATCH_DB, timeout=10)
    c.row_factory = sqlite3.Row
    return c


def age_checks():
    """Make every watcher due again (bypass the per-watcher interval gate)."""
    c = wdb()
    c.execute("UPDATE watchers SET last_checked_at = last_checked_at - 3600 WHERE last_checked_at IS NOT NULL")
    c.commit()
    c.close()


def wrow(wid):
    c = wdb()
    r = c.execute("SELECT * FROM watchers WHERE id = ?", (wid,)).fetchone()
    c.close()
    return dict(r) if r else None


def sweep(h, force=True, gap=0, secret=SWEEP_SECRET):
    return h.post(f"{ISSUER}/internal/watch-sweep", headers={"x-sweep-secret": secret},
                  json={"force": force, "min_gap_minutes": gap})


def set_balance(h, bal):
    h.post(f"http://127.0.0.1:{FAKE_DHAN}/_control", json={"balance": bal})


def main() -> int:
    # ---- pure-engine units (no server) ------------------------------------
    sys.path.insert(0, MCPDIR)
    os.environ.setdefault("WATCHERS_JWT_SECRET", JWT_SECRET)
    import watchers as W

    a = W.apply_check(False, False, False)
    check("engine: baseline not-met -> no fire, unlatched", a == {"fired": False, "baseline_done": True, "latched": False})
    a = W.apply_check(False, False, True)
    check("engine: baseline already-met -> no fire, LATCHED", a == {"fired": False, "baseline_done": True, "latched": True})
    a = W.apply_check(True, False, True)
    check("engine: transition fires + latches", a == {"fired": True, "baseline_done": True, "latched": True})
    a = W.apply_check(True, True, True)
    check("engine: latched stays quiet", a["fired"] is False and a["latched"] is True)
    a = W.apply_check(True, True, False)
    check("engine: observed un-met releases latch", a["fired"] is False and a["latched"] is False)
    check("contract: valid", W.parse_result('noise\n{"met": true, "value": 5}')["met"] is True)
    check("contract: last line wins", W.parse_result('{"met": true}\nplain text')["ok"] is False)
    check("contract: met must be bool", W.parse_result('{"met": "yes"}')["ok"] is False)
    check("contract: empty output", W.parse_result("")["ok"] is False)
    tok = W.sign_session("u1", "a@b.c")
    check("cookie: roundtrip", (W.verify_session(tok) or {}).get("sub") == "u1")
    check("cookie: tamper rejected", W.verify_session(tok[:-3] + "aaa") is None)

    # ---- infra ------------------------------------------------------------
    for f in (OAUTH_DB, WATCH_DB):
        for ext in ("", "-wal", "-shm"):
            if os.path.exists(f + ext):
                os.unlink(f + ext)
    fd = ThreadingHTTPServer(("127.0.0.1", FAKE_DHAN), FakeDhan)
    fr = ThreadingHTTPServer(("127.0.0.1", FAKE_RESEND), FakeResend)
    threading.Thread(target=fd.serve_forever, daemon=True).start()
    threading.Thread(target=fr.serve_forever, daemon=True).start()

    # Temporary broker row for the test user on REAL Neon (cleaned up below).
    import psycopg
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    envmap = {}
    for line in open(os.path.join(REPO, ".env")):
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, _, v = line.partition("=")
            envmap[k.strip()] = v.strip().strip("'\"")
    pg = psycopg.connect(envmap["DATABASE_URL"], autocommit=True)
    uid = pg.execute("SELECT id FROM users WHERE email = 'test@zaptrade.app'").fetchone()[0]
    key = hashlib.sha256(envmap["CREDS_ENCRYPTION_KEY"].encode()).digest()
    iv = secrets.token_bytes(12)
    blob = AESGCM(key).encrypt(iv, json.dumps({"type": "access_token", "accessToken": GOOD}).encode(), None)
    enc = "v1:" + base64.b64encode(iv).decode() + ":" + base64.b64encode(blob[:-16]).decode() + ":" + base64.b64encode(blob[-16:]).decode()
    pg.execute(
        "INSERT INTO broker_connections (user_id, dhan_client_id, credential_enc, status) VALUES (%s, 'e2e-w', %s, 'active')"
        " ON CONFLICT (user_id) DO UPDATE SET dhan_client_id='e2e-w', credential_enc=EXCLUDED.credential_enc, status='active'",
        (uid, enc),
    )

    env = {k: v for k, v in os.environ.items() if not k.startswith(("DHAN", "WATCH", "RESEND_BASE"))}
    env.update(
        DHAN_BASE_URL=f"http://127.0.0.1:{FAKE_DHAN}", DHAN_MCP_ISSUER=ISSUER,
        DHAN_MCP_OAUTH_DB=OAUTH_DB, DHAN_MCP_WATCHERS_DB=WATCH_DB,
        DHAN_MCP_APP_URL="https://zap-eve.vercel.app",
        WATCHERS_JWT_SECRET=JWT_SECRET, WATCH_SWEEP_SECRET_MCP=SWEEP_SECRET,
        WATCHERS_MAX_ARMED="2", RESEND_BASE_URL=f"http://127.0.0.1:{FAKE_RESEND}",
    )
    proc = subprocess.Popen([sys.executable, os.path.join(MCPDIR, "dhan_mcp_oauth.py"), "--port", str(PORT)], env=env)
    try:
        for _ in range(80):
            try:
                httpx.get(f"{ISSUER}/health", timeout=1.0)
                break
            except Exception:
                time.sleep(0.25)
        h = httpx.Client(timeout=120.0, follow_redirects=False)

        access, connector_cookie = oauth_login(h)
        check("connector OTP sets watchers cookie", "zap_eve_watchers=" in connector_cookie, connector_cookie[:80])
        m = Mcp(ISSUER, access)
        m.start()
        tools = {t["name"] for t in m.rpc("tools/list", {})["result"]["tools"]}
        check("tools: +create/list, NO mutation tools",
              tools == {"run_python", "dhan_auth_status", "create_watcher", "list_watchers"}, str(tools))

        out = m.tool("create_watcher", {"symbol": "TESTSYM", "label": "bad script", "script": "print('hello')"})
        check("bad script rejected w/ output", "NOT created" in out and "hello" in out, out[:200])
        check("bad script left no row", wdb().execute("SELECT COUNT(*) FROM watchers").fetchone()[0] == 0)

        out = m.tool("create_watcher", {"symbol": "TESTSYM", "label": "balance above 1000", "script": CHECK_SCRIPT})
        w1 = json.loads(out)
        check("create ok, baseline not-met", w1["status"] == "ARMED" and w1["dryRun"]["met"] is False and w1["pageUrl"].endswith("/watchers"), out[:200])
        w2 = json.loads(m.tool("create_watcher", {"symbol": "TESTSYM2", "label": "second", "script": CHECK_SCRIPT}))
        out = m.tool("create_watcher", {"symbol": "TESTSYM3", "label": "third", "script": CHECK_SCRIPT})
        check("armed cap enforced (2)", "limit reached" in out, out[:150])

        lst = json.loads(m.tool("list_watchers"))
        check("list shows 2 armed", len(lst["watchers"]) == 2 and all(w["status"] == "ARMED" for w in lst["watchers"]), str(lst)[:200])

        r = sweep(h, secret="wrong")
        check("sweep bad secret -> 401", r.status_code == 401)
        age_checks()  # the dry-run counted as the baseline check; make them due
        r = sweep(h).json()
        check("sweep: baseline holds, no fire", r["checked"] == 2 and r["fired"] == 0, str(r))

        set_balance(h, 2000)
        age_checks()
        r = sweep(h).json()
        check("transition -> both fire", r["fired"] == 2, str(r))
        time.sleep(0.3)
        check("2 alert emails sent", len(SENT) == 2 and "TESTSYM" in SENT[0]["subject"], str(SENT))

        age_checks()
        r = sweep(h).json()
        check("still met -> latched, no refire", r["fired"] == 0 and r["checked"] == 2, str(r))

        set_balance(h, 500)
        age_checks()
        r = sweep(h).json()
        check("un-met observed -> release, no fire", r["fired"] == 0, str(r))

        # email failure path: next fire's email fails -> retried next sweep
        h.post(f"http://127.0.0.1:{FAKE_RESEND}/_fail", json={"n": 2})
        set_balance(h, 2000)
        age_checks()
        r = sweep(h).json()
        check("refire after reset", r["fired"] == 2, str(r))
        c = wdb()
        unmailed = c.execute("SELECT COUNT(*) FROM fires WHERE emailed = 0").fetchone()[0]
        c.close()
        check("failed emails recorded un-emailed", unmailed == 2, unmailed)
        age_checks()
        r = sweep(h).json()
        check("un-emailed fires retried", r["emailRetries"] == 2 and r["fired"] == 0, str(r))

        # min-gap: default 15min gap defers (no override)
        set_balance(h, 500)
        age_checks()
        r = sweep(h, gap=None).json() if False else h.post(f"{ISSUER}/internal/watch-sweep", headers={"x-sweep-secret": SWEEP_SECRET}, json={"force": True}).json()
        check("min-gap defers recently-fired", r["deferred"] == 2 and r["checked"] == 0, str(r))

        # interval gate: without aging, an immediate sweep finds nothing due
        c = wdb()
        c.execute("UPDATE watchers SET last_checked_at = ?", (int(time.time()),))
        c.commit(); c.close()
        r = sweep(h).json()
        check("interval gate: nothing due", r["checked"] == 0 and r["deferred"] == 0, str(r))

        # ---- page -----------------------------------------------------------
        h2 = httpx.Client(timeout=30.0, follow_redirects=False)  # no cookie jar contamination
        r = h2.get(f"{ISSUER}/watchers")
        check("page w/o cookie -> login form", 'name="email"' in r.text, r.text[:150])
        cookie_hdr = {"Cookie": connector_cookie.split(";")[0]}
        r = h.get(f"{ISSUER}/watchers", headers=cookie_hdr)
        check("connector cookie opens page", "TESTSYM" in r.text and "balance above 1000" in r.text, r.text[:200])

        r = h.post(f"{ISSUER}/watchers/login/email", data={"email": "test@zaptrade.app"})
        check("page login: email -> otp form", 'name="code"' in r.text)
        r = h.post(f"{ISSUER}/watchers/login/otp", data={"email": "test@zaptrade.app", "code": "999999"})
        check("page login: wrong otp rejected", r.status_code == 400)
        r = h.post(f"{ISSUER}/watchers/login/otp", data={"email": "test@zaptrade.app", "code": "123456"})
        page_cookie = {"Cookie": r.headers.get("set-cookie", "").split(";")[0]}
        check("page login: otp -> cookie + redirect", r.status_code == 303 and "zap_eve_watchers=" in r.headers.get("set-cookie", ""))

        r = h.post(f"{ISSUER}/watchers/{w1['id']}/pause", headers=page_cookie)
        check("pause via page", r.status_code == 303 and wrow(w1["id"])["status"] == "PAUSED")
        age_checks()
        rep = sweep(h).json()
        check("paused watcher skipped by sweep", rep["checked"] == 1, str(rep))
        r = h.post(f"{ISSUER}/watchers/{w1['id']}/resume", headers=page_cookie)
        check("resume via page", wrow(w1["id"])["status"] == "ARMED")
        r = h.post(f"{ISSUER}/watchers/{w2['id']}/cancel", headers=page_cookie)
        check("cancel via page", wrow(w2["id"])["status"] == "CANCELLED")
        r = h2.post(f"{ISSUER}/watchers/{w1['id']}/pause")
        check("mutation w/o cookie -> 401", r.status_code == 401, r.status_code)
        bad = {"Cookie": f"zap_eve_watchers={tok[:-3]}aaa"}
        r = h.post(f"{ISSUER}/watchers/{w1['id']}/pause", headers=bad)
        check("tampered cookie -> 401", r.status_code == 401)

        # expiry
        c = wdb(); c.execute("UPDATE watchers SET expires_at = 1 WHERE id = ?", (w1["id"],)); c.commit(); c.close()
        rep = sweep(h).json()
        check("expiry sweep", rep["expired"] == 1 and wrow(w1["id"])["status"] == "EXPIRED", str(rep))
        c = wdb(); c.execute("UPDATE watchers SET expires_at = ?, status = 'ARMED' WHERE id = ?", (int(time.time()) + 86400, w1["id"])); c.commit(); c.close()

        # error escalation: script raises 5x -> ERROR
        set_balance(h, -1)
        for i in range(5):
            age_checks()
            sweep(h)
        row = wrow(w1["id"])
        check("5 consecutive failures -> ERROR", row["status"] == "ERROR" and "5 times" in (row["status_reason"] or ""), str(dict(row))[:200])
        r = h.post(f"{ISSUER}/watchers/{w1['id']}/resume", headers=page_cookie)
        row = wrow(w1["id"])
        check("resume from ERROR re-arms clean", row["status"] == "ARMED" and row["error_count"] == 0)

        # dead-token path: probe fails -> broker marked expired + reconnect email
        set_balance(h, 500)
        h.post(f"http://127.0.0.1:{FAKE_DHAN}/_control", json={"mode": "deadtoken"})
        before = len(SENT)
        age_checks()
        rep = sweep(h).json()
        row = wrow(w1["id"])
        st = pg.execute("SELECT status FROM broker_connections WHERE user_id = %s", (uid,)).fetchone()[0]
        check("dead token -> watcher ERROR + broker token_expired",
              row["status"] == "ERROR" and "token expired" in (row["status_reason"] or "").lower() and st == "token_expired",
              f"{row['status']} {row['status_reason']} broker={st}")
        time.sleep(0.3)
        check("reconnect email sent", len(SENT) == before + 1 and "reconnect" in SENT[-1]["subject"].lower(), str(SENT[-1:]))
    finally:
        try:
            pg.execute("DELETE FROM broker_connections WHERE user_id = %s AND dhan_client_id = 'e2e-w'", (uid,))
            pg.close()
        except Exception as e:
            print("CLEANUP WARNING:", e)
        proc.terminate()
        fd.shutdown()
        fr.shutdown()

    print(f"\n{passed} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
