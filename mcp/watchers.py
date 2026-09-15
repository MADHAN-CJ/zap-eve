#!/usr/bin/env python3
"""
watchers.py — script-based market watchers for the zap-eve-mcp OAuth server.

Loaded (guarded) by dhan_mcp_oauth.py; dhan_mcp.py stays byte-identical.
Plan + user-confirmed decisions: docs/plan-mcp-watchers.md.

The shape of it:
  * Claude gets exactly TWO tools — `create_watcher` and `list_watchers`.
    There is deliberately no pause/resume/cancel/edit tool: management
    happens only on the /watchers web page (same styling as the login
    pages), authenticated by a signed session cookie that is set when the
    user completes the connector's OTP login (or the page's own identical
    email→OTP login). The page URL is static; the link itself grants
    nothing.
  * A watcher's condition is a Claude-authored Python script whose LAST
    printed line must be JSON: {"met": <bool>, "value"?: ..., "detail"?: ...}.
    The sweeper runs it through the same sandboxed `dhan_mcp.py --exec -`
    subprocess as run_python (owner's Dhan creds only) — zero AI tokens per
    poll — and layers the eve-agent watcher semantics on top: first-run
    baseline never fires (already-true starts latched), edge-trigger latch
    (one fire per not-met→met transition, released only when observed
    un-met), min-gap between fires, NSE market-hours gate, expiry.
  * Rows live in a local sqlite DB (no product-DB schema changes). The
    eve-agent `watches` table and its sweeper are untouched.

Env (all read at call time):
  WATCHERS_JWT_SECRET       required — signs the page session cookie
  WATCH_SWEEP_SECRET_MCP    required — gates POST /internal/watch-sweep
  DHAN_MCP_WATCHERS_DB      sqlite path (default .dhan-watchers.sqlite3
                            beside this file; box: /var/lib/zapevemcp/…)
  WATCHERS_MAX_ARMED        default 10 (per user)
  WATCHERS_MIN_GAP_MINUTES  default 15 (between fires of one watcher)
  RESEND_BASE_URL           default https://api.resend.com (test hook)
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import html
import json
import logging
import os
import re
import secrets
import sqlite3
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlparse

import anyio
import httpx

from mcp.server.auth.middleware.auth_context import get_access_token
from starlette.requests import Request
from starlette.responses import HTMLResponse, JSONResponse, RedirectResponse, Response

log = logging.getLogger("watchers")

# Host module (dhan_mcp_oauth), set by register(). Everything identity/
# execution related is reached through it so this module never imports the
# OAuth module (no import cycle).
H: Any = None

IST = timezone(timedelta(hours=5, minutes=30))
COOKIE_NAME = "zap_eve_watchers"
COOKIE_TTL_S = 30 * 24 * 3600
INTERVAL_MIN, INTERVAL_MAX = 1, 120  # minutes
EXPIRY_MIN_D, EXPIRY_MAX_D = 1, 30
ERROR_ESCALATION = 5  # consecutive check failures -> status ERROR
ACTIVE = ("ARMED", "PAUSED", "ERROR")
FINAL = ("EXPIRED", "CANCELLED")

# Same auth-suspect heuristic the run_python path uses (dhan_mcp_oauth).
AUTH_SUSPECT_RE = re.compile(
    r"invalid token|unauthor|access token.*invalid|DH-9(01|05|08)|token.*expired", re.I
)


def issuer() -> str:
    return (os.environ.get("DHAN_MCP_ISSUER") or "http://127.0.0.1:8017").rstrip("/")


def page_url() -> str:
    return issuer() + "/watchers"


def max_armed() -> int:
    return int(os.environ.get("WATCHERS_MAX_ARMED", "10"))


def min_gap_minutes() -> int:
    return int(os.environ.get("WATCHERS_MIN_GAP_MINUTES", "15"))


def _secret(name: str) -> str:
    v = os.environ.get(name, "")
    if len(v) < 16:
        raise RuntimeError(f"{name} must be set to a random secret of at least 16 characters.")
    return v


def is_nse_open(now: datetime | None = None) -> bool:
    """NSE cash market hours: 09:15–15:30 IST, Monday–Friday."""
    t = (now or datetime.now(timezone.utc)).astimezone(IST)
    if t.weekday() > 4:
        return False
    minutes = t.hour * 60 + t.minute
    return 9 * 60 + 15 <= minutes <= 15 * 60 + 30

# ---------------------------------------------------------------------------
# Store (sqlite, WAL)
# ---------------------------------------------------------------------------


def _db_path() -> str:
    return os.environ.get("DHAN_MCP_WATCHERS_DB") or os.path.join(
        os.path.dirname(os.path.abspath(__file__)), ".dhan-watchers.sqlite3"
    )


_local = threading.local()


def _sql() -> sqlite3.Connection:
    conn = getattr(_local, "conn", None)
    if conn is None:
        conn = sqlite3.connect(_db_path(), timeout=10)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute(
            "CREATE TABLE IF NOT EXISTS watchers ("
            " id TEXT PRIMARY KEY, user_id TEXT NOT NULL, email TEXT NOT NULL,"
            " symbol TEXT NOT NULL, label TEXT NOT NULL, script TEXT NOT NULL,"
            " check_every_s INTEGER NOT NULL, status TEXT NOT NULL,"
            " status_reason TEXT, baseline_done INTEGER NOT NULL DEFAULT 0,"
            " latched INTEGER NOT NULL DEFAULT 0, last_met INTEGER,"
            " last_value TEXT, last_detail TEXT, last_error TEXT,"
            " error_count INTEGER NOT NULL DEFAULT 0, last_checked_at INTEGER,"
            " last_fired_at INTEGER, fired_count INTEGER NOT NULL DEFAULT 0,"
            " expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL,"
            " updated_at INTEGER NOT NULL)"
        )
        conn.execute("CREATE INDEX IF NOT EXISTS watchers_user ON watchers (user_id)")
        conn.execute(
            "CREATE TABLE IF NOT EXISTS fires ("
            " id TEXT PRIMARY KEY, watcher_id TEXT NOT NULL, fired_at INTEGER NOT NULL,"
            " value TEXT, detail TEXT, emailed INTEGER NOT NULL DEFAULT 0)"
        )
        conn.execute("CREATE INDEX IF NOT EXISTS fires_watcher ON fires (watcher_id)")
        conn.commit()
        _local.conn = conn
    return conn


def _now() -> int:
    return int(time.time())


def _update(wid: str, **fields: Any) -> None:
    fields["updated_at"] = _now()
    cols = ", ".join(f"{k} = ?" for k in fields)
    _sql().execute(f"UPDATE watchers SET {cols} WHERE id = ?", (*fields.values(), wid))
    _sql().commit()


# ---------------------------------------------------------------------------
# Session cookie — compact HS256 JWT, stdlib only
# ---------------------------------------------------------------------------


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def sign_session(user_id: str, email: str) -> str:
    header = _b64(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    payload = _b64(json.dumps({"sub": user_id, "email": email, "exp": _now() + COOKIE_TTL_S}).encode())
    sig = hmac.new(_secret("WATCHERS_JWT_SECRET").encode(), f"{header}.{payload}".encode(), hashlib.sha256).digest()
    return f"{header}.{payload}.{_b64(sig)}"


def verify_session(token: str | None) -> dict[str, str] | None:
    if not token or token.count(".") != 2:
        return None
    header, payload, sig = token.split(".")
    want = hmac.new(_secret("WATCHERS_JWT_SECRET").encode(), f"{header}.{payload}".encode(), hashlib.sha256).digest()
    if not hmac.compare_digest(want, _unb64(sig)):
        return None
    try:
        claims = json.loads(_unb64(payload))
    except ValueError:
        return None
    if not isinstance(claims.get("exp"), int) or claims["exp"] < _now() or not claims.get("sub"):
        return None
    return {"sub": str(claims["sub"]), "email": str(claims.get("email") or "")}


def _cookie_path() -> str:
    return urlparse(issuer()).path or "/"


def attach_cookie(response: Response, user_id: str, email: str) -> None:
    """Set the watchers session cookie. Also called from the connector's OTP
    login handler (guarded there), so connecting the MCP signs the browser in."""
    response.set_cookie(
        COOKIE_NAME,
        sign_session(user_id, email),
        max_age=COOKIE_TTL_S,
        path=_cookie_path(),
        httponly=True,
        secure=issuer().startswith("https"),
        samesite="lax",
    )


def _session(request: Request) -> dict[str, str] | None:
    return verify_session(request.cookies.get(COOKIE_NAME))


# ---------------------------------------------------------------------------
# Check-result contract + edge-trigger engine (pure — unit-tested)
# ---------------------------------------------------------------------------


def parse_result(output: str) -> dict[str, Any]:
    """Parse a check script's output: the LAST non-empty line must be JSON
    {"met": bool, "value"?: num|str, "detail"?: str}. Returns
    {ok, met, value, detail, error}."""
    lines = [ln for ln in (output or "").strip().splitlines() if ln.strip()]
    if not lines:
        return {"ok": False, "error": "script printed nothing — it must end by printing the JSON result line"}
    last = lines[-1].strip()
    try:
        d = json.loads(last)
    except ValueError:
        return {"ok": False, "error": f"last printed line is not JSON: {last[:200]}"}
    if not isinstance(d, dict) or not isinstance(d.get("met"), bool):
        return {"ok": False, "error": f'JSON result must be an object with a boolean "met": {last[:200]}'}
    value = d.get("value")
    if value is not None and not isinstance(value, (int, float, str)):
        value = str(value)
    detail = d.get("detail")
    return {"ok": True, "met": d["met"], "value": value, "detail": str(detail) if detail is not None else None}


def apply_check(baseline_done: bool, latched: bool, met: bool) -> dict[str, bool]:
    """eve-agent edge semantics for one boolean condition:
    - first successful check records a BASELINE and never fires; a condition
      already true at arm time starts latched (must reset before alerting);
    - afterwards a fire happens only on met while un-latched; the latch
      releases only when the condition is OBSERVED un-met (script errors
      never touch the latch)."""
    if not baseline_done:
        return {"fired": False, "baseline_done": True, "latched": met}
    if not met:
        return {"fired": False, "baseline_done": True, "latched": False}
    if latched:
        return {"fired": False, "baseline_done": True, "latched": True}
    return {"fired": True, "baseline_done": True, "latched": True}


# ---------------------------------------------------------------------------
# Email (Resend; RESEND_BASE_URL overridable for the test harness)
# ---------------------------------------------------------------------------


def send_email(to: str, subject: str, text: str) -> bool:
    api_key = os.environ.get("RESEND_API_KEY")
    if not api_key:
        log.warning("RESEND_API_KEY unset — would email %s: %s", to, subject)
        return True
    base = (os.environ.get("RESEND_BASE_URL") or "https://api.resend.com").rstrip("/")
    try:
        res = httpx.post(
            base + "/emails",
            headers={"Authorization": f"Bearer {api_key}"},
            json={
                "from": os.environ.get("OTP_FROM_EMAIL") or "Zap Trade <login-link@codeongrass.com>",
                "to": [to],
                "subject": subject,
                "text": text,
            },
            timeout=15.0,
        )
        return res.status_code < 400
    except Exception as e:
        log.error("email send failed: %s", e)
        return False


def _fire_email_text(row: sqlite3.Row, value: Any, detail: str | None) -> str:
    when = datetime.now(IST).strftime("%d %b %Y, %H:%M IST")
    lines = [
        f"Your watcher on {row['symbol']} just triggered.",
        "",
        f"Condition: {row['label']}",
    ]
    if value is not None:
        lines.append(f"Value: {value}")
    if detail:
        lines.append(f"Detail: {detail}")
    lines += [
        f"Time: {when}",
        "",
        f"Manage your watchers: {page_url()}",
        "",
        "Zap is read-only — it can never trade. It will alert again only after the condition resets and comes true again.",
    ]
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Sweep
# ---------------------------------------------------------------------------

BROKER_ERROR_MESSAGES = {
    "token_expired": "Dhan token expired — reconnect Dhan in the Zap app, then resume this watcher.",
    "disconnected": "Dhan is disconnected — reconnect in the Zap app, then resume this watcher.",
    "not_connected": "Dhan is not connected — connect in the Zap app, then resume this watcher.",
}
DATA_API_MESSAGE = (
    "Dhan Data-API subscription missing (error 806) — this check needs it. Resubscribe on dhan.co, then resume."
)


def sweep(force: bool = False, min_gap_override: int | None = None) -> dict[str, Any]:
    """One sweeper tick. Driven by the systemd timer via POST
    /internal/watch-sweep; `force` skips the market-hours gate (tests /
    off-hours smoke), and min_gap_override is honored only with force."""
    now = _now()
    report: dict[str, Any] = {
        "ranAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "marketOpen": is_nse_open(),
        "expired": 0,
        "checked": 0,
        "fired": 0,
        "deferred": 0,
        "erroredWatchers": 0,
        "usersSkipped": 0,
        "emailRetries": 0,
        "notes": [],
    }
    if not report["marketOpen"] and not force:
        return report

    # Fires whose email failed earlier: retry before anything else.
    unmailed = _sql().execute(
        "SELECT f.id, f.value, f.detail, w.email, w.symbol, w.label, f.watcher_id"
        " FROM fires f JOIN watchers w ON w.id = f.watcher_id WHERE f.emailed = 0 LIMIT 20"
    ).fetchall()
    for f in unmailed:
        row = _sql().execute("SELECT * FROM watchers WHERE id = ?", (f["watcher_id"],)).fetchone()
        if row and send_email(f["email"], f"⚡ {f['symbol']}: {f['label']}", _fire_email_text(row, f["value"], f["detail"])):
            _sql().execute("UPDATE fires SET emailed = 1 WHERE id = ?", (f["id"],))
            _sql().commit()
            report["emailRetries"] += 1

    # Expiry (armed AND paused; no email — eve W8).
    cur = _sql().execute(
        "UPDATE watchers SET status = 'EXPIRED', updated_at = ? WHERE status IN ('ARMED','PAUSED') AND expires_at < ?",
        (now, now),
    )
    _sql().commit()
    report["expired"] = cur.rowcount

    due = _sql().execute(
        "SELECT * FROM watchers WHERE status = 'ARMED'"
        " AND (last_checked_at IS NULL OR last_checked_at <= ? - check_every_s)",
        (now,),
    ).fetchall()
    by_user: dict[str, list[sqlite3.Row]] = {}
    for r in due:
        by_user.setdefault(r["user_id"], []).append(r)

    for user_id, rows in by_user.items():
        try:
            _sweep_user(user_id, rows, now, force, min_gap_override, report)
        except Exception as e:
            report["usersSkipped"] += 1
            report["notes"].append(f"user {user_id}: {e}")
    return report


def _error_user_watchers(user_id: str, message: str, report: dict[str, Any]) -> list[sqlite3.Row]:
    rows = _sql().execute("SELECT * FROM watchers WHERE user_id = ? AND status = 'ARMED'", (user_id,)).fetchall()
    for r in rows:
        _update(r["id"], status="ERROR", status_reason=message)
    report["erroredWatchers"] += len(rows)
    return rows


def _sweep_user(
    user_id: str,
    rows: list[sqlite3.Row],
    now: int,
    force: bool,
    min_gap_override: int | None,
    report: dict[str, Any],
) -> None:
    creds = H.get_active_broker_creds(user_id)
    if creds["status"] == "error":
        report["usersSkipped"] += 1
        report["notes"].append(f"user {user_id}: creds lookup failed — skipped")
        return
    if creds["status"] == "none":
        message = BROKER_ERROR_MESSAGES[creds["reason"]]
        errored = _error_user_watchers(user_id, message, report)
        if creds["reason"] == "token_expired" and errored:
            send_email(
                errored[0]["email"],
                "Zap watcher paused — reconnect Dhan",
                f"Your Dhan token expired, so your watchers can't check the market.\n\n{message}\n\n{page_url()}",
            )
        return

    gap_minutes = min_gap_override if (force and min_gap_override is not None) else min_gap_minutes()
    gap_s = gap_minutes * 60
    for row in rows:
        if row["last_fired_at"] and now - row["last_fired_at"] < gap_s:
            report["deferred"] += 1
            continue
        out = H.run_script_as(row["script"], creds["dhanClientId"], creds["accessToken"])
        if "806" in out or "not subscribed" in out.lower():
            _update(row["id"], status="ERROR", status_reason=DATA_API_MESSAGE, last_checked_at=now)
            report["erroredWatchers"] += 1
            continue
        res = parse_result(out)
        report["checked"] += 1
        if not res["ok"]:
            if AUTH_SUSPECT_RE.search(out) and not H.probe_token(creds["dhanClientId"], creds["accessToken"]):
                H.mark_token_expired(user_id)
                message = BROKER_ERROR_MESSAGES["token_expired"]
                errored = _error_user_watchers(user_id, message, report)
                if errored:
                    send_email(
                        errored[0]["email"],
                        "Zap watcher paused — reconnect Dhan",
                        f"Your Dhan token expired, so your watchers can't check the market.\n\n{message}\n\n{page_url()}",
                    )
                return
            count = row["error_count"] + 1
            if count >= ERROR_ESCALATION:
                _update(
                    row["id"],
                    status="ERROR",
                    status_reason=f"Check failed {count} times in a row — last error: {res['error']}",
                    last_error=res["error"],
                    error_count=count,
                    last_checked_at=now,
                )
                report["erroredWatchers"] += 1
            else:
                _update(row["id"], last_error=res["error"], error_count=count, last_checked_at=now)
            continue

        eng = apply_check(bool(row["baseline_done"]), bool(row["latched"]), res["met"])
        fields: dict[str, Any] = {
            "baseline_done": 1,
            "latched": int(eng["latched"]),
            "last_met": int(res["met"]),
            "last_value": None if res["value"] is None else str(res["value"]),
            "last_detail": res["detail"],
            "last_error": None,
            "error_count": 0,
            "last_checked_at": now,
        }
        if eng["fired"]:
            fire_id = secrets.token_hex(12)
            _sql().execute(
                "INSERT INTO fires (id, watcher_id, fired_at, value, detail, emailed) VALUES (?, ?, ?, ?, ?, 0)",
                (fire_id, row["id"], now, fields["last_value"], res["detail"]),
            )
            _sql().commit()
            if send_email(row["email"], f"⚡ {row['symbol']}: {row['label']}", _fire_email_text(row, res["value"], res["detail"])):
                _sql().execute("UPDATE fires SET emailed = 1 WHERE id = ?", (fire_id,))
                _sql().commit()
            fields["last_fired_at"] = now
            fields["fired_count"] = row["fired_count"] + 1
            report["fired"] += 1
        _update(row["id"], **fields)


# ---------------------------------------------------------------------------
# Page rendering
# ---------------------------------------------------------------------------

_SHELL = """<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Watchers — Zap</title>
<style>
  :root {{ color-scheme: light dark; }}
  body {{ font: 15px/1.5 system-ui, sans-serif; max-width: 44rem;
         margin: 6vh auto; padding: 0 16px; }}
  h1 {{ font-size: 1.15rem; }}
  .brand {{ display: inline-block; background: #0c6b3d; color: #fff;
         border-radius: 8px; padding: 4px 10px; font-weight: 700; }}
  .meta {{ color: #888; font-size: .85rem; }}
  .card {{ border: 1px solid #8884; border-radius: 10px; padding: 14px 16px; margin: 12px 0; }}
  .row {{ display: flex; justify-content: space-between; gap: 8px; align-items: baseline; flex-wrap: wrap; }}
  .chip {{ font-size: .75rem; font-weight: 700; border-radius: 999px; padding: 2px 10px; }}
  .c-ARMED {{ background: #0c6b3d22; color: #0c6b3d; }}
  .c-PAUSED {{ background: #8886; }}
  .c-ERROR {{ background: #b3261e22; color: #b3261e; }}
  .c-EXPIRED, .c-CANCELLED {{ background: #8883; color: #888; }}
  .err {{ background: #b3261e22; border: 1px solid #b3261e; border-radius: 6px; padding: .6rem .8rem; }}
  form.inline {{ display: inline; }}
  button {{ padding: .35rem 1rem; font: inherit; border: 1px solid #8886;
         border-radius: 6px; background: transparent; cursor: pointer; }}
  button.primary {{ background: #0c6b3d; border: 0; color: #fff; }}
  button.danger {{ color: #b3261e; border-color: #b3261e66; }}
  label {{ display: block; margin: 1rem 0 .25rem; font-weight: 600; }}
  input {{ width: 100%; box-sizing: border-box; padding: .55rem; font: inherit;
         border: 1px solid #8888; border-radius: 6px; }}
  .fires {{ font-size: .82rem; color: #888; margin-top: 6px; }}
</style></head><body>
<p><span class="brand">&#9889; Zap</span></p>
{body}
</body></html>"""


def _fmt_ts(ts: int | None) -> str:
    if not ts:
        return "—"
    return datetime.fromtimestamp(ts, IST).strftime("%d %b, %H:%M IST")


def _watcher_card(row: sqlite3.Row, fires: list[sqlite3.Row]) -> str:
    status = row["status"]
    buttons = []
    if status == "ARMED":
        buttons.append(("pause", "Pause", ""))
    if status in ("PAUSED", "ERROR"):
        buttons.append(("resume", "Resume", "primary"))
    if status in ACTIVE:
        buttons.append(("cancel", "Cancel", "danger"))
    forms = "".join(
        f'<form class="inline" method="post" action="{page_url()}/{row["id"]}/{action}"'
        + (' onsubmit="return confirm(\'Cancel this watcher for good?\')"' if action == "cancel" else "")
        + f'><button class="{cls}" type="submit">{label}</button></form> '
        for action, label, cls in buttons
    )
    bits = [f"checked {_fmt_ts(row['last_checked_at'])}"]
    if row["last_value"] is not None:
        bits.append(f"value {html.escape(str(row['last_value']))}")
    if row["last_detail"]:
        bits.append(html.escape(row["last_detail"]))
    if row["fired_count"]:
        bits.append(f"alerted {row['fired_count']}× (last {_fmt_ts(row['last_fired_at'])})")
    reason = (
        f'<div class="err" style="margin-top:8px">{html.escape(row["status_reason"] or row["last_error"] or "")}</div>'
        if status == "ERROR" and (row["status_reason"] or row["last_error"])
        else ""
    )
    fire_lines = "".join(
        f"<div>⚡ {_fmt_ts(f['fired_at'])}" + (f" — {html.escape(str(f['value']))}" if f["value"] is not None else "") + "</div>"
        for f in fires
    )
    return (
        '<div class="card"><div class="row">'
        f"<div><b>{html.escape(row['symbol'])}</b> · {html.escape(row['label'])}</div>"
        f'<span class="chip c-{status}">{status}</span></div>'
        f'<div class="meta">{" · ".join(bits)} · every {row["check_every_s"] // 60} min · expires {_fmt_ts(row["expires_at"])}</div>'
        f"{reason}"
        + (f'<div class="fires">{fire_lines}</div>' if fire_lines else "")
        + (f'<div style="margin-top:10px">{forms}</div>' if forms else "")
        + "</div>"
    )


def _render_list(session: dict[str, str]) -> str:
    rows = _sql().execute(
        "SELECT * FROM watchers WHERE user_id = ? ORDER BY created_at DESC", (session["sub"],)
    ).fetchall()
    active = [r for r in rows if r["status"] in ACTIVE]
    finished = [r for r in rows if r["status"] in FINAL][:10]

    def cards(rs: list[sqlite3.Row]) -> str:
        out = []
        for r in rs:
            fires = _sql().execute(
                "SELECT * FROM fires WHERE watcher_id = ? ORDER BY fired_at DESC LIMIT 3", (r["id"],)
            ).fetchall()
            out.append(_watcher_card(r, fires))
        return "".join(out)

    body = (
        f"<h1>Your watchers</h1><p class='meta'>Signed in as {html.escape(session['email'])}. "
        "Watchers check the market during NSE hours and email you when their condition becomes true. "
        "Create new ones by asking Claude.</p>"
    )
    body += cards(active) if active else "<p class='meta'>No active watchers — ask Claude to create one.</p>"
    if finished:
        body += "<h1 style='margin-top:24px'>Finished</h1>" + cards(finished)
    return _SHELL.format(body=body)


def _login_email_page(notice: str = "") -> str:
    body = (
        "<h1>Sign in to see your watchers</h1>"
        "<p class='meta'>Same login as the Zap app. You can only ever see your own watchers.</p>"
        + notice
        + f'<form method="post" action="{page_url()}/login/email">'
        '<label for="email">Email</label>'
        '<input id="email" name="email" type="email" autocomplete="email" autofocus>'
        '<button class="primary" style="margin-top:1.2rem" type="submit">Send code</button></form>'
    )
    return _SHELL.format(body=body)


def _login_otp_page(email: str, notice: str = "") -> str:
    body = (
        "<h1>Enter your login code</h1>"
        f"<p class='meta'>Sent to {html.escape(email)}. It expires in 10 minutes.</p>"
        + notice
        + f'<form method="post" action="{page_url()}/login/otp">'
        f'<input type="hidden" name="email" value="{html.escape(email)}">'
        '<label for="code">6-digit code</label>'
        '<input id="code" name="code" inputmode="numeric" pattern="[0-9]*" autocomplete="one-time-code" autofocus>'
        '<button class="primary" style="margin-top:1.2rem" type="submit">Sign in</button></form>'
    )
    return _SHELL.format(body=body)


def _err_box(msg: str) -> str:
    return f'<p class="err">{html.escape(msg)}</p>'


# ---------------------------------------------------------------------------
# Tools + routes
# ---------------------------------------------------------------------------

CREATE_DESCRIPTION = """\
Create a market watcher: a background check that runs a Python script on a
schedule during NSE market hours (09:15–15:30 IST, Mon–Fri) with the user's
Dhan data, and EMAILS the user when its condition BECOMES true. Use this when
the user asks to be alerted / notified / watched about a market condition
(price level, indicator cross, OI change, …).

`script` runs in the same sandbox as run_python (same preloaded functions:
ltp_of, quote, intraday_candles, ema/rsi/macd, option_chain, …) once every
`check_every_minutes`, so KEEP IT CHEAP — one or two API calls, no loops over
option chains. Its LAST printed line MUST be exactly one JSON object:
    {"met": <bool>, "value": <current number, optional>, "detail": "<short note, optional>"}
Print nothing after that line. The script is validated with one immediate
dry-run; if the output violates the contract, creation is rejected and the
actual output is returned so you can fix the script and retry.

Alert semantics (explain to the user): the first check is a BASELINE and
never alerts — a condition already true at creation must become false and
then true again to alert. One email per not-met→met transition, with a
minimum gap between alerts; the watcher expires after `expires_in_days`.

You canNOT modify, pause, resume, or cancel watchers — the user does that on
the watchers page. ALWAYS show the user the returned pageUrl after creating.\
"""

LIST_DESCRIPTION = """\
List every watcher belonging to the signed-in user: status (ARMED / PAUSED /
ERROR / EXPIRED / CANCELLED), condition, last checked value/detail, alert
history. Read-only. You canNOT pause, resume, cancel, or edit a watcher —
those actions exist only on the watchers page; when the user asks for such a
change, send them the pageUrl from this result.\
"""


def _auth_subject() -> str | None:
    access = get_access_token()
    return access.subject if access and access.subject else None


def register(server: Any, host: Any) -> None:
    """Wire tools + routes onto the existing MCPServer. Called from
    dhan_mcp_oauth.build_server() inside a guard: any exception here (e.g.
    missing secrets) disables the watcher feature and leaves the MCP
    serving exactly its previous surface."""
    global H
    H = host
    _secret("WATCHERS_JWT_SECRET")  # fail fast while still inside the guard
    _secret("WATCH_SWEEP_SECRET_MCP")
    _sql()  # create the schema up front

    @server.tool(name="create_watcher", description=CREATE_DESCRIPTION, structured_output=False)
    async def create_watcher(
        symbol: str,
        label: str,
        script: str,
        check_every_minutes: int = 1,
        expires_in_days: int = 30,
    ) -> str:
        subject = _auth_subject()
        if subject is None:
            return "Not signed in — reconnect this connector on claude.ai."
        symbol = symbol.strip().upper()[:40]
        label = " ".join(label.split())[:140]
        if not symbol or not label or not script.strip():
            return "symbol, label and script are all required."
        if not (INTERVAL_MIN <= check_every_minutes <= INTERVAL_MAX):
            return f"check_every_minutes must be between {INTERVAL_MIN} and {INTERVAL_MAX}."
        if not (EXPIRY_MIN_D <= expires_in_days <= EXPIRY_MAX_D):
            return f"expires_in_days must be between {EXPIRY_MIN_D} and {EXPIRY_MAX_D}."

        creds = await anyio.to_thread.run_sync(H.get_active_broker_creds, subject)
        if creds["status"] == "none":
            return H.BROKER_MESSAGES[creds["reason"]].format(app=H.app_url())
        if creds["status"] == "error":
            return H.BROKER_MESSAGES["error"]

        armed = _sql().execute(
            "SELECT COUNT(*) FROM watchers WHERE user_id = ? AND status = 'ARMED'", (subject,)
        ).fetchone()[0]
        if armed >= max_armed():
            return (
                f"Watcher limit reached ({max_armed()} armed). The user must cancel one on the "
                f"watchers page first: {page_url()}"
            )

        out = await anyio.to_thread.run_sync(H.run_script_as, script, creds["dhanClientId"], creds["accessToken"])
        res = parse_result(out)
        if not res["ok"]:
            return (
                "Watcher NOT created — the dry-run of your script violated the result contract "
                f"({res['error']}). Fix the script and call create_watcher again. Full output:\n\n{out[:2000]}"
            )

        email = await anyio.to_thread.run_sync(H.user_email, subject)
        now = _now()
        wid = secrets.token_hex(8)
        _sql().execute(
            "INSERT INTO watchers (id, user_id, email, symbol, label, script, check_every_s, status,"
            " baseline_done, latched, last_met, last_value, last_detail, last_checked_at,"
            " expires_at, created_at, updated_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, 'ARMED', 1, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                wid, subject, email or "", symbol, label, script, check_every_minutes * 60,
                int(res["met"]), int(res["met"]),
                None if res["value"] is None else str(res["value"]), res["detail"],
                now, now + expires_in_days * 86400, now, now,
            ),
        )
        _sql().commit()
        return json.dumps(
            {
                "id": wid,
                "status": "ARMED",
                "symbol": symbol,
                "label": label,
                "checkEveryMinutes": check_every_minutes,
                "expiresAt": datetime.fromtimestamp(now + expires_in_days * 86400, IST).strftime("%Y-%m-%d"),
                "dryRun": {"met": res["met"], "value": res["value"], "detail": res["detail"]},
                "alreadyMet": res["met"],
                "pageUrl": page_url(),
                "note": (
                    "Show the user the pageUrl — that's where they pause/resume/cancel. "
                    + ("The condition is ALREADY met right now, so it must reset before the first alert." if res["met"] else "")
                ).strip(),
            }
        )

    @server.tool(name="list_watchers", description=LIST_DESCRIPTION, structured_output=False)
    async def list_watchers() -> str:
        subject = _auth_subject()
        if subject is None:
            return "Not signed in — reconnect this connector on claude.ai."

        def _list() -> list[dict[str, Any]]:
            rows = _sql().execute(
                "SELECT * FROM watchers WHERE user_id = ? ORDER BY created_at DESC", (subject,)
            ).fetchall()
            out = []
            for r in rows:
                fires = _sql().execute(
                    "SELECT fired_at, value, detail FROM fires WHERE watcher_id = ? ORDER BY fired_at DESC LIMIT 3",
                    (r["id"],),
                ).fetchall()
                out.append(
                    {
                        "id": r["id"],
                        "symbol": r["symbol"],
                        "label": r["label"],
                        "status": r["status"],
                        "statusReason": r["status_reason"],
                        "checkEveryMinutes": r["check_every_s"] // 60,
                        "lastCheckedAt": _fmt_ts(r["last_checked_at"]),
                        "lastValue": r["last_value"],
                        "lastDetail": r["last_detail"],
                        "lastError": r["last_error"],
                        "alertCount": r["fired_count"],
                        "lastAlertAt": _fmt_ts(r["last_fired_at"]),
                        "expiresAt": _fmt_ts(r["expires_at"]),
                        "recentAlerts": [
                            {"at": _fmt_ts(f["fired_at"]), "value": f["value"], "detail": f["detail"]} for f in fires
                        ],
                    }
                )
            return out

        watchers_list = await anyio.to_thread.run_sync(_list)
        return json.dumps({"watchers": watchers_list, "pageUrl": page_url(), "managing": "page only — you cannot modify watchers"})

    # -- page routes --------------------------------------------------------

    @server.custom_route("/watchers", methods=["GET"])
    async def watchers_page(request: Request) -> HTMLResponse:
        session = _session(request)
        if session is None:
            return HTMLResponse(_login_email_page())
        return HTMLResponse(await anyio.to_thread.run_sync(_render_list, session))

    @server.custom_route("/watchers/login/email", methods=["POST"])
    async def watchers_login_email(request: Request) -> HTMLResponse:
        form = await request.form()
        email = str(form.get("email") or "")
        try:
            await anyio.to_thread.run_sync(H.request_otp, email)
        except H.IdentityError as e:
            return HTMLResponse(_login_email_page(_err_box(str(e))), status_code=400)
        return HTMLResponse(_login_otp_page(email.strip().lower()))

    @server.custom_route("/watchers/login/otp", methods=["POST"])
    async def watchers_login_otp(request: Request) -> HTMLResponse | RedirectResponse:
        form = await request.form()
        email, code = str(form.get("email") or ""), str(form.get("code") or "")
        try:
            user_id, norm_email = await anyio.to_thread.run_sync(H.verify_otp, email, code)
        except H.IdentityError as e:
            return HTMLResponse(_login_otp_page(email, _err_box(str(e))), status_code=400)
        resp = RedirectResponse(page_url(), status_code=303)
        attach_cookie(resp, user_id, norm_email)
        return resp

    @server.custom_route("/watchers/{wid}/{action}", methods=["POST"])
    async def watchers_action(request: Request) -> Response:
        session = _session(request)
        if session is None:
            return JSONResponse({"error": "not signed in"}, status_code=401)
        wid = request.path_params["wid"]
        action = request.path_params["action"]
        row = _sql().execute(
            "SELECT * FROM watchers WHERE id = ? AND user_id = ?", (wid, session["sub"])
        ).fetchone()
        if row is None:
            return JSONResponse({"error": "not found"}, status_code=404)
        status = row["status"]
        if action == "pause" and status == "ARMED":
            _update(wid, status="PAUSED")
        elif action == "resume" and status in ("PAUSED", "ERROR"):
            _update(wid, status="ARMED", status_reason=None, error_count=0, last_error=None)
        elif action == "cancel" and status in ACTIVE:
            _update(wid, status="CANCELLED")
        else:
            return JSONResponse({"error": f"cannot {action} a {status} watcher"}, status_code=400)
        return RedirectResponse(page_url(), status_code=303)

    # -- sweep endpoint (secret-gated; the path secret header is the gate,
    #    the systemd timer calls it on localhost) ---------------------------

    @server.custom_route("/internal/watch-sweep", methods=["POST"])
    async def watch_sweep(request: Request) -> JSONResponse:
        if not hmac.compare_digest(
            request.headers.get("x-sweep-secret", ""), _secret("WATCH_SWEEP_SECRET_MCP")
        ):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        try:
            body = json.loads(await request.body() or b"{}")
        except ValueError:
            body = {}
        force = bool(body.get("force"))
        override = body.get("min_gap_minutes")
        report = await anyio.to_thread.run_sync(
            sweep, force, int(override) if (force and override is not None) else None
        )
        return JSONResponse(report)

    log.info("watchers module registered (db=%s)", _db_path())
