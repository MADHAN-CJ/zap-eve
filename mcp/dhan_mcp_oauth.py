#!/usr/bin/env python3
"""
dhan_mcp_oauth.py — connector-native OAuth entry point for dhan_mcp.py.

dhan_mcp.py stays byte-identical (never edit its functions or structure).
This wrapper turns it into a multi-user claude.ai connector:

  * OAuth 2.1 authorization server + resource server in one process, built
    on the MCP SDK's native support (DCR, PKCE, /authorize, /token, bearer
    enforcement, metadata routes all SDK-generated). The user clicks
    Connect on claude.ai → our authorization page opens → they sign in
    with the SAME email-OTP login as the zap-eve app (same Neon `users` +
    `otps` tables, same HMAC + cooldown/TTL semantics).
  * Per-user Dhan credentials come from the zap-eve `broker_connections`
    rows (AES-256-GCM at rest) — users connect and daily-refresh Dhan in
    the zap-eve app; this server only reads. Tri-state fail-closed, and a
    Dhan 401 is judged by a /fundlimit probe before the row is marked
    token_expired (never a Zap 401).
  * Script isolation: every run_python call spawns `dhan_mcp.py --exec -`
    as a SUBPROCESS whose environment holds only that caller's Dhan
    credentials (`--env-file /dev/null` so it cannot read the box .env).
    Model-written code therefore never shares a process with the DB URL,
    the decryption key, or other users' credentials — and concurrent
    users don't serialize behind each other.
  * OAuth state (clients, login transactions, codes, hashed tokens) lives
    in a local sqlite file — no schema changes to the product database.

Env (beyond dhan_mcp's DHAN_MCP_EXEC_TIMEOUT / DHAN_MCP_MAX_OUTPUT):
  DATABASE_URL           Neon Postgres (zap-eve product DB, read + OTP rows)
  CREDS_ENCRYPTION_KEY   same secret as the app — decrypts broker creds
  CREDS_HASH_PEPPER      same secret as the app — OTP code HMAC
  RESEND_API_KEY         OTP email (unset → code logged to console, dev only)
  OTP_FROM_EMAIL         default "Zap Trade <login-link@codeongrass.com>"
  DHAN_MCP_ISSUER        public issuer URL, e.g.
                         https://uat.revise.network/zap-eve-mcp/v2
  DHAN_MCP_OAUTH_DB      sqlite path (default .dhan-oauth.sqlite3 beside
                         this file; box: /var/lib/zapevemcp/oauth.sqlite3)
  DHAN_MCP_APP_URL       where users connect Dhan (default
                         https://zap-eve.vercel.app)

Run:
    python mcp/dhan_mcp_oauth.py --http --port 8017
"""

from __future__ import annotations

import argparse
import hashlib
import hmac as hmac_mod
import html
import json
import logging
import os
import re
import secrets
import sqlite3
import subprocess
import sys
import threading
import time
from typing import Any

import anyio
import httpx

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dhan_mcp  # noqa: E402 — the unmodified single-file server

from mcp.server.auth.middleware.auth_context import get_access_token  # noqa: E402
from mcp.server.auth.provider import (  # noqa: E402
    AccessToken,
    AuthorizationCode,
    AuthorizationParams,
    OAuthAuthorizationServerProvider,
    RefreshToken,
    construct_redirect_uri,
)
from mcp.server.auth.settings import AuthSettings, ClientRegistrationOptions  # noqa: E402
from mcp.shared.auth import OAuthClientInformationFull, OAuthToken  # noqa: E402
from starlette.requests import Request  # noqa: E402
from starlette.responses import HTMLResponse, JSONResponse, RedirectResponse  # noqa: E402

log = logging.getLogger("dhan_mcp_oauth")

SCOPE = "dhan:read"
ACCESS_TTL_S = 24 * 3600
REFRESH_TTL_S = 60 * 24 * 3600
CODE_TTL_S = 5 * 60
TXN_TTL_S = 15 * 60
OTP_TTL_S = 10 * 60
OTP_COOLDOWN_S = int(os.environ.get("OTP_COOLDOWN_SECONDS", "30"))
TEST_EMAIL = "test@zaptrade.app"
TEST_CODE = "123456"
EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


def issuer() -> str:
    return (os.environ.get("DHAN_MCP_ISSUER") or "http://127.0.0.1:8017").rstrip("/")


def app_url() -> str:
    return os.environ.get("DHAN_MCP_APP_URL") or "https://zap-eve.vercel.app"


# ---------------------------------------------------------------------------
# zap-eve identity (Neon Postgres) — mirrors lib/server/otp.ts and
# agent/lib/db/{crypto,broker}.ts semantics exactly. All functions are sync;
# call them via anyio.to_thread from async handlers.
# ---------------------------------------------------------------------------


class IdentityError(RuntimeError):
    """User-facing failure in the login flow (message is shown on the page)."""


_pg_lock = threading.Lock()
_pg_conn: Any = None


def _pg():
    global _pg_conn
    import psycopg

    with _pg_lock:
        if _pg_conn is None or _pg_conn.closed:
            url = os.environ.get("DATABASE_URL")
            if not url:
                raise IdentityError("Server misconfigured: DATABASE_URL unset.")
            _pg_conn = psycopg.connect(url, autocommit=True, connect_timeout=10)
        return _pg_conn


def _pg_run(query: str, params: tuple = ()) -> list[tuple]:
    """One statement with a single automatic reconnect on a dropped conn."""
    for attempt in (1, 2):
        try:
            conn = _pg()
            with _pg_lock, conn.cursor() as cur:
                cur.execute(query, params)
                return cur.fetchall() if cur.description else []
        except IdentityError:
            raise
        except Exception:
            global _pg_conn
            with _pg_lock:
                try:
                    if _pg_conn is not None:
                        _pg_conn.close()
                except Exception:
                    pass
                _pg_conn = None
            if attempt == 2:
                raise
    return []


def _pepper(name: str) -> str:
    v = os.environ.get(name, "")
    if len(v) < 16:
        raise IdentityError(f"Server misconfigured: {name} unset.")
    return v


def otp_hash(code: str, email: str) -> str:
    """HMAC-SHA256 of `code:email` — identical to crypto.ts otpHash()."""
    return hmac_mod.new(
        _pepper("CREDS_HASH_PEPPER").encode(), f"{code}:{email.lower()}".encode(), hashlib.sha256
    ).hexdigest()


def decrypt_secret(stored: str) -> str:
    """AES-256-GCM `v1:<iv>:<ct>:<tag>` (base64) — crypto.ts decryptSecret()."""
    import base64

    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    parts = stored.split(":")
    if len(parts) != 4 or parts[0] != "v1":
        raise ValueError("Unrecognized credential ciphertext format.")
    key = hashlib.sha256(_pepper("CREDS_ENCRYPTION_KEY").encode()).digest()
    iv, ct, tag = (base64.b64decode(p) for p in parts[1:])
    return AESGCM(key).decrypt(iv, ct + tag, None).decode()


def request_otp(raw_email: str) -> None:
    email = raw_email.strip().lower()
    if not EMAIL_RE.match(email):
        raise IdentityError("Enter a valid email address.")
    if email == TEST_EMAIL:
        return
    recent = _pg_run(
        "SELECT id FROM otps WHERE email = %s AND created_at > now() - make_interval(secs => %s) LIMIT 1",
        (email, OTP_COOLDOWN_S),
    )
    if recent:
        raise IdentityError("A code was just sent — wait a moment before requesting another.")
    code = str(secrets.randbelow(900000) + 100000)
    _pg_run(
        "INSERT INTO otps (email, code_hash, expires_at) VALUES (%s, %s, now() + make_interval(secs => %s))",
        (email, otp_hash(code, email), OTP_TTL_S),
    )
    _send_otp_email(email, code)


def verify_otp(raw_email: str, code: str) -> tuple[str, str]:
    """Returns (user_id, email); raises IdentityError on a bad/expired code."""
    email = raw_email.strip().lower()
    code = code.strip()
    if email == TEST_EMAIL:
        ok = code == TEST_CODE
    else:
        rows = _pg_run(
            "UPDATE otps SET consumed_at = now() WHERE email = %s AND code_hash = %s"
            " AND consumed_at IS NULL AND expires_at > now() RETURNING id",
            (email, otp_hash(code, email)),
        )
        ok = len(rows) > 0
    if not ok:
        raise IdentityError("Invalid or expired code.")
    rows = _pg_run(
        "INSERT INTO users (email) VALUES (%s)"
        " ON CONFLICT (email) DO UPDATE SET email = excluded.email RETURNING id, email",
        (email,),
    )
    return str(rows[0][0]), rows[0][1]


def user_email(user_id: str) -> str | None:
    rows = _pg_run("SELECT email FROM users WHERE id = %s", (user_id,))
    return rows[0][0] if rows else None


def get_active_broker_creds(user_id: str) -> dict[str, Any]:
    """Tri-state like broker.ts: {status: found|none|error, ...} — fail closed."""
    try:
        rows = _pg_run(
            "SELECT dhan_client_id, credential_enc, status FROM broker_connections WHERE user_id = %s",
            (user_id,),
        )
        if not rows:
            return {"status": "none", "reason": "not_connected"}
        dhan_client_id, credential_enc, status = rows[0]
        if status != "active":
            return {"status": "none", "reason": "token_expired" if status == "token_expired" else "disconnected"}
        credential = json.loads(decrypt_secret(credential_enc))
        return {
            "status": "found",
            "dhanClientId": dhan_client_id,
            "accessToken": credential["accessToken"],
        }
    except Exception as e:
        log.error("credential lookup failed: %s", e)
        return {"status": "error"}


def mark_token_expired(user_id: str) -> None:
    _pg_run("UPDATE broker_connections SET status = 'token_expired', updated_at = now() WHERE user_id = %s", (user_id,))


def _send_otp_email(email: str, code: str) -> None:
    api_key = os.environ.get("RESEND_API_KEY")
    if not api_key:
        log.warning("RESEND_API_KEY unset — login code for %s: %s", email, code)
        return
    res = httpx.post(
        "https://api.resend.com/emails",
        headers={"Authorization": f"Bearer {api_key}"},
        json={
            "from": os.environ.get("OTP_FROM_EMAIL") or "Zap Trade <login-link@codeongrass.com>",
            "to": [email],
            "subject": f"{code} is your Zap login code",
            "text": f"Your Zap login code is {code}. It expires in 10 minutes.\n\n"
            "If you didn't request it, ignore this email.",
        },
        timeout=15.0,
    )
    if res.status_code >= 400:
        log.error("Resend send failed: %s %s", res.status_code, res.text[:300])
        raise IdentityError("Could not send the login code — try again.")


# ---------------------------------------------------------------------------
# OAuth state store (sqlite) — clients, login transactions, codes, tokens.
# Tokens are stored hashed; raw values exist only in transit.
# ---------------------------------------------------------------------------


def _db_path() -> str:
    return os.environ.get("DHAN_MCP_OAUTH_DB") or os.path.join(
        os.path.dirname(os.path.abspath(__file__)), ".dhan-oauth.sqlite3"
    )


_sql_local = threading.local()


def _sql() -> sqlite3.Connection:
    conn = getattr(_sql_local, "conn", None)
    if conn is None:
        conn = sqlite3.connect(_db_path(), timeout=10)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute(
            "CREATE TABLE IF NOT EXISTS clients (client_id TEXT PRIMARY KEY, data TEXT NOT NULL,"
            " created_at INTEGER NOT NULL)"
        )
        conn.execute(
            "CREATE TABLE IF NOT EXISTS txns (txn_id TEXT PRIMARY KEY, params TEXT NOT NULL,"
            " email TEXT, expires_at INTEGER NOT NULL)"
        )
        conn.execute(
            "CREATE TABLE IF NOT EXISTS codes (code TEXT PRIMARY KEY, data TEXT NOT NULL,"
            " expires_at INTEGER NOT NULL)"
        )
        conn.execute(
            "CREATE TABLE IF NOT EXISTS tokens (token_hash TEXT PRIMARY KEY, kind TEXT NOT NULL,"
            " data TEXT NOT NULL, expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0,"
            " pair TEXT NOT NULL)"
        )
        conn.commit()
        _sql_local.conn = conn
    return conn


def _th(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _now() -> int:
    return int(time.time())


class ZapOAuthProvider(OAuthAuthorizationServerProvider):
    """SDK provider: sqlite state + zap-eve identity. The SDK owns protocol
    validation (PKCE, redirect uris, DCR); this class owns storage + login."""

    async def get_client(self, client_id: str) -> OAuthClientInformationFull | None:
        row = _sql().execute("SELECT data FROM clients WHERE client_id = ?", (client_id,)).fetchone()
        return OAuthClientInformationFull.model_validate_json(row[0]) if row else None

    async def register_client(self, client_info: OAuthClientInformationFull) -> None:
        _sql().execute(
            "INSERT OR REPLACE INTO clients (client_id, data, created_at) VALUES (?, ?, ?)",
            (client_info.client_id, client_info.model_dump_json(), _now()),
        )
        _sql().commit()

    async def authorize(self, client: OAuthClientInformationFull, params: AuthorizationParams) -> str:
        txn = secrets.token_urlsafe(24)
        payload = {
            "client_id": client.client_id,
            "state": params.state,
            "scopes": params.scopes or [SCOPE],
            "code_challenge": params.code_challenge,
            "redirect_uri": str(params.redirect_uri),
            "redirect_uri_provided_explicitly": params.redirect_uri_provided_explicitly,
            "resource": params.resource,
        }
        _sql().execute(
            "INSERT INTO txns (txn_id, params, email, expires_at) VALUES (?, ?, NULL, ?)",
            (txn, json.dumps(payload), _now() + TXN_TTL_S),
        )
        _sql().commit()
        return f"{issuer()}/login?txn={txn}"

    async def load_authorization_code(
        self, client: OAuthClientInformationFull, authorization_code: str
    ) -> AuthorizationCode | None:
        row = _sql().execute("SELECT data, expires_at FROM codes WHERE code = ?", (authorization_code,)).fetchone()
        if not row or row[1] < _now():
            return None
        code = AuthorizationCode.model_validate_json(row[0])
        return code if code.client_id == client.client_id else None

    async def exchange_authorization_code(
        self, client: OAuthClientInformationFull, authorization_code: AuthorizationCode
    ) -> OAuthToken:
        _sql().execute("DELETE FROM codes WHERE code = ?", (authorization_code.code,))
        _sql().commit()
        return self._issue_tokens(client.client_id, authorization_code.subject, authorization_code.scopes)

    async def load_refresh_token(self, client: OAuthClientInformationFull, refresh_token: str) -> RefreshToken | None:
        row = _sql().execute(
            "SELECT data, expires_at, revoked FROM tokens WHERE token_hash = ? AND kind = 'refresh'",
            (_th(refresh_token),),
        ).fetchone()
        if not row or row[1] < _now() or row[2]:
            return None
        data = json.loads(row[0])
        if data.get("client_id") != client.client_id:
            return None
        return RefreshToken(
            token=refresh_token, client_id=data["client_id"], scopes=data["scopes"], expires_at=row[1]
        )

    async def exchange_refresh_token(
        self, client: OAuthClientInformationFull, refresh_token: RefreshToken, scopes: list[str]
    ) -> OAuthToken:
        row = _sql().execute(
            "SELECT data, pair FROM tokens WHERE token_hash = ? AND kind = 'refresh'", (_th(refresh_token.token),)
        ).fetchone()
        data = json.loads(row[0])
        # Rotation: the old access+refresh pair dies with the exchange.
        _sql().execute("UPDATE tokens SET revoked = 1 WHERE pair = ?", (row[1],))
        _sql().commit()
        return self._issue_tokens(client.client_id, data["subject"], scopes or data["scopes"])

    async def load_access_token(self, token: str) -> AccessToken | None:
        row = _sql().execute(
            "SELECT data, expires_at, revoked FROM tokens WHERE token_hash = ? AND kind = 'access'", (_th(token),)
        ).fetchone()
        if not row or row[1] < _now() or row[2]:
            return None
        data = json.loads(row[0])
        return AccessToken(
            token=token,
            client_id=data["client_id"],
            scopes=data["scopes"],
            expires_at=row[1],
            subject=data["subject"],
        )

    async def revoke_token(self, token: AccessToken | RefreshToken) -> None:
        row = _sql().execute("SELECT pair FROM tokens WHERE token_hash = ?", (_th(token.token),)).fetchone()
        if row:
            _sql().execute("UPDATE tokens SET revoked = 1 WHERE pair = ?", (row[0],))
            _sql().commit()

    def _issue_tokens(self, client_id: str, subject: str, scopes: list[str]) -> OAuthToken:
        access, refresh, pair = secrets.token_urlsafe(32), secrets.token_urlsafe(32), secrets.token_urlsafe(16)
        data = json.dumps({"client_id": client_id, "subject": subject, "scopes": scopes})
        now = _now()
        _sql().executemany(
            "INSERT INTO tokens (token_hash, kind, data, expires_at, pair) VALUES (?, ?, ?, ?, ?)",
            [
                (_th(access), "access", data, now + ACCESS_TTL_S, pair),
                (_th(refresh), "refresh", data, now + REFRESH_TTL_S, pair),
            ],
        )
        _sql().execute("DELETE FROM tokens WHERE expires_at < ?", (now,))
        _sql().execute("DELETE FROM txns WHERE expires_at < ?", (now,))
        _sql().commit()
        return OAuthToken(
            access_token=access,
            token_type="Bearer",
            expires_in=ACCESS_TTL_S,
            scope=" ".join(scopes),
            refresh_token=refresh,
        )

    # -- login-page support (not part of the SDK interface) -----------------

    def txn(self, txn_id: str) -> dict[str, Any] | None:
        row = _sql().execute("SELECT params, email, expires_at FROM txns WHERE txn_id = ?", (txn_id,)).fetchone()
        if not row or row[2] < _now():
            return None
        return {**json.loads(row[0]), "email": row[1]}

    def txn_set_email(self, txn_id: str, email: str) -> None:
        _sql().execute("UPDATE txns SET email = ? WHERE txn_id = ?", (email, txn_id))
        _sql().commit()

    def finish_login(self, txn_id: str, user_id: str) -> str:
        """OTP verified: mint the code, burn the txn, return the redirect URL."""
        t = self.txn(txn_id)
        if t is None:
            raise IdentityError("Login session expired — go back to Claude and connect again.")
        code = secrets.token_urlsafe(32)
        model = AuthorizationCode(
            code=code,
            scopes=t["scopes"],
            expires_at=_now() + CODE_TTL_S,
            client_id=t["client_id"],
            code_challenge=t["code_challenge"],
            redirect_uri=t["redirect_uri"],
            redirect_uri_provided_explicitly=t["redirect_uri_provided_explicitly"],
            resource=t.get("resource"),
            subject=user_id,
        )
        _sql().execute(
            "INSERT INTO codes (code, data, expires_at) VALUES (?, ?, ?)",
            (code, model.model_dump_json(), _now() + CODE_TTL_S),
        )
        _sql().execute("DELETE FROM txns WHERE txn_id = ?", (txn_id,))
        _sql().commit()
        return construct_redirect_uri(t["redirect_uri"], code=code, state=t["state"])


# ---------------------------------------------------------------------------
# Login pages (email → OTP), rendered by this process, opened by claude.ai.
# ---------------------------------------------------------------------------

_PAGE = """<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Sign in — Zap</title>
<style>
  :root {{ color-scheme: light dark; }}
  body {{ font: 15px/1.5 system-ui, sans-serif; max-width: 26rem;
         margin: 10vh auto; padding: 0 16px; }}
  h1 {{ font-size: 1.15rem; }}
  .brand {{ display: inline-block; background: #0c6b3d; color: #fff;
         border-radius: 8px; padding: 4px 10px; font-weight: 700; }}
  label {{ display: block; margin: 1rem 0 .25rem; font-weight: 600; }}
  input {{ width: 100%; box-sizing: border-box; padding: .55rem; font: inherit;
         border: 1px solid #8888; border-radius: 6px; }}
  button {{ margin-top: 1.25rem; padding: .55rem 1.6rem; font: inherit;
         border: 0; border-radius: 6px; background: #0c6b3d; color: #fff; }}
  .err {{ background: #b3261e22; border: 1px solid #b3261e; border-radius: 6px;
         padding: .6rem .8rem; }}
  .meta {{ color: #888; font-size: .85rem; }}
</style></head><body>
<p><span class="brand">&#9889; Zap</span></p>
<h1>{title}</h1>
<p class="meta">{sub}</p>
{notice}
<form method="post" action="{action}">
  <input type="hidden" name="txn" value="{txn}">
  {fields}
  <button type="submit">{button}</button>
</form>
</body></html>"""


def _email_page(txn: str, notice: str = "") -> str:
    # Form actions must be ABSOLUTE (issuer-based): the app lives behind an
    # nginx path prefix the browser can't see, so a root-relative action
    # would post to the public host's root and 404.
    return _PAGE.format(
        title="Connect Claude to your Zap account",
        sub="Same login as the Zap app. Read-only: Claude can analyse your Dhan positions but can never trade.",
        notice=notice,
        action=f"{issuer()}/login/email",
        txn=html.escape(txn),
        fields='<label for="email">Email</label>'
        '<input id="email" name="email" type="email" autocomplete="email" autofocus>',
        button="Send code",
    )


def _otp_page(txn: str, email: str, notice: str = "") -> str:
    return _PAGE.format(
        title="Enter your login code",
        sub=f"Sent to {html.escape(email)}. It expires in 10 minutes.",
        notice=notice,
        action=f"{issuer()}/login/otp",
        txn=html.escape(txn),
        fields='<label for="code">6-digit code</label>'
        '<input id="code" name="code" inputmode="numeric" pattern="[0-9]*" autocomplete="one-time-code" autofocus>',
        button="Sign in",
    )


def _err(msg: str) -> str:
    return f'<p class="err">{html.escape(msg)}</p>'


# ---------------------------------------------------------------------------
# Sandboxed execution: dhan_mcp.py --exec -  in a scrubbed subprocess
# ---------------------------------------------------------------------------

DHAN_MCP_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dhan_mcp.py")
_AUTH_SUSPECT_RE = re.compile(r"invalid token|unauthor|access token.*invalid|DH-9(01|05|08)|token.*expired", re.I)


def run_script_as(code: str, dhan_client_id: str, access_token: str) -> str:
    """Run one model script via dhan_mcp's own CLI, isolated to these creds."""
    child_env = {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": os.environ.get("HOME", "/tmp"),
        "LANG": os.environ.get("LANG", "C.UTF-8"),
        "DHAN_CLIENT_ID": dhan_client_id,
        "DHAN_ACCESS_TOKEN": access_token,
        "DHAN_MCP_EXEC_TIMEOUT": os.environ.get("DHAN_MCP_EXEC_TIMEOUT", "120"),
        "DHAN_MCP_MAX_OUTPUT": os.environ.get("DHAN_MCP_MAX_OUTPUT", "100000"),
    }
    if os.environ.get("DHAN_BASE_URL"):
        child_env["DHAN_BASE_URL"] = os.environ["DHAN_BASE_URL"]
    timeout = float(child_env["DHAN_MCP_EXEC_TIMEOUT"]) + 20  # child interrupts itself first
    try:
        proc = subprocess.run(
            [sys.executable, DHAN_MCP_PATH, "--exec", "-", "--env-file", os.devnull],
            input=code,
            env=child_env,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return f"[script runner timed out after {timeout:g}s — split the work across smaller calls]"
    out = proc.stdout
    if proc.returncode != 0:
        out += ("\n" if out else "") + f"[executor exited {proc.returncode}] {proc.stderr.strip()[:500]}"
    return out


def probe_token(dhan_client_id: str, access_token: str) -> bool:
    """fundlimit probe — the only evidence that a token is genuinely dead."""
    try:
        res = httpx.get(
            dhan_mcp.base_url() + "/fundlimit",
            headers={"Accept": "application/json", "access-token": access_token, "client-id": dhan_client_id},
            timeout=12.0,
        )
        return res.status_code < 400
    except Exception:
        return True  # network trouble is not evidence of a dead token


# ---------------------------------------------------------------------------
# Server wiring
# ---------------------------------------------------------------------------

BROKER_MESSAGES = {
    "not_connected": "You haven't connected Dhan to your Zap account yet. Open {app} → Broker and connect Dhan, then try again.",
    "token_expired": "Your Dhan token has expired (Dhan tokens last 24h). Open {app} → Broker and reconnect Dhan, then try again.",
    "disconnected": "Dhan is disconnected from your Zap account. Open {app} → Broker and reconnect, then try again.",
    "error": "Could not read your broker connection just now — try again in a moment.",
}

AUTH_STATUS_DESCRIPTION = """\
Who is signed in, and whether their Dhan connection is usable.

Call this when run_python reports credential/token problems, or when the user
asks about their connection. If the broker is not connected or the token has
expired, relay the returned `message` — the user fixes it in the Zap app (the
`appUrl`), never by pasting credentials into this chat.\
"""


def build_server():
    provider = ZapOAuthProvider()

    from mcp.server.mcpserver import MCPServer

    mcp_server = MCPServer(
        "dhan-data",
        auth_server_provider=provider,
        auth=AuthSettings(
            issuer_url=issuer(),
            resource_server_url=f"{issuer()}/mcp",
            client_registration_options=ClientRegistrationOptions(
                enabled=True, valid_scopes=[SCOPE], default_scopes=[SCOPE]
            ),
            required_scopes=[SCOPE],
            # Tokens exist only in our own store and work only here; the RFC 8707
            # resource indicator claude.ai sends is not re-validated per request.
            validate_token_resource=False,
        ),
    )

    @mcp_server.tool(name="run_python", description=dhan_mcp.TOOL_DESCRIPTION, structured_output=False)
    async def run_python(code: str) -> str:
        access = get_access_token()
        if access is None or not access.subject:
            return "Not signed in — reconnect this connector on claude.ai."
        creds = await anyio.to_thread.run_sync(get_active_broker_creds, access.subject)
        if creds["status"] == "none":
            return BROKER_MESSAGES[creds["reason"]].format(app=app_url())
        if creds["status"] == "error":
            return BROKER_MESSAGES["error"]
        out = await anyio.to_thread.run_sync(run_script_as, code, creds["dhanClientId"], creds["accessToken"])
        if _AUTH_SUSPECT_RE.search(out):
            alive = await anyio.to_thread.run_sync(probe_token, creds["dhanClientId"], creds["accessToken"])
            if not alive:
                await anyio.to_thread.run_sync(mark_token_expired, access.subject)
                out += "\n\n[" + BROKER_MESSAGES["token_expired"].format(app=app_url()) + "]"
        return out

    @mcp_server.tool(name="dhan_auth_status", description=AUTH_STATUS_DESCRIPTION, structured_output=False)
    async def dhan_auth_status() -> str:
        access = get_access_token()
        if access is None or not access.subject:
            return json.dumps({"signedIn": False, "message": "Reconnect this connector on claude.ai."})
        email = await anyio.to_thread.run_sync(user_email, access.subject)
        creds = await anyio.to_thread.run_sync(get_active_broker_creds, access.subject)
        broker = creds["status"] if creds["status"] != "none" else creds["reason"]
        message = None if creds["status"] == "found" else BROKER_MESSAGES[
            creds["reason"] if creds["status"] == "none" else "error"
        ].format(app=app_url())
        return json.dumps(
            {
                "signedIn": True,
                "email": email,
                "broker": "active" if creds["status"] == "found" else broker,
                "dhanClientId": creds.get("dhanClientId"),
                "appUrl": app_url(),
                "message": message,
            }
        )

    @mcp_server.custom_route("/login", methods=["GET"])
    async def login(request: Request) -> HTMLResponse:
        txn_id = request.query_params.get("txn", "")
        t = provider.txn(txn_id)
        if t is None:
            return HTMLResponse(_err("Login session expired — go back to Claude and connect again."), status_code=400)
        if t.get("email"):
            return HTMLResponse(_otp_page(txn_id, t["email"]))
        return HTMLResponse(_email_page(txn_id))

    @mcp_server.custom_route("/login/email", methods=["POST"])
    async def login_email(request: Request) -> HTMLResponse:
        form = await request.form()
        txn_id, email = str(form.get("txn") or ""), str(form.get("email") or "")
        if provider.txn(txn_id) is None:
            return HTMLResponse(_err("Login session expired — go back to Claude and connect again."), status_code=400)
        try:
            await anyio.to_thread.run_sync(request_otp, email)
        except IdentityError as e:
            return HTMLResponse(_email_page(txn_id, _err(str(e))), status_code=400)
        provider.txn_set_email(txn_id, email.strip().lower())
        return HTMLResponse(_otp_page(txn_id, email.strip().lower()))

    @mcp_server.custom_route("/login/otp", methods=["POST"])
    async def login_otp(request: Request) -> HTMLResponse | RedirectResponse:
        form = await request.form()
        txn_id, code = str(form.get("txn") or ""), str(form.get("code") or "")
        t = provider.txn(txn_id)
        if t is None or not t.get("email"):
            return HTMLResponse(_err("Login session expired — go back to Claude and connect again."), status_code=400)
        try:
            user_id, _ = await anyio.to_thread.run_sync(verify_otp, t["email"], code)
            redirect = provider.finish_login(txn_id, user_id)
        except IdentityError as e:
            return HTMLResponse(_otp_page(txn_id, t["email"], _err(str(e))), status_code=400)
        return RedirectResponse(redirect, status_code=302)

    @mcp_server.custom_route("/health", methods=["GET"])
    async def health(_request: Request) -> JSONResponse:
        return JSONResponse({"ok": True, "server": "zap-eve-mcp", "auth": "oauth"})

    return mcp_server


def main(argv: Any = None) -> int:
    parser = argparse.ArgumentParser(
        prog="dhan_mcp_oauth",
        description="Multi-user OAuth-gated hosting for dhan_mcp.py (zap-eve accounts).",
    )
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8017)
    parser.add_argument("--env-file", help="KEY=VALUE file to load (default: .env beside dhan_mcp.py or its parent)")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO)
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)

    here = os.path.dirname(os.path.abspath(__file__))
    for candidate in (
        [args.env_file] if args.env_file else [os.path.join(here, ".env"), os.path.join(here, os.pardir, ".env")]
    ):
        if candidate and dhan_mcp.load_env_file(candidate):
            break

    server = build_server()
    print(f"zap-eve-mcp (oauth) on http://{args.host}:{args.port}/mcp  issuer={issuer()}", file=sys.stderr)
    server.run(transport="streamable-http", host=args.host, port=args.port)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
