/**
 * Watch-related emails via Resend (same verified sender as the OTP mail).
 * Failures log and return false — an email problem must never break a sweep.
 * RESEND_BASE_URL exists for the e2e stub only.
 */
export async function sendWatchEmail(opts: {
  to: string;
  subject: string;
  text: string;
  html?: string;
}): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn(`[watch] RESEND_API_KEY unset — would email ${opts.to}: ${opts.subject}`);
    return false;
  }
  const base = process.env.RESEND_BASE_URL || 'https://api.resend.com';
  try {
    const res = await fetch(`${base}/emails`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.OTP_FROM_EMAIL || 'Zap Trade <login-link@codeongrass.com>',
        to: [opts.to],
        subject: opts.subject,
        text: opts.text,
        ...(opts.html ? { html: opts.html } : {}),
      }),
    });
    if (!res.ok) {
      console.error('[watch] Resend send failed:', res.status, await res.text().catch(() => ''));
      return false;
    }
    return true;
  } catch (e) {
    console.error('[watch] Resend send threw:', e instanceof Error ? e.message : e);
    return false;
  }
}

export function alertEmail(
  symbol: string,
  headline: string,
  summary: string,
  instruction: string,
): { subject: string; text: string } {
  const app = process.env.APP_BASE_URL || 'https://zap-eve.vercel.app';
  return {
    subject: `⚡ Zap alert: ${symbol} — ${headline}`,
    text:
      `${summary}\n\nYou asked: "${instruction}"\n\n` +
      `The full analysis is in the watch's chat: ${app}\n\n` +
      `This watch keeps alerting on new triggers until you cancel it (it expires 10 days after creation).\n\n— Zap`,
  };
}

export function reconnectEmail(symbol: string): { subject: string; text: string } {
  return {
    subject: `Zap watch paused — reconnect Dhan`,
    text:
      `Your Zap market watch on ${symbol} stopped because your Dhan access token expired ` +
      `(Dhan tokens last 24 hours).\n\nReconnect Dhan from the broker screen, then resume ` +
      `the watch from its chat or the Watchers page.\n\n— Zap`,
  };
}
