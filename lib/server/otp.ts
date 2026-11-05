import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { db } from '@/agent/lib/db/client';
import { otps, users } from '@/agent/lib/db/schema';
import { otpHash } from '@/agent/lib/db/crypto';
import { HttpError } from './auth';
import { EMAIL_FROM, loginCodeEmail } from './emails';

/**
 * Email OTP login (/markets semantics): 6-digit code, 10-minute life, single
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
      from: EMAIL_FROM,
      to: [email],
      ...loginCodeEmail(code),
    }),
  });
  if (!res.ok) {
    console.error('[otp] Resend send failed:', res.status, await res.text().catch(() => ''));
    throw new HttpError(502, 'Could not send the login code — try again.');
  }
}
