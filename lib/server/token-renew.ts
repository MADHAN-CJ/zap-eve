import { eq } from 'drizzle-orm';
import { db } from '@/agent/lib/db/client';
import { users } from '@/agent/lib/db/schema';
import {
  breakRenewalChain,
  claimDueForRenewal,
  recordRenewFailure,
  storeRenewedToken,
  type RenewClaim,
} from '@/agent/lib/db/broker';
import { dhan, DhanError, type DhanCreds, type RenewTokenResponse } from '@/agent/lib/dhan/client';
import { brokerReconnectEmail } from './emails';
import { sendWatchEmail } from './watch-email';

/**
 * Dhan token auto-renewal sweep (docs/plan-token-renewal.md). Driven by an
 * external ticker hitting POST /api/broker/renew-sweep every few minutes.
 * No queue, no in-memory jobs: `renew_after` in Postgres is the only state, so
 * a missed tick is simply picked up by the next one.
 *
 * Per row: atomic claim → GET /RenewToken with the live token → store the new
 * token (old one is dead at Dhan the moment the new one exists). Dhan refusing
 * (revoked, invalid, already expired) breaks the chain: row → token_expired +
 * ONE reconnect email; the app then waits for the user exactly as before.
 * Network/5xx is transient: counted, row stays active and due, retried next
 * tick after the claim window — unless the token died meanwhile, which also
 * breaks the chain.
 *
 * Deliberately NOT wrapped in a transaction: a rollback after Dhan has issued
 * the new token would keep the (now dead) old token in the DB.
 */

export interface RenewReport {
  ranAt: string;
  claimed: number;
  renewed: number;
  transientFailures: number;
  chainsBroken: number;
  notes: string[];
}

export type RenewFn = (creds: DhanCreds) => Promise<RenewTokenResponse>;

const isRefusal = (e: unknown) => e instanceof DhanError && [400, 401, 403].includes(e.status);

export async function renewDueTokens(opts: { now?: Date; renew?: RenewFn } = {}): Promise<RenewReport> {
  const now = opts.now ?? new Date();
  const renew = opts.renew ?? dhan.renewToken;
  const report: RenewReport = { ranAt: now.toISOString(), claimed: 0, renewed: 0, transientFailures: 0, chainsBroken: 0, notes: [] };
  const claims = await claimDueForRenewal(now);
  report.claimed = claims.length;
  for (const claim of claims) {
    try {
      await renewOne(claim, renew, now, report);
    } catch (e) {
      // One user's surprise never aborts the others.
      report.notes.push(`user ${claim.userId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return report;
}

async function renewOne(claim: RenewClaim, renew: RenewFn, now: Date, report: RenewReport): Promise<void> {
  let res: RenewTokenResponse;
  try {
    res = await renew({ dhanClientId: claim.dhanClientId, accessToken: claim.accessToken });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (isRefusal(e)) {
      await breakChain(claim, `Dhan refused to renew the token (revoked, invalid or already expired): ${msg}`, report);
      return;
    }
    if (claim.tokenExpiresAt && claim.tokenExpiresAt.getTime() <= now.getTime()) {
      await breakChain(claim, `The token expired before it could be renewed (last error: ${msg})`, report);
      return;
    }
    await recordRenewFailure(claim.id, msg);
    report.transientFailures++;
    report.notes.push(`user ${claim.userId}: transient renew failure, will retry: ${msg}`);
    return;
  }
  const token = typeof res.token === 'string' ? res.token.trim() : '';
  if (!token) {
    await recordRenewFailure(claim.id, 'Dhan returned no token from RenewToken');
    report.transientFailures++;
    report.notes.push(`user ${claim.userId}: RenewToken returned no token`);
    return;
  }
  const hint = res.expiryTime ? parseDhanTime(res.expiryTime) : null;
  await storeRenewedToken(claim.id, token, hint, now);
  report.renewed++;
}

async function breakChain(claim: RenewClaim, reason: string, report: RenewReport): Promise<void> {
  await breakRenewalChain(claim.id, reason);
  report.chainsBroken++;
  report.notes.push(`user ${claim.userId}: chain broken — ${reason}`);
  try {
    const user = await db().query.users.findFirst({ columns: { email: true }, where: eq(users.id, claim.userId) });
    if (user) {
      const appUrl = process.env.APP_BASE_URL || 'https://dhan-test.slash.markets';
      await sendWatchEmail({ to: user.email, ...brokerReconnectEmail(reason, appUrl) });
    }
  } catch (e) {
    report.notes.push(`user ${claim.userId}: reconnect email failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Dhan timestamps are naive IST ("2026-11-06T16:50:50.225"); a JWT `exp` on the token wins anyway. */
function parseDhanTime(s: string): Date | null {
  const d = new Date(/[zZ]|[+-]\d\d:\d\d$/.test(s) ? s : `${s}+05:30`);
  return Number.isNaN(d.getTime()) ? null : d;
}
