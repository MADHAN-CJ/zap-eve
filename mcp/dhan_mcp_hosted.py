#!/usr/bin/env python3
"""
dhan_mcp_hosted.py — hosted entry point for dhan_mcp.py.

dhan_mcp.py stays byte-identical (never edit its functions or structure);
this wrapper imports it, builds the exact same server via its
`build_server()`, and bolts on what hosting for claude.ai needs:

  * GET/POST /login — a browser form where the user pastes their Dhan
    client id + access token. The token therefore never passes through the
    AI's context. Submitted credentials are probed against Dhan
    (`GET /fundlimit` — works even without the paid Data-API subscription)
    and only saved on success: written 0600 to DHAN_MCP_CRED_FILE and
    applied to this process's environment, which dhan_mcp's `_creds()`
    reads on every call — new creds take effect immediately, no restart.
  * `dhan_auth_status` tool — lets the model check whether credentials are
    present and alive, and hand the user the login link when they are not.
  * GET /health — liveness probe.

The login page and /health are only reachable through the nginx secret
path prefix, which remains the sole gate (single-user deployment).

Env (beyond dhan_mcp's own):
  DHAN_MCP_CRED_FILE    where credentials persist across restarts
                        (default: .dhan-creds.json beside this file; on the
                        uat box use /var/lib/zapevemcp/dhan-creds.json —
                        the unit's only writable path)
  DHAN_MCP_PUBLIC_BASE  public URL prefix of this server (the nginx secret
                        location, no trailing slash) — builds the login link

Run:
    python mcp/dhan_mcp_hosted.py --http --port 8017

stdio is deliberately not offered here: local MCP clients should launch
dhan_mcp.py itself.
"""

from __future__ import annotations

import argparse
import html
import json
import os
import sys
from datetime import datetime, timezone
from typing import Any

import anyio
import httpx

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dhan_mcp  # noqa: E402 — the unmodified single-file server

from starlette.requests import Request  # noqa: E402 — dep of the mcp SDK
from starlette.responses import HTMLResponse, JSONResponse  # noqa: E402


# ---------------------------------------------------------------------------
# Credential store
# ---------------------------------------------------------------------------


def cred_file() -> str:
    return os.environ.get("DHAN_MCP_CRED_FILE") or os.path.join(
        os.path.dirname(os.path.abspath(__file__)), ".dhan-creds.json"
    )


def load_saved_creds() -> dict[str, str] | None:
    """Read the persisted credentials, or None when absent/unreadable."""
    try:
        with open(cred_file(), encoding="utf-8") as f:
            d = json.load(f)
    except (OSError, ValueError):
        return None
    cid = str(d.get("client_id") or "").strip()
    tok = str(d.get("access_token") or "").strip()
    return {"client_id": cid, "access_token": tok, "saved_at": str(d.get("saved_at") or "")} if cid and tok else None


def apply_creds(client_id: str, token: str) -> None:
    """Point dhan_mcp at these creds: its _creds() reads os.environ per call."""
    os.environ["DHAN_CLIENT_ID"] = client_id
    os.environ["DHAN_ACCESS_TOKEN"] = token


def save_creds(client_id: str, token: str) -> None:
    path = cred_file()
    payload = json.dumps(
        {"client_id": client_id, "access_token": token, "saved_at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    )
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(payload)
    apply_creds(client_id, token)


def probe_creds(client_id: str, token: str) -> str | None:
    """Try the creds against Dhan /fundlimit. None = good, else the error."""
    if not client_id or not token:
        return "Both fields are required."
    try:
        res = httpx.get(
            dhan_mcp.base_url() + "/fundlimit",
            headers={
                "Accept": "application/json",
                "access-token": token,
                "client-id": client_id,
            },
            timeout=12.0,
        )
    except Exception as e:  # network / timeout
        return f"Could not reach Dhan to verify: {e}"
    if res.status_code < 400:
        return None
    try:
        body = res.json()
    except Exception:
        body = {}
    msg = (body or {}).get("errorMessage") or (body or {}).get("message") or res.reason_phrase
    return f"Dhan rejected the credentials ({res.status_code}): {msg}"


def masked_token() -> str:
    tok = os.environ.get("DHAN_ACCESS_TOKEN", "").strip()
    return f"…{tok[-4:]}" if len(tok) >= 8 else ("(none)" if not tok else "(set)")


def login_url() -> str:
    base = (os.environ.get("DHAN_MCP_PUBLIC_BASE") or "").rstrip("/")
    return f"{base}/login" if base else "/login on this server's public URL prefix"


# ---------------------------------------------------------------------------
# Login page
# ---------------------------------------------------------------------------

_PAGE = """<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Dhan login — zap-eve-mcp</title>
<style>
  :root {{ color-scheme: light dark; }}
  body {{ font: 15px/1.5 system-ui, sans-serif; max-width: 34rem;
         margin: 8vh auto; padding: 0 16px; }}
  h1 {{ font-size: 1.2rem; }}
  label {{ display: block; margin: 1rem 0 .25rem; font-weight: 600; }}
  input, textarea {{ width: 100%; box-sizing: border-box; padding: .5rem;
         font: inherit; border: 1px solid #8888; border-radius: 6px; }}
  textarea {{ height: 7rem; font-family: ui-monospace, monospace; font-size: .8rem; }}
  button {{ margin-top: 1.25rem; padding: .55rem 1.4rem; font: inherit;
         border: 0; border-radius: 6px; background: #0c6b3d; color: #fff; }}
  .err {{ background: #b3261e22; border: 1px solid #b3261e; border-radius: 6px;
         padding: .6rem .8rem; }}
  .ok  {{ background: #0c6b3d22; border: 1px solid #0c6b3d; border-radius: 6px;
         padding: .6rem .8rem; }}
  .meta {{ color: #888; font-size: .85rem; }}
</style></head><body>
<h1>Dhan credentials — zap-eve-mcp</h1>
<p class="meta">Current: client id <b>{client_id}</b>, token <b>{token}</b>{saved_at}.
Dhan access tokens expire every 24&nbsp;hours — paste a fresh one from
web.dhan.co (Profile → DhanHQ Trading APIs) whenever the assistant says the
token is invalid.</p>
{notice}
<form method="post">
  <label for="client_id">Dhan client id</label>
  <input id="client_id" name="client_id" value="{client_id_raw}" autocomplete="off">
  <label for="access_token">Access token</label>
  <textarea id="access_token" name="access_token" placeholder="eyJ…"></textarea>
  <button type="submit">Verify &amp; save</button>
</form>
</body></html>"""


def render_login(notice: str = "") -> str:
    cid = os.environ.get("DHAN_CLIENT_ID", "").strip()
    saved = load_saved_creds()
    saved_at = f", saved {saved['saved_at']}" if saved and saved.get("saved_at") else ""
    return _PAGE.format(
        client_id=html.escape(cid or "(none)"),
        client_id_raw=html.escape(cid),
        token=html.escape(masked_token()),
        saved_at=html.escape(saved_at),
        notice=notice,
    )


# ---------------------------------------------------------------------------
# Server wiring
# ---------------------------------------------------------------------------

AUTH_STATUS_DESCRIPTION = """\
Check whether the server holds working Dhan credentials, and get the login
link for the user.

ALWAYS call this when a run_python result mentions missing Dhan credentials,
401/403, "Invalid token", or similar — then give the user the loginUrl and ask
them to open it in their browser and paste their Dhan client id + access token
there. Do NOT ask the user to paste the token into the chat: the login page
exists so the token never passes through this conversation. Dhan tokens expire
every 24 hours, so an expired token simply means the user should refresh it at
the same link.\
"""


def build_hosted_server():
    server = dhan_mcp.build_server()  # run_python, exactly as stock

    @server.tool(name="dhan_auth_status", description=AUTH_STATUS_DESCRIPTION, structured_output=False)
    async def dhan_auth_status() -> str:
        cid = os.environ.get("DHAN_CLIENT_ID", "").strip()
        tok = os.environ.get("DHAN_ACCESS_TOKEN", "").strip()
        if not cid or not tok:
            valid: bool | None = False
            detail = "No credentials configured."
        else:
            err = await anyio.to_thread.run_sync(probe_creds, cid, tok)
            valid = err is None
            detail = err or "Token accepted by Dhan."
        return json.dumps(
            {
                "clientId": cid or None,
                "token": masked_token(),
                "tokenValid": valid,
                "detail": detail,
                "loginUrl": login_url(),
            }
        )

    @server.custom_route("/login", methods=["GET"])
    async def login_form(_request: Request) -> HTMLResponse:
        return HTMLResponse(render_login())

    @server.custom_route("/login", methods=["POST"])
    async def login_submit(request: Request) -> HTMLResponse:
        form = await request.form()
        cid = str(form.get("client_id") or "").strip()
        tok = str(form.get("access_token") or "").strip()
        err = await anyio.to_thread.run_sync(probe_creds, cid, tok)
        if err is not None:
            return HTMLResponse(render_login(f'<p class="err">{html.escape(err)}</p>'), status_code=400)
        await anyio.to_thread.run_sync(save_creds, cid, tok)
        return HTMLResponse(
            render_login('<p class="ok">Verified with Dhan and saved — the assistant can use them right away.</p>')
        )

    @server.custom_route("/health", methods=["GET"])
    async def health(_request: Request) -> JSONResponse:
        return JSONResponse({"ok": True, "server": "zap-eve-mcp", "token": masked_token()})

    return server


def main(argv: Any = None) -> int:
    parser = argparse.ArgumentParser(
        prog="dhan_mcp_hosted",
        description="Hosted dhan_mcp with a browser login page for Dhan credentials.",
    )
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8017)
    parser.add_argument("--env-file", help="KEY=VALUE file to load (default: .env beside dhan_mcp.py or its parent)")
    args = parser.parse_args(argv)

    # The SDK's rich logging config makes httpx log every request at INFO,
    # which dhan_mcp's redirect_stderr then captures INTO tool output. Silence
    # the client libraries here — dhan_mcp.py itself stays untouched.
    import logging

    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)

    here = os.path.dirname(os.path.abspath(__file__))
    for candidate in (
        [args.env_file] if args.env_file else [os.path.join(here, ".env"), os.path.join(here, os.pardir, ".env")]
    ):
        if candidate and dhan_mcp.load_env_file(candidate):
            break

    # Credentials saved through /login outlive the .env bootstrap values.
    saved = load_saved_creds()
    if saved:
        apply_creds(saved["client_id"], saved["access_token"])

    server = build_hosted_server()
    print(f"zap-eve-mcp (hosted) on http://{args.host}:{args.port}/mcp  (+ /login, /health)", file=sys.stderr)
    server.run(transport="streamable-http", host=args.host, port=args.port)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
