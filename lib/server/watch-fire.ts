import { eq } from 'drizzle-orm';
import { Client } from 'eve/client';
import { db } from '@/agent/lib/db/client';
import { threads, users, watches } from '@/agent/lib/db/schema';
import { upsertSessionContext } from '@/agent/lib/db/session-context';
import { buildTriggerMessage as formatTrigger } from '@/agent/lib/watch/trigger-format';
import type { FirePayload } from './watch-sweep';
import { alertEmail, sendWatchEmail } from './watch-email';

/**
 * The fire path (docs/plan-watcher.md P4): a tripped watch continues its own
 * eve thread with a [Watch triggered] message and a per-turn output schema;
 * the turn's structured verdict decides whether the alert email goes out.
 *
 * Contract with the sweeper: THROW → the claim is released and nothing is
 * persisted, so the level re-detects next sweep (never burnt). Resolve → the
 * sweeper stamps lastFiredAt/lastCheckedAt and releases the claim. This
 * module owns lastVerdict/lastAlertAt and the email itself.
 *
 * eve 0.22 has no turn queue — a send into an ACTIVE turn interleaves
 * nondeterministically (its docs say wait for session.waiting). So we defer
 * (throw) while the thread's busySince marker is fresh; the persist hook
 * maintains it on turn.started / turn end / session.waiting.
 */

/** A busySince older than this is a crashed turn — treat as idle. */
const BUSY_STALE_MINUTES = 10;
/** Hard cap on one triggered turn (model + tools). */
const TURN_TIMEOUT_MS = 180_000;

interface WatchVerdict {
  met: boolean;
  headline: string;
  summary: string;
}

/** Plain JSON Schema — Anthropic structured outputs reject maxItems/minLength etc. */
const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    met: {
      type: 'boolean',
      description:
        "true ONLY if the user's original watch request is genuinely met right now — a level can cross on a false break without the user's actual condition being real.",
    },
    headline: {
      type: 'string',
      description: 'One short sentence for the alert email subject, e.g. "IDEA broke below ₹14 with volume".',
    },
    summary: {
      type: 'string',
      description:
        'Two to four plain sentences for the email body: what happened, the key numbers, and what the user may want to look at. No markdown.',
    },
  },
  required: ['met', 'headline', 'summary'],
} as const;

function eveOrigin(): string {
  return (
    process.env.WATCH_EVE_ORIGIN ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://127.0.0.1:3002')
  );
}

function buildTriggerMessage(payload: FirePayload): string {
  const w = payload.watch;
  return formatTrigger({
    symbol: w.symbol,
    interval: w.interval,
    instruction: w.instruction,
    reason: payload.reason,
    conditions: w.conditions ?? [],
    firedConditions: payload.firedConditions,
    values: payload.values,
  });
}

export async function fireWatch(payload: FirePayload): Promise<void> {
  const w = payload.watch;
  const thread = await db().query.threads.findFirst({ where: eq(threads.id, w.threadId) });

  // Thread deleted → there is nowhere to wake; retire the watch quietly.
  if (!thread || thread.deletedAt) {
    await db()
      .update(watches)
      .set({ status: 'CANCELLED', errorMessage: 'Chat thread was deleted.', firingAt: null, updatedAt: new Date() })
      .where(eq(watches.id, w.id));
    return;
  }
  if (!thread.continuationToken) throw new Error(`thread ${thread.id} has no continuation token yet`);
  if (thread.busySince && Date.now() - thread.busySince.getTime() < BUSY_STALE_MINUTES * 60000) {
    throw new Error('thread has a turn in flight — deferred to the next sweep');
  }

  // The triggered turn's tools resolve Dhan creds via session_context — refresh
  // it exactly like the proxy does before every user send.
  await upsertSessionContext(w.eveSessionId, w.userId, {
    securityId: thread.securityId ?? w.securityId,
    exchangeSegment: thread.exchangeSegment ?? w.exchangeSegment,
    productType: thread.productType ?? 'CNC',
    symbol: thread.symbol ?? w.symbol,
  });

  const secret = process.env.EVE_PROXY_SECRET;
  if (!secret) throw new Error('EVE_PROXY_SECRET unset — cannot reach the eve channel');
  const client = new Client({ host: eveOrigin(), headers: { 'x-eve-proxy-secret': secret } });
  const session = client.session({
    continuationToken: thread.continuationToken,
    sessionId: w.eveSessionId,
    streamIndex: thread.streamIndex,
  });

  const response = await session.send({
    message: buildTriggerMessage(payload),
    outputSchema: VERDICT_SCHEMA,
    signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
  });
  if (response.sessionId && response.sessionId !== w.eveSessionId) {
    // A bad token silently forks a NEW session — fail loudly, never proceed.
    throw new Error(`continuation fork: sent to ${w.eveSessionId}, eve answered ${response.sessionId}`);
  }
  const result = await response.result();
  if (result.status === 'failed') throw new Error('triggered turn failed');
  const verdict = result.data as WatchVerdict | undefined;
  if (!verdict || typeof verdict.met !== 'boolean') throw new Error('triggered turn returned no structured verdict');

  // Email policy: levels-watch fires are edge-latched upstream, so every
  // confirmed fire is a genuinely new event → email each one. ai_check runs
  // on a clock → email only on the not_met → met TRANSITION.
  const shouldEmail = verdict.met && (w.kind === 'levels' || w.lastVerdict !== 'met');
  const now = new Date();
  await db()
    .update(watches)
    .set({ lastVerdict: verdict.met ? 'met' : 'not_met', ...(shouldEmail ? { lastAlertAt: now } : {}), updatedAt: now })
    .where(eq(watches.id, w.id));

  if (shouldEmail) {
    const owner = await db().query.users.findFirst({ columns: { email: true }, where: eq(users.id, w.userId) });
    if (owner) await sendWatchEmail({ to: owner.email, ...alertEmail(w.symbol, verdict.headline, verdict.summary, w.instruction) });
  }
}
