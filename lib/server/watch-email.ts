import { EMAIL_FROM, watchAlertEmail, watchPausedEmail } from './emails';

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
        from: EMAIL_FROM,
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

const appUrl = () => process.env.APP_BASE_URL || 'https://zap-eve.vercel.app';

export function alertEmail(
  symbol: string,
  headline: string,
  summary: string,
  instruction: string,
): { subject: string; text: string; html: string } {
  return watchAlertEmail({ symbol, headline, summary, instruction, appUrl: appUrl() });
}

export function reconnectEmail(symbol: string): { subject: string; text: string; html: string } {
  return watchPausedEmail(symbol, appUrl());
}
