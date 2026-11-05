import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Transactional emails in the /markets brand: HTML plus a plain-text twin.
 * Shared shell with zap-kite-mcp/lib/server/emails.ts — keep the two in sync.
 */

const INK = '#20251b';
const MUTED = '#62675f';
const SURFACE = '#f7f6f2';
const BORDER = '#e4e7dc';
const SELECT = '#f6d64d';
const BUTTON = '#171a17';
const SERIF = "'Libre Baskerville', Georgia, 'Times New Roman', serif";
const SANS = "Onest, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif";
const MONO = "'Departure Mono', ui-monospace, Menlo, Consolas, monospace";

/** Sender for every /markets email. Must stay on a Resend-verified domain. */
export const EMAIL_FROM =
  process.env.EMAIL_FROM || process.env.OTP_FROM_EMAIL || '/markets <login-link@codeongrass.com>';

export interface Email {
  subject: string;
  html: string;
  text: string;
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

let logomarkPaths: string | null = null;
function logomark(): string {
  if (logomarkPaths === null) {
    try {
      const svg = readFileSync(path.join(process.cwd(), 'public/brand/markets-logomark-mono.svg'), 'utf8');
      logomarkPaths = (svg.match(/<path[^>]*\/>/g) ?? []).join('');
    } catch {
      logomarkPaths = '';
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="62" height="32" viewBox="0 0 341 174" fill="#34432e" role="img" aria-label="/markets">${logomarkPaths}</svg>`;
}

function shell(preheader: string, headline: string, body: string, footer: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<meta name="color-scheme" content="light"><title>${esc(headline)}</title></head>
<body style="margin:0;padding:0;background:#ffffff;color:${INK}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preheader)}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#ffffff">
<tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:520px">
<tr><td style="padding:0 0 28px">
  <table role="presentation" cellspacing="0" cellpadding="0"><tr>
    <td style="padding-right:10px;vertical-align:middle">${logomark()}</td>
    <td style="vertical-align:middle"><span style="font-family:${SANS};font-size:18px;font-weight:600;color:${INK};letter-spacing:-.01em">/markets</span></td>
  </tr></table>
</td></tr>
<tr><td style="padding:0 0 12px;font-family:${SERIF};font-size:30px;line-height:1.2;font-weight:500;letter-spacing:-.02em;color:${INK}">${headline}</td></tr>
<tr><td style="font-family:${SANS};font-size:16px;line-height:1.65;color:${INK}">${body}</td></tr>
<tr><td style="padding:32px 0 0;border-top:1px solid ${BORDER};font-family:${SANS};font-size:13px;line-height:1.6;color:${MUTED}">${footer}</td></tr>
</table></td></tr></table></body></html>`;
}

const p = (text: string) => `<p style="margin:0 0 16px">${text}</p>`;
const muted = (text: string) => `<p style="margin:0 0 16px;color:${MUTED}">${text}</p>`;
const button = (label: string, href: string) =>
  `<a href="${esc(href)}" style="display:inline-block;min-height:48px;line-height:48px;padding:0 24px;border-radius:999px;background:${BUTTON};color:#ffffff;font-family:${SANS};font-size:16px;text-decoration:none">${esc(label)}</a>`;

const READ_ONLY = '/markets is read-only. It can never place, change or cancel an order.';

export function loginCodeEmail(code: string): Email {
  const codeHtml = `<div style="margin:8px 0 24px;padding:20px 24px;border-radius:14px;background:${SURFACE};font-family:${MONO};font-size:34px;letter-spacing:.32em;color:${INK};text-align:center">${esc(code)}</div>`;
  const body =
    p('Enter this code to sign in. It expires in 10 minutes.') +
    codeHtml +
    muted("If you didn't request it, ignore this email. Nobody can use the code without your inbox.");
  return {
    subject: `${code} is your /markets login code`,
    html: shell(`Your login code is ${code}`, 'Your login code', body, READ_ONLY),
    text:
      `Your /markets login code is ${code}. It expires in 10 minutes.\n\n` +
      "If you didn't request it, ignore this email.\n\n" +
      READ_ONLY,
  };
}

/** A market watch fired: the agent's headline + summary, and a link back to the chat. */
export function watchAlertEmail(opts: {
  symbol: string;
  headline: string;
  summary: string;
  instruction: string;
  appUrl: string;
}): Email {
  const { symbol, headline, summary, instruction, appUrl } = opts;
  const body =
    p(
      `<span style="display:inline-block;padding:2px 8px;border-radius:6px;background:${SELECT}">${esc(symbol)}</span> crossed the line you asked your AI to watch.`,
    ) +
    p(esc(summary).replace(/\n/g, '<br>')) +
    muted(`You asked: &ldquo;${esc(instruction)}&rdquo;`) +
    p(button('Open the chat', appUrl));
  const footer =
    '/markets is read-only; it can never trade. This watch keeps alerting on new triggers until you cancel it (it expires 10 days after creation).';
  return {
    subject: `⚡ ${symbol}: ${headline}`,
    html: shell(`${symbol}: ${headline}`, `${esc(symbol)} just triggered.`, body, footer),
    text:
      `${summary}\n\nYou asked: "${instruction}"\n\n` +
      `The full analysis is in the watch's chat: ${appUrl}\n\n${footer}`,
  };
}

/** The Dhan token died, so the watch stopped checking. */
export function watchPausedEmail(symbol: string, appUrl: string): Email {
  const body =
    p(
      `Your /markets watch on <strong>${esc(symbol)}</strong> stopped because your Dhan access token expired (Dhan tokens last 24 hours).`,
    ) +
    p(button('Reconnect Dhan', appUrl)) +
    muted('Then resume the watch from its chat or the Watchers page.');
  const footer = '/markets is read-only; it can never trade.';
  return {
    subject: '/markets watch paused: reconnect Dhan',
    html: shell(`Your watch on ${symbol} is paused`, 'Reconnect Dhan.', body, footer),
    text:
      `Your /markets watch on ${symbol} stopped because your Dhan access token expired ` +
      `(Dhan tokens last 24 hours).\n\nReconnect Dhan from the broker screen, then resume ` +
      `the watch from its chat or the Watchers page:\n${appUrl}\n\n${footer}`,
  };
}
