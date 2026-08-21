import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { db } from '@/agent/lib/db/client';
import { otps, users } from '@/agent/lib/db/schema';
import { otpHash } from '@/agent/lib/db/crypto';
import { HttpError } from './auth';

/**
 * Email OTP login (zap-api semantics): 6-digit code, 10-minute life, single
 * use, cooldown between sends. Codes are stored hashed. Without a
 * RESEND_API_KEY the code is logged to the server console (dev only).
 * Test account: test@zaptrade.app always accepts 123456 (never emailed).
 */

const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_COOLDOWN_MS = Number(process.env.OTP_COOLDOWN_SECONDS ?? 30) * 1000;
const TEST_EMAIL = 'test@zaptrade.app';
const TEST_CODE = '123456';

const normalize = (email: string) => email.trim().toLowerCase();

export async function requestOtp(rawEmail: string): Promise<void> {
  const email = normalize(rawEmail);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Enter a valid email address.');
  if (email === TEST_EMAIL) return; // fixed code, nothing to send

  const recent = await db().query.otps.findFirst({
    where: and(eq(otps.email, email), gt(otps.createdAt, new Date(Date.now() - OTP_COOLDOWN_MS))),
  });
  if (recent) throw new HttpError(429, 'A code was just sent — wait a moment before requesting another.');

  const code = String(Math.floor(100000 + Math.random() * 900000));
  await db()
    .insert(otps)
    .values({ email, codeHash: otpHash(code, email), expiresAt: new Date(Date.now() + OTP_TTL_MS) });
  await sendOtpEmail(email, code);
}

export async function verifyOtp(rawEmail: string, code: string): Promise<{ userId: string; email: string }> {
  const email = normalize(rawEmail);
  const trimmed = code.trim();
  const valid =
    email === TEST_EMAIL
      ? trimmed === TEST_CODE
      : await consumeStoredOtp(email, trimmed);
  if (!valid) throw new HttpError(401, 'Invalid or expired code.');

  const [user] = await db()
    .insert(users)
    .values({ email })
    .onConflictDoUpdate({ target: users.email, set: { email } }) // no-op update to RETURNING the row
    .returning({ id: users.id, email: users.email });
  return { userId: user.id, email: user.email };
}

async function consumeStoredOtp(email: string, code: string): Promise<boolean> {
  const updated = await db()
    .update(otps)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(otps.email, email),
        eq(otps.codeHash, otpHash(code, email)),
        isNull(otps.consumedAt),
        gt(otps.expiresAt, sql`now()`),
      ),
    )
    .returning({ id: otps.id });
  return updated.length > 0;
}

function otpEmailHtml(code: string): string {
  return `<!DOCTYPE html>
<html>
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
  <body style="font-family: -apple-system, 'Segoe UI', Arial, sans-serif; line-height: 1.6; color: #14201a; background: #ffffff; max-width: 600px; margin: 0 auto; padding: 24px 20px;">
    <div style="background: #f4f7f5; border: 1px solid #e2e8e4; padding: 32px 24px; border-radius: 12px;">
      <div style="text-align: center; margin-bottom: 8px;">
        <span style="display: inline-block; background: #0c6b3d; color: #ffffff; border-radius: 10px; padding: 8px 12px; font-size: 18px; font-weight: 700;">&#9889; Zap</span>
      </div>
      <h1 style="text-align: center; font-size: 20px; margin: 12px 0 4px;">Your login code</h1>
      <p style="text-align: center; color: #6f7d75; font-size: 14px; margin: 0 0 24px;">Use this one-time code to sign in to Zap.</p>
      <div style="text-align: center; margin: 0 0 24px;">
        <span style="background: #0c6b3d; color: #ffffff; padding: 14px 22px; border-radius: 10px; font-size: 26px; letter-spacing: 8px; font-weight: 700;">${code}</span>
      </div>
      <p style="font-size: 12px; color: #6f7d75; text-align: center; margin: 0;">This code expires in 10 minutes. If you didn't request it, ignore this email.</p>
    </div>
    <p style="font-size: 11px; color: #6f7d75; text-align: center; margin: 16px 0 0;">Zap — chat with an analyst about your Dhan positions. Read-only: it can never trade.</p>
  </body>
</html>`;
}

async function sendOtpEmail(email: string, code: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn(`[otp] RESEND_API_KEY unset — login code for ${email}: ${code}`);
    return;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      // Sender must be on the Resend-verified domain (codeongrass.com).
      from: process.env.OTP_FROM_EMAIL || 'Zap Trade <login-link@codeongrass.com>',
      to: [email],
      subject: `${code} is your Zap login code`,
      text: `Your Zap login code is ${code}. It expires in 10 minutes.\n\nIf you didn't request it, ignore this email.`,
      html: otpEmailHtml(code),
    }),
  });
  if (!res.ok) {
    console.error('[otp] Resend send failed:', res.status, await res.text().catch(() => ''));
    throw new HttpError(502, 'Could not send the login code — try again.');
  }
}
