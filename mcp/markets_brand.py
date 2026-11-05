"""
/markets brand for the Python servers in this directory: the HTML page shell
(OAuth consent / login / watchers pages) and transactional emails (login code,
watcher alerts, paused notice). A port of zap-kite-mcp's `pages.py` +
`emails.py` so the three /markets editions look identical — keep them in sync.
"""

from __future__ import annotations

import html
import os
from dataclasses import dataclass
from urllib.parse import quote

PRODUCT = "/markets"
DEFAULT_EMAIL_FROM = "/markets <login-link@codeongrass.com>"  # must stay on a Resend-verified domain


def email_from() -> str:
    return os.environ.get("EMAIL_FROM") or os.environ.get("OTP_FROM_EMAIL") or DEFAULT_EMAIL_FROM


INK = "#20251b"
MUTED = "#62675f"
SURFACE = "#f7f6f2"
BORDER = "#e4e7dc"
SELECT = "#f6d64d"
BUTTON = "#171a17"
SERIF = "'Libre Baskerville', Georgia, 'Times New Roman', serif"
SANS = "Onest, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif"
MONO = "'Departure Mono', ui-monospace, Menlo, Consolas, monospace"

LOGOMARK_PATHS = '<path d="M321.7 103.317V95.0774H299.058V63.705H288.6V53.5602H278.915V43.7356H258.948V35.0202H201.585V43.4187H183.203V53.5602H173.376V63.2264H156.227V56.0956H136.299V27.5724H129.009V17.7478H120.452V8.55696H106.191V0H55.4829V8.55696H37.5767V17.7478H28.5602V28.0478H0.338053C-0.422566 27.2872 0.338053 51.9756 0.338053 51.9756H19.6704V86.2035H27.5936V102.684H36.4674V112.508H45.9752V121.382H55.4829V128.671H67.843V155.927H75.9246V164.801H83.3723V173.358H129.009V164.484H139.468V154.659H149.926V136.404H134.08V144.835H120.136V155.61H92.0116V147.37H83.3723V130.89H91.6123V121.382H99.2185V112.508H107.554V102.684H116.016V93.3343H122.671V85.8897H129.957V78.1219H146.757V85.6932H155.631V127.486H165.931V144.835H174.647V155.61H184.947V164.801H193.979V173.358H266.555V165.2H277.013V154.659H287.155V144.518H296.979V122.967H308.23V128.671H340.398V103.317H321.7ZM119.343 75.428H110.945V84.6188H101.754V93.8097H92.2462V103.317H83.3723V112.825H61.8214V107.247H53.5814V97.318H44.0736V83.6681H37.5767V33.9109H46.926V25.354H56.7506V16.797H98.7431V26.3047H109.994V34.8617H119.343V75.428ZM281.767 130.89H274.164V140.081H264.97V149.905H253.779V159.571H204.913V149.905H193.098V140.081H182.887V124.551H174.013V77.6465H183.203V69.0895H193.028V59.7403H202.853V52.1341H249.124V61.4834H262.752V71.308H272.735V81.7665H281.767V130.89Z"/><path d="M201.582 81.9258H229.696V90.6412H241.85V115.995H236.761V124.552H220.281V115.995H210.773V90.9581H201.582V81.9258Z"/><path d="M53.4961 41.8828H81.6073V50.5982H93.7614V75.9522H88.6747V84.5092H72.1946V75.9522H62.6869V50.9152H53.4961V41.8828Z"/>'
_SLASH_DATA = quote(
    '<svg width="60" height="113" viewBox="0 0 60 113" fill="none" xmlns="http://www.w3.org/2000/svg">\n<path d="M39.5479 80.2607H19.7744V112.829H0V80.2598H19.7734V32.5703H39.5479V80.2607ZM59.3213 32.5693H39.5469V0H59.3213V32.5693Z" fill="black"/>\n</svg>',
    safe="",
)
_LOGOMARK = (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 341 174" fill="#34432e" aria-hidden="true">'
    f"{LOGOMARK_PATHS}</svg>"
)

# ---------------------------------------------------------------------------
# Pages
# ---------------------------------------------------------------------------

_SHELL = """<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>{title} · /markets</title>
<style>
  :root {{ color-scheme: light; --ink: #20251b; --muted: #62675f; --surface: #f7f6f2; --border: #e4e7dc;
          --select: #f6d64d; --button: #171a17; --negative: #a43c2f; --negative-surface: #f8e3df;
          --positive: #34432e; --positive-surface: #e6efdc; --ring: #4a6640; }}
  body {{ margin: 0; background: #fff; color: var(--ink); font: 16px/1.6 "Onest", Arial, sans-serif;
         -webkit-font-smoothing: antialiased; }}
  main {{ max-width: {width}; margin: {vmargin} auto; padding: 0 20px; }}
  h1 {{ font-family: "Libre Baskerville", Georgia, serif; font-weight: 500; font-size: 1.75rem;
       line-height: 1.2; letter-spacing: -.025em; margin: 1.4rem 0 .4rem; text-wrap: pretty; }}
  .brand {{ display: inline-flex; align-items: center; gap: 8px; color: var(--ink); text-decoration: none;
           font-weight: 500; font-size: 1.1rem; }}
  .brand svg {{ height: 26px; width: auto; }}
  .slash {{ display: inline-block; width: .424em; height: .8em; margin-right: .04em; vertical-align: -.12em;
           overflow: hidden; text-indent: 1em; background: currentColor;
           mask: url("data:image/svg+xml,{slash}") center / contain no-repeat;
           -webkit-mask: url("data:image/svg+xml,{slash}") center / contain no-repeat; }}
  .meta, .muted {{ color: var(--muted); }}
  .muted {{ font-size: .9em; }}
  .err {{ background: var(--negative-surface); color: var(--negative); border-radius: 12px; padding: .7rem 1rem; }}
  .ok {{ background: var(--positive-surface); color: var(--positive); border-radius: 12px; padding: .7rem 1rem; }}
  label {{ display: block; margin: 1.2rem 0 .4rem; font-weight: 500; }}
  input, textarea {{ width: 100%; box-sizing: border-box; min-height: 50px; padding: 0 20px; font: inherit;
          color: var(--ink); background: #fffef9; border: 1px solid var(--border); border-radius: 999px; }}
  textarea {{ border-radius: 14px; padding: 12px 20px; height: 7rem; font-family: {mono}; font-size: .85rem; }}
  input:focus-visible, textarea:focus-visible {{ outline: 2px solid var(--ring); outline-offset: 3px; }}
  button {{ display: inline-flex; align-items: center; justify-content: center; min-height: 50px; padding: 0 21px;
           margin-top: 1.2rem; font: inherit; color: #fff; background: var(--button); border: 1px solid var(--button);
           border-radius: 999px; cursor: pointer; transition: background 160ms ease; }}
  button:hover {{ background: #343a32; }}
  button:focus-visible {{ outline: 2px solid var(--ring); outline-offset: 4px; }}
  button.secondary {{ color: var(--ink); background: transparent; border-color: var(--border); min-height: 40px; padding: 0 16px; margin-top: 0; }}
  button.secondary:hover {{ background: var(--surface); }}
  button.danger {{ color: var(--negative); background: transparent; border-color: var(--negative); min-height: 40px; padding: 0 16px; margin-top: 0; }}
  button.danger:hover {{ background: var(--negative-surface); }}
  form.inline {{ display: inline; }}
  .card {{ border: 1px solid var(--border); border-radius: 14px; padding: 14px 16px; margin: 12px 0; background: #fff; }}
  .row {{ display: flex; justify-content: space-between; gap: 8px; align-items: baseline; flex-wrap: wrap; }}
  .chip {{ font-size: .75rem; font-weight: 600; border-radius: 999px; padding: 2px 10px; }}
  .c-ARMED {{ background: var(--positive-surface); color: var(--positive); }}
  .c-PAUSED {{ background: var(--select); color: var(--ink); }}
  .c-ERROR {{ background: var(--negative-surface); color: var(--negative); }}
  .c-EXPIRED, .c-CANCELLED {{ background: var(--surface); color: var(--muted); }}
  .fires {{ font-size: .82rem; color: var(--muted); margin-top: 6px; }}
</style></head><body><main>
<a class="brand" href="{home}">{logomark}<span><span class="slash" aria-hidden="true">/</span>markets</span></a>
{body}
</main></body></html>"""


def shell(title: str, body: str, home: str, *, wide: bool = False) -> str:
    """Wrap page `body` in the /markets chrome. `wide` is for list pages (watchers)."""
    return _SHELL.format(
        title=html.escape(title),
        body=body,
        home=html.escape(home),
        logomark=_LOGOMARK,
        slash=_SLASH_DATA,
        mono=MONO,
        width="44rem" if wide else "28rem",
        vmargin="6vh" if wide else "10vh",
    )


def error_box(message: str) -> str:
    return f'<p class="err">{html.escape(message)}</p>'


def hidden(name: str, value: str) -> str:
    return f'<input type="hidden" name="{html.escape(name)}" value="{html.escape(value)}">'


def email_form(action: str, title: str, sub: str, notice: str = "", hidden_fields: str = "") -> str:
    return (
        f"<h1>{html.escape(title)}</h1><p class='meta'>{html.escape(sub)}</p>{notice}"
        f'<form method="post" action="{html.escape(action)}">{hidden_fields}'
        '<label for="email">Email</label>'
        '<input id="email" name="email" type="email" autocomplete="email" autofocus required>'
        '<button type="submit">Send code</button></form>'
    )


def otp_form(action: str, email: str, notice: str = "", hidden_fields: str = "") -> str:
    return (
        "<h1>Enter your login code</h1>"
        f"<p class='meta'>Sent to {html.escape(email)}. It expires in 10 minutes.</p>{notice}"
        f'<form method="post" action="{html.escape(action)}">{hidden_fields}'
        f'<input type="hidden" name="email" value="{html.escape(email)}">'
        '<label for="code">6-digit code</label>'
        '<input id="code" name="code" inputmode="numeric" pattern="[0-9]*" '
        'autocomplete="one-time-code" autofocus required>'
        '<button type="submit">Sign in</button></form>'
    )


# ---------------------------------------------------------------------------
# Emails (HTML + plain-text twin)
# ---------------------------------------------------------------------------

_LOGOMARK_EMAIL = (
    '<svg xmlns="http://www.w3.org/2000/svg" width="62" height="32" viewBox="0 0 341 174" '
    f'fill="#34432e" role="img" aria-label="/markets">{LOGOMARK_PATHS}</svg>'
)
READ_ONLY = "/markets is read-only. It can never place, change or cancel an order."


@dataclass(frozen=True)
class Email:
    subject: str
    html: str
    text: str

    def resend_fields(self) -> dict[str, str]:
        return {"subject": self.subject, "html": self.html, "text": self.text}


def _wordmark() -> str:
    return (
        f'<span style="font-family:{SANS};font-size:18px;font-weight:600;color:{INK};'
        'letter-spacing:-.01em">/markets</span>'
    )


def _button(label: str, href: str) -> str:
    return (
        f'<a href="{html.escape(href)}" style="display:inline-block;min-height:48px;line-height:48px;'
        f"padding:0 24px;border-radius:999px;background:{BUTTON};color:#ffffff;font-family:{SANS};"
        f'font-size:16px;text-decoration:none">{html.escape(label)}</a>'
    )


def _email_shell(preheader: str, headline: str, body: str, footer: str) -> str:
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<meta name="color-scheme" content="light"><title>{html.escape(headline)}</title></head>
<body style="margin:0;padding:0;background:#ffffff;color:{INK}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">{html.escape(preheader)}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#ffffff">
<tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:520px">
<tr><td style="padding:0 0 28px">
  <table role="presentation" cellspacing="0" cellpadding="0"><tr>
    <td style="padding-right:10px;vertical-align:middle">{_LOGOMARK_EMAIL}</td>
    <td style="vertical-align:middle">{_wordmark()}</td>
  </tr></table>
</td></tr>
<tr><td style="padding:0 0 12px;font-family:{SERIF};font-size:30px;line-height:1.2;font-weight:500;letter-spacing:-.02em;color:{INK}">{headline}</td></tr>
<tr><td style="font-family:{SANS};font-size:16px;line-height:1.65;color:{INK}">{body}</td></tr>
<tr><td style="padding:32px 0 0;border-top:1px solid {BORDER};font-family:{SANS};font-size:13px;line-height:1.6;color:{MUTED}">{footer}</td></tr>
</table></td></tr></table></body></html>"""


def _p(text: str) -> str:
    return f'<p style="margin:0 0 16px">{text}</p>'


def _muted(text: str) -> str:
    return f'<p style="margin:0 0 16px;color:{MUTED}">{text}</p>'


def login_code(code: str) -> Email:
    code_html = (
        f'<div style="margin:8px 0 24px;padding:20px 24px;border-radius:14px;background:{SURFACE};'
        f"font-family:{MONO};font-size:34px;letter-spacing:.32em;color:{INK};text-align:center"
        f'">{html.escape(code)}</div>'
    )
    body = (
        _p("Enter this code to sign in. It expires in 10 minutes.")
        + code_html
        + _muted("If you didn't request it, ignore this email. Nobody can use the code without your inbox.")
    )
    return Email(
        subject=f"{code} is your /markets login code",
        html=_email_shell(f"Your login code is {code}", "Your login code", body, READ_ONLY),
        text=(
            f"Your /markets login code is {code}. It expires in 10 minutes.\n\n"
            "If you didn't request it, ignore this email.\n\n" + READ_ONLY
        ),
    )


def watcher_alert(
    symbol: str, label: str, value: str | None, detail: str | None, when: str, page_url: str
) -> Email:
    rows = [("Condition", label)]
    if value is not None:
        rows.append(("Value", value))
    if detail:
        rows.append(("Detail", detail))
    rows.append(("Time", when))
    table = "".join(
        f'<tr><td style="padding:6px 12px 6px 0;color:{MUTED};white-space:nowrap;vertical-align:top">'
        f'{html.escape(k)}</td><td style="padding:6px 0;font-family:{MONO if k == "Value" else SANS}">'
        f"{html.escape(v)}</td></tr>"
        for k, v in rows
    )
    body = (
        _p(
            f'<span style="display:inline-block;padding:2px 8px;border-radius:6px;background:{SELECT}">'
            f"{html.escape(symbol)}</span> crossed the line you asked your AI to watch."
        )
        + f'<table role="presentation" cellspacing="0" cellpadding="0" style="margin:0 0 24px;font-size:16px">{table}</table>'
        + _p(_button("Manage watchers", page_url))
    )
    footer = "/markets is read-only; it can never trade. This watcher alerts again only after the condition resets."
    text_rows = "\n".join(f"{k}: {v}" for k, v in rows)
    return Email(
        subject=f"⚡ {symbol}: {label}",
        html=_email_shell(f"{symbol}: {label}", f"{html.escape(symbol)} just triggered.", body, footer),
        text=f"Your watcher on {symbol} just triggered.\n\n{text_rows}\n\nManage your watchers: {page_url}\n\n{footer}",
    )


def watchers_paused(message: str, page_url: str) -> Email:
    body = (
        _p("Your Dhan access token expired (Dhan tokens last 24 hours), so your /markets watchers can't check the market.")
        + _p(html.escape(message))
        + _p(_button("Open watchers", page_url))
        + _muted("Reconnect Dhan in the /markets app, then resume each watcher from this page.")
    )
    footer = "/markets is read-only; it can never trade."
    return Email(
        subject="/markets watchers paused: reconnect Dhan",
        html=_email_shell("Your watchers are paused; reconnect Dhan", "Reconnect Dhan.", body, footer),
        text=f"Your Dhan token expired, so your watchers can't check the market.\n\n{message}\n\n{page_url}\n\n{footer}",
    )
