import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { threads, watches, type WatchRow } from '../db/schema';
import type { WatchCondition, WatchKind, WatchMode } from './types';

/**
 * Watch row operations shared by the agent tools (create/list/cancel/pause),
 * the dashboard REST (P5) and the sweeper (P3). Chat never implicitly mutates
 * a watch (W10) — every mutation here corresponds to an explicit user action.
 */

export const WATCH_CAP = 10; // max ARMED per user (W8)
export const WATCH_EXPIRY_DAYS = 10; // hard stop (W8)
export const AI_CHECK_DEFAULT_MINUTES = 30;
export const AI_CHECK_MIN_MINUTES = 15;
export const AI_CHECK_MAX_MINUTES = 120;

export interface CreateWatchInput {
  userId: string;
  eveSessionId: string;
  securityId: string;
  exchangeSegment: string;
  symbol: string;
  interval: string;
  instruction: string;
  kind: WatchKind;
  conditions: WatchCondition[] | null;
  mode: WatchMode;
  checkIntervalMinutes: number | null;
}

export type CreateWatchResult =
  | { status: 'ok'; watch: WatchRow }
  | { status: 'error'; message: string };

export async function createWatch(input: CreateWatchInput): Promise<CreateWatchResult> {
  if (input.kind === 'levels' && (!input.conditions || input.conditions.length === 0)) {
    return { status: 'error', message: 'A levels watch needs at least one condition.' };
  }
  if (input.kind === 'ai_check' && input.conditions && input.conditions.length > 0) {
    return { status: 'error', message: 'An ai_check watch must not carry numeric conditions.' };
  }

  const thread = await db().query.threads.findFirst({
    columns: { id: true },
    where: eq(threads.eveSessionId, input.eveSessionId),
  });
  if (!thread) return { status: 'error', message: 'This chat has no thread row yet — retry in a moment.' };

  const [{ armed }] = await db()
    .select({ armed: sql<number>`count(*)::int` })
    .from(watches)
    .where(and(eq(watches.userId, input.userId), eq(watches.status, 'ARMED')));
  if (armed >= WATCH_CAP) {
    return {
      status: 'error',
      message: `The user already has ${armed} active watches (limit ${WATCH_CAP}). Ask them which one to cancel first.`,
    };
  }

  const [row] = await db()
    .insert(watches)
    .values({
      userId: input.userId,
      threadId: thread.id,
      eveSessionId: input.eveSessionId,
      securityId: input.securityId,
      exchangeSegment: input.exchangeSegment,
      symbol: input.symbol,
      interval: input.interval,
      instruction: input.instruction,
      kind: input.kind,
      conditions: input.kind === 'levels' ? input.conditions : null,
      mode: input.mode,
      checkIntervalMinutes: input.kind === 'ai_check' ? (input.checkIntervalMinutes ?? AI_CHECK_DEFAULT_MINUTES) : null,
      expiresAt: new Date(Date.now() + WATCH_EXPIRY_DAYS * 24 * 3600 * 1000),
    })
    .returning();
  return { status: 'ok', watch: row };
}

export async function listWatches(userId: string): Promise<WatchRow[]> {
  return db().query.watches.findMany({
    where: eq(watches.userId, userId),
    orderBy: [desc(watches.createdAt)],
    limit: 50,
  });
}

export async function listWatchesForThread(userId: string, threadId: string): Promise<WatchRow[]> {
  return db().query.watches.findMany({
    where: and(eq(watches.userId, userId), eq(watches.threadId, threadId)),
    orderBy: [desc(watches.createdAt)],
  });
}

export type MutateWatchResult =
  | { status: 'ok'; watch: WatchRow }
  | { status: 'error'; message: string };

/** Ownership-checked status transition helper. */
async function transition(
  userId: string,
  watchId: string,
  allowedFrom: readonly string[],
  to: 'CANCELLED' | 'PAUSED' | 'ARMED',
  extra: Partial<typeof watches.$inferInsert> = {},
): Promise<MutateWatchResult> {
  const row = await db().query.watches.findFirst({
    where: and(eq(watches.id, watchId), eq(watches.userId, userId)),
  });
  if (!row) return { status: 'error', message: 'No such watch for this user.' };
  if (!allowedFrom.includes(row.status)) {
    return { status: 'error', message: `Watch is ${row.status} — cannot move it to ${to}.` };
  }
  const [updated] = await db()
    .update(watches)
    .set({ status: to, updatedAt: new Date(), ...extra })
    .where(and(eq(watches.id, watchId), eq(watches.userId, userId)))
    .returning();
  return { status: 'ok', watch: updated };
}

export function cancelWatch(userId: string, watchId: string): Promise<MutateWatchResult> {
  return transition(userId, watchId, ['ARMED', 'PAUSED', 'ERROR'], 'CANCELLED');
}

export function pauseWatch(userId: string, watchId: string): Promise<MutateWatchResult> {
  return transition(userId, watchId, ['ARMED'], 'PAUSED');
}

/**
 * Resume re-baselines: lastValues/latched reset so the first sweep after
 * resume records fresh state instead of judging crosses against stale values.
 * ERROR is resumable too (e.g. after the user reconnected Dhan).
 */
export function resumeWatch(userId: string, watchId: string): Promise<MutateWatchResult> {
  return transition(userId, watchId, ['PAUSED', 'ERROR'], 'ARMED', {
    lastValues: null,
    latched: null,
    errorMessage: null,
  });
}

/** Public summary shape returned by the tools (never the raw row). */
export function watchSummary(w: WatchRow) {
  return {
    id: w.id,
    threadId: w.threadId,
    symbol: w.symbol,
    exchangeSegment: w.exchangeSegment,
    interval: w.interval,
    kind: w.kind,
    status: w.status,
    mode: w.mode,
    conditions: w.conditions ?? undefined,
    checkIntervalMinutes: w.checkIntervalMinutes ?? undefined,
    instruction: w.instruction,
    lastCheckedAt: w.lastCheckedAt?.toISOString(),
    lastFiredAt: w.lastFiredAt?.toISOString(),
    lastAlertAt: w.lastAlertAt?.toISOString(),
    expiresAt: w.expiresAt.toISOString(),
    createdAt: w.createdAt.toISOString(),
    errorMessage: w.errorMessage ?? undefined,
  };
}
