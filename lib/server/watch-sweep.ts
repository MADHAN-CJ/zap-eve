import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { db } from '@/agent/lib/db/client';
import { users, watches, type WatchRow } from '@/agent/lib/db/schema';
import { getActiveBrokerCreds, markTokenExpired } from '@/agent/lib/db/broker';
import { dhan, DhanError, type Candle, type DhanCreds } from '@/agent/lib/dhan/client';
import { isDataApiSubscriptionError } from '@/agent/lib/dhan/shared';
import { evaluateWatch } from '@/agent/lib/watch/evaluate';
import type { WatchValues } from '@/agent/lib/watch/types';
import { dropFormingBar, fetchDhanCandles, type CandleInterval } from './candles';
import { isNseMarketOpen } from './market-hours';
import { reconnectEmail, sendWatchEmail } from './watch-email';

/**
 * The watch sweeper (docs/plan-watcher.md P3). Driven by an external ticker
 * hitting POST /api/watch/sweep ~every minute; this module owns everything
 * between "tick" and "fire": expiry, market-hours gate, per-user isolation,
 * grouped candle fetches, pure-math evaluation, guards, and the atomic fire
 * claim. Firing itself (continue the eve thread → verdict → alert email) is
 * injected as `fire` so the sweep is testable without an eve runtime.
 *
 * Guard invariants (learned in zap-api 12b):
 * - One user's failure (creds, Dhan, bugs) never aborts other users' sweeps.
 * - A deferred or failed fire NEVER burns the level: lastValues/latched are
 *   persisted only after a successful fire (or a quiet no-fire evaluation),
 *   so the next sweep re-detects the same cross.
 * - Poller-side Dhan auth failures judge the TOKEN via a funds probe first —
 *   Data-API 401s happen on live tokens (Dhan error 806 is its own case).
 */

const MIN_GAP_MINUTES = () => Number(process.env.WATCH_MIN_GAP_MINUTES || 15);
/** A fire claim older than this is a crashed run — reclaimable. */
const STALE_CLAIM_MINUTES = 20;

export interface FirePayload {
  watch: WatchRow;
  reason: 'levels' | 'ai_check';
  /** levels: which condition indexes tripped. */
  firedConditions: number[];
  /** levels: metric values at the tripping sweep. */
  values: WatchValues;
}

/** Resolves when the trigger has been fully handled (turn done, email decided). */
export type FireFn = (payload: FirePayload) => Promise<void>;

export interface SweepReport {
  ranAt: string;
  marketOpen: boolean;
  expired: number;
  staleClaimsCleared: number;
  checked: number;
  fired: number;
  deferred: number;
  erroredWatches: number;
  usersSkipped: number;
  notes: string[];
}

export async function sweepWatches(opts: {
  fire: FireFn;
  now?: Date;
  /** Test hook: skip the market-hours gate. */
  force?: boolean;
}): Promise<SweepReport> {
  const now = opts.now ?? new Date();
  const report: SweepReport = {
    ranAt: now.toISOString(),
    marketOpen: isNseMarketOpen(now),
    expired: 0,
    staleClaimsCleared: 0,
    checked: 0,
    fired: 0,
    deferred: 0,
    erroredWatches: 0,
    usersSkipped: 0,
    notes: [],
  };
  if (!report.marketOpen && !opts.force) return report;

  // Expiry applies to armed AND paused watches; no email (W8).
  const expired = await db()
    .update(watches)
    .set({ status: 'EXPIRED', updatedAt: now })
    .where(and(inArray(watches.status, ['ARMED', 'PAUSED']), lt(watches.expiresAt, now)))
    .returning({ id: watches.id });
  report.expired = expired.length;

  // Reclaim crashed fire claims so their watches sweep again.
  const stale = await db()
    .update(watches)
    .set({ firingAt: null, updatedAt: now })
    .where(and(eq(watches.status, 'ARMED'), lt(watches.firingAt, new Date(now.getTime() - STALE_CLAIM_MINUTES * 60000))))
    .returning({ id: watches.id });
  report.staleClaimsCleared = stale.length;

  const armed = await db().query.watches.findMany({
    where: and(eq(watches.status, 'ARMED'), isNull(watches.firingAt)),
  });
  if (armed.length === 0) return report;

  const byUser = new Map<string, WatchRow[]>();
  for (const w of armed) {
    const list = byUser.get(w.userId) ?? [];
    list.push(w);
    byUser.set(w.userId, list);
  }

  for (const [userId, userWatches] of byUser) {
    try {
      await sweepUser(userId, userWatches, now, opts.fire, report);
    } catch (e) {
      report.usersSkipped++;
      report.notes.push(`user ${userId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return report;
}

async function sweepUser(
  userId: string,
  userWatches: WatchRow[],
  now: Date,
  fire: FireFn,
  report: SweepReport,
): Promise<void> {
  const creds = await getActiveBrokerCreds(userId);
  if (creds.status === 'error') {
    report.usersSkipped++;
    report.notes.push(`user ${userId}: creds lookup failed — skipped`);
    return;
  }
  if (creds.status === 'none') {
    // Broker gone → watches can't work. ERROR them once; email only for expiry
    // (a deliberate disconnect needs no mail).
    await errorWatches(
      userWatches.map((w) => w.id),
      creds.reason === 'token_expired'
        ? 'Dhan token expired — reconnect Dhan, then resume this watch.'
        : 'Dhan is not connected — reconnect, then resume this watch.',
      now,
    );
    report.erroredWatches += userWatches.length;
    if (creds.reason === 'token_expired') await emailReconnect(userId, userWatches[0]);
    return;
  }

  // One candle fetch per (instrument, interval); every watch in the group
  // shares it.
  const groups = new Map<string, WatchRow[]>();
  for (const w of userWatches) {
    const key = `${w.securityId}:${w.exchangeSegment}:${w.interval}`;
    const list = groups.get(key) ?? [];
    list.push(w);
    groups.set(key, list);
  }

  for (const group of groups.values()) {
    const sample = group[0];
    const levelWatches = group.filter((w) => w.kind === 'levels');

    let candles: Candle[] | null = null;
    if (levelWatches.length > 0) {
      try {
        candles = dropFormingBar(
          await fetchDhanCandles(
            creds.creds,
            { securityId: sample.securityId, exchangeSegment: sample.exchangeSegment, symbol: sample.symbol, productType: '' },
            sample.interval as CandleInterval,
            undefined,
            now,
          ),
          sample.interval as CandleInterval,
          now,
        );
      } catch (e) {
        await handleFetchError(e, userId, levelWatches, now, report);
        candles = null;
      }
    }

    for (const w of group) {
      if (w.kind === 'ai_check') {
        await sweepAiCheck(w, now, fire, report);
      } else if (candles && candles.length > 0) {
        await sweepLevels(w, candles, now, fire, report);
      }
    }
  }
}

async function sweepLevels(
  w: WatchRow,
  candles: Candle[],
  now: Date,
  fire: FireFn,
  report: SweepReport,
): Promise<void> {
  // Min-gap: too soon after the last fire → skip WITHOUT evaluating, so the
  // stale lastValues still detect the cross on the next allowed sweep.
  if (w.lastFiredAt && now.getTime() - w.lastFiredAt.getTime() < MIN_GAP_MINUTES() * 60000) {
    report.deferred++;
    return;
  }

  const result = evaluateWatch({
    conditions: w.conditions ?? [],
    mode: w.mode,
    candles,
    lastValues: w.lastValues,
    latched: w.latched,
  });
  report.checked++;

  if (!result.fired) {
    await db()
      .update(watches)
      .set({ lastValues: result.values, latched: result.latched, lastCheckedAt: now, updatedAt: now })
      .where(and(eq(watches.id, w.id), eq(watches.status, 'ARMED')))
      .catch((e) => report.notes.push(`watch ${w.id}: state write failed: ${e?.message}`));
    return;
  }

  const claimed = await claimFire(w.id, now);
  if (!claimed) return; // concurrent sweep won the claim
  try {
    await fire({ watch: w, reason: 'levels', firedConditions: result.firedConditions, values: result.values });
    report.fired++;
    await db()
      .update(watches)
      .set({
        lastValues: result.values,
        latched: result.latched,
        lastCheckedAt: now,
        lastFiredAt: now,
        firingAt: null,
        updatedAt: now,
      })
      .where(eq(watches.id, w.id));
  } catch (e) {
    // Fire failed → release the claim and persist NOTHING: the stale
    // lastValues make the next sweep re-detect the same cross (never burnt).
    report.notes.push(`watch ${w.id}: fire failed: ${e instanceof Error ? e.message : String(e)}`);
    await db().update(watches).set({ firingAt: null, updatedAt: now }).where(eq(watches.id, w.id));
  }
}

async function sweepAiCheck(w: WatchRow, now: Date, fire: FireFn, report: SweepReport): Promise<void> {
  const cadenceMs = (w.checkIntervalMinutes ?? 30) * 60000;
  const due = !w.lastCheckedAt || now.getTime() - w.lastCheckedAt.getTime() >= cadenceMs;
  if (!due) return;
  const claimed = await claimFire(w.id, now);
  if (!claimed) return;
  report.checked++;
  try {
    await fire({ watch: w, reason: 'ai_check', firedConditions: [], values: {} });
    report.fired++;
    await db()
      .update(watches)
      .set({ lastCheckedAt: now, lastFiredAt: now, firingAt: null, updatedAt: now })
      .where(eq(watches.id, w.id));
  } catch (e) {
    report.notes.push(`watch ${w.id}: ai_check fire failed: ${e instanceof Error ? e.message : String(e)}`);
    // Release the claim but still stamp lastCheckedAt: a broken fire path must
    // not retry every minute — it retries next cadence.
    await db()
      .update(watches)
      .set({ lastCheckedAt: now, firingAt: null, updatedAt: now })
      .where(eq(watches.id, w.id));
  }
}

/** Atomic ARMED+unclaimed → claimed transition; exactly one caller wins. */
async function claimFire(watchId: string, now: Date): Promise<boolean> {
  const rows = await db()
    .update(watches)
    .set({ firingAt: now, updatedAt: now })
    .where(and(eq(watches.id, watchId), eq(watches.status, 'ARMED'), isNull(watches.firingAt)))
    .returning({ id: watches.id });
  return rows.length === 1;
}

async function errorWatches(ids: string[], message: string, now: Date): Promise<void> {
  if (ids.length === 0) return;
  await db()
    .update(watches)
    .set({ status: 'ERROR', errorMessage: message, firingAt: null, updatedAt: now })
    .where(inArray(watches.id, ids));
}

async function emailReconnect(userId: string, sample: WatchRow): Promise<void> {
  const user = await db().query.users.findFirst({ columns: { email: true }, where: eq(users.id, userId) });
  if (!user) return;
  const mail = reconnectEmail(sample.symbol);
  await sendWatchEmail({ to: user.email, ...mail });
}

/**
 * Candle-fetch failure for one (instrument, interval) group. 806 → the
 * subscription lapsed: ERROR the group with a clear message. Other auth
 * errors → probe the token with a funds call; dead → mark connection expired,
 * ERROR the group, email once. Anything else (or a live token) → transient:
 * leave the group armed and untouched for the next sweep.
 */
async function handleFetchError(
  e: unknown,
  userId: string,
  group: WatchRow[],
  now: Date,
  report: SweepReport,
): Promise<void> {
  const ids = group.map((w) => w.id);
  if (e instanceof DhanError && isDataApiSubscriptionError(e)) {
    await errorWatches(ids, 'Dhan Data-API subscription missing (error 806) — candles need it. Resubscribe on dhan.co, then resume.', now);
    report.erroredWatches += ids.length;
    return;
  }
  if (e instanceof DhanError && (e.status === 401 || e.status === 403)) {
    const alive = await tokenAlive(userId);
    if (!alive) {
      await markTokenExpired(userId);
      await errorWatches(ids, 'Dhan token expired — reconnect Dhan, then resume this watch.', now);
      report.erroredWatches += ids.length;
      await emailReconnect(userId, group[0]);
      return;
    }
  }
  report.notes.push(
    `user ${userId} ${group[0].securityId}@${group[0].interval}: candle fetch failed (transient): ${e instanceof Error ? e.message : String(e)}`,
  );
}

async function tokenAlive(userId: string): Promise<boolean> {
  try {
    const creds = await getActiveBrokerCreds(userId);
    if (creds.status !== 'found') return false;
    await dhan.getFundLimit(creds.creds);
    return true;
  } catch {
    return false;
  }
}
