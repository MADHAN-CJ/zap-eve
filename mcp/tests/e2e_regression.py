"""Regression: dhan_mcp_oauth.py booted WITHOUT the WATCHERS_* secrets must
serve exactly the pre-watcher surface (guarded degradation), with the OAuth
flow fully working. Run via zap-claude-mcp uv env.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time

import tempfile
import httpx

HERE = tempfile.gettempdir()
TESTDIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, TESTDIR)
import e2e_watchers as EW  # reuse Mcp + oauth_login against a different port

REPO = os.path.dirname(os.path.dirname(TESTDIR))
PORT = 8990
ISSUER = f"http://127.0.0.1:{PORT}"
OAUTH_DB = os.path.join(HERE, "reg-oauth.sqlite3")

passed = failed = 0


def check(name, ok, detail=""):
    global passed, failed
    if ok:
        passed += 1
        print(f"  ok  {name}")
    else:
        failed += 1
        print(f"FAIL  {name}  {str(detail)[:250]}")


def main() -> int:
    for ext in ("", "-wal", "-shm"):
        if os.path.exists(OAUTH_DB + ext):
            os.unlink(OAUTH_DB + ext)
    env = {k: v for k, v in os.environ.items() if not k.startswith(("DHAN", "WATCH"))}
    env.update(DHAN_MCP_ISSUER=ISSUER, DHAN_MCP_OAUTH_DB=OAUTH_DB)  # no WATCHERS secrets, no fake Dhan needed
    proc = subprocess.Popen(
        [sys.executable, os.path.join(REPO, "mcp", "dhan_mcp_oauth.py"), "--port", str(PORT)], env=env
    )
    try:
        for _ in range(80):
            try:
                httpx.get(f"{ISSUER}/health", timeout=1.0)
                break
            except Exception:
                time.sleep(0.25)
        h = httpx.Client(timeout=60.0, follow_redirects=False)

        r = h.get(f"{ISSUER}/health")
        check("health + auth mode", r.status_code == 200 and r.json().get("auth") == "oauth", r.text)

        EW.ISSUER = ISSUER  # point the shared helpers at this server
        access, cookie = EW.oauth_login(h)
        check("OAuth flow works", bool(access))
        check("no watchers cookie when disabled", "zap_eve_watchers" not in (cookie or ""), cookie[:100])

        m = EW.Mcp(ISSUER, access)
        m.start()
        tools = {t["name"] for t in m.rpc("tools/list", {})["result"]["tools"]}
        check("tool surface = pre-watcher exactly", tools == {"run_python", "dhan_auth_status"}, str(tools))

        st = json.loads(m.tool("dhan_auth_status"))
        check("auth_status works", st.get("signedIn") is True and st.get("email") == "test@zaptrade.app", str(st)[:150])

        r = h.get(f"{ISSUER}/watchers")
        check("/watchers route absent when disabled", r.status_code == 404, r.status_code)
        r = h.post(f"{ISSUER}/internal/watch-sweep")
        check("sweep route absent when disabled", r.status_code == 404, r.status_code)
    finally:
        proc.terminate()
    print(f"\n{passed} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
