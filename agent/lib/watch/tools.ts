import { z } from 'zod';
import { defineTool } from 'eve/tools';
import { getSessionContext, type SessionOwner } from '../db/session-context';
import type { EveToolCtx } from '../dhan/context';
import {
  AI_CHECK_DEFAULT_MINUTES,
  AI_CHECK_MAX_MINUTES,
  AI_CHECK_MIN_MINUTES,
  cancelWatch,
  createWatch,
  listWatches,
  pauseWatch,
  resumeWatch,
  watchSummary,
} from './service';
import type { WatchCondition, WatchMetric } from './types';

/**
 * Watch tools (docs/plan-watcher.md P2). Ownership only — these tools touch
 * OUR database, never Dhan, so they resolve the session's user and nothing
 * else. Fail-closed: no session context → no watch (direct/bench sends have
 * no user to alert). Execute never throws; errors are { error } envelopes.
 */

const METRICS = [
  'price',
  'ema50',
  'ema200',
  'rsi14',
  'macd_line',
  'macd_signal',
  'macd_hist',
  'bb_upper',
  'bb_middle',
  'bb_lower',
  'adx14',
  'di_plus',
  'di_minus',
] as const satisfies readonly WatchMetric[];

const metricSchema = z.enum(METRICS);

const conditionSchema = z.object({
  metric: metricSchema.describe('The series to measure, computed from closed candles.'),
  comparator: z.enum(['above', 'below', 'crosses_above', 'crosses_below']),
  target: z
    .union([z.number(), metricSchema])
    .describe('A fixed level (₹ / indicator units), or another metric for crossovers (e.g. ema50 crosses_above ema200).'),
});

const INTERVALS = ['1min', '5min', '15min', '1h', '1day'] as const;

async function ownerFor(toolCtx: EveToolCtx | undefined): Promise<SessionOwner | { error: string }> {
  const sessionId = toolCtx?.session?.id;
  if (!sessionId) return { error: 'Watches need the app context — this session has no owner to alert.' };
  const found = await getSessionContext(sessionId);
  if (found.status === 'found') return found.owner;
  return {
    error:
      found.status === 'error'
        ? 'Ownership lookup failed — cannot manage watches this turn. Ask the user to retry shortly.'
        : 'Watches need the app context — this session has no owner to alert.',
  };
}

const createSchema = z.object({
  instruction: z
    .string()
    .min(8)
    .describe("The user's alert request, verbatim — replayed to you when the watch fires."),
  kind: z
    .enum(['levels', 'ai_check'])
    .describe('levels: numeric conditions polled for free. ai_check: no compilable conditions — you re-judge the chart on a cadence (costs a model run each check). ALWAYS prefer levels when compilable.'),
  interval: z.enum(INTERVALS).describe("Candle interval the conditions are judged on — default to the chart's current interval from <chart_context>."),
  conditions: z
    .array(conditionSchema)
    .max(6)
    .optional()
    .describe('Required for kind=levels; omit for ai_check.'),
  mode: z
    .enum(['any', 'all'])
    .default('any')
    .describe('any: alert when any one condition trips. all: only when every condition holds together.'),
  check_interval_minutes: z
    .number()
    .int()
    .min(AI_CHECK_MIN_MINUTES)
    .max(AI_CHECK_MAX_MINUTES)
    .optional()
    .describe(`ai_check only: minutes between AI evaluations (default ${AI_CHECK_DEFAULT_MINUTES}).`),
});

export const createWatchTool = defineTool({
  description:
    'Arm a market watch on THIS chat\'s instrument. The watch polls closed candles in the background (market hours) and wakes you in this chat when it trips; you then judge whether the user\'s condition is truly met and an email alert goes out only if it is. Use ONLY when the user explicitly asks to be alerted/reminded/notified about a future market event — never for ordinary analysis.',
  inputSchema: createSchema,
  execute: async (input: unknown, toolCtx?: EveToolCtx) => {
    const parsed = createSchema.safeParse(input ?? {});
    if (!parsed.success) {
      return { error: `Invalid params: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}` };
    }
    const owner = await ownerFor(toolCtx);
    if ('error' in owner) return owner;
    const a = parsed.data;
    if (a.kind === 'levels' && (!a.conditions || a.conditions.length === 0)) {
      return { error: 'kind=levels requires at least one condition. If the ask truly has no numeric proxy, use kind=ai_check.' };
    }
    const sessionId = toolCtx?.session?.id as string;
    const result = await createWatch({
      userId: owner.userId,
      eveSessionId: sessionId,
      securityId: owner.position.securityId,
      exchangeSegment: owner.position.exchangeSegment,
      symbol: owner.position.symbol,
      interval: a.interval,
      instruction: a.instruction,
      kind: a.kind,
      conditions: (a.conditions as WatchCondition[] | undefined) ?? null,
      mode: a.mode,
      checkIntervalMinutes: a.check_interval_minutes ?? null,
    });
    if (result.status === 'error') return { error: result.message };
    return {
      watch: watchSummary(result.watch),
      note: 'Tell the user exactly what was armed: the levels/crossovers being watched (or the AI-check cadence), the candle interval, and that it expires in 10 days. Alerts arrive by email after you confirm a trip is real.',
    };
  },
});

export const listWatchesTool = defineTool({
  description: "List all of the user's market watches (every instrument, newest first) with status and last activity.",
  inputSchema: z.object({}),
  execute: async (_input: unknown, toolCtx?: EveToolCtx) => {
    const owner = await ownerFor(toolCtx);
    if ('error' in owner) return owner;
    const rows = await listWatches(owner.userId);
    return { watches: rows.map(watchSummary) };
  },
});

const idSchema = z.object({ watch_id: z.string().uuid().describe('From list_watches or a create_watch result.') });

export const cancelWatchTool = defineTool({
  description: 'Cancel a market watch permanently. Only on the user\'s explicit request — never cancel on your own judgment.',
  inputSchema: idSchema,
  execute: async (input: unknown, toolCtx?: EveToolCtx) => {
    const parsed = idSchema.safeParse(input ?? {});
    if (!parsed.success) return { error: 'watch_id must be a UUID from list_watches.' };
    const owner = await ownerFor(toolCtx);
    if ('error' in owner) return owner;
    const result = await cancelWatch(owner.userId, parsed.data.watch_id);
    return result.status === 'ok' ? { watch: watchSummary(result.watch) } : { error: result.message };
  },
});

const pauseSchema = z.object({
  watch_id: z.string().uuid(),
  action: z.enum(['pause', 'resume']).describe('resume also restarts a watch stuck in ERROR (e.g. after reconnecting Dhan).'),
});

export const pauseOrResumeWatchTool = defineTool({
  description: 'Pause or resume a market watch. Only on the user\'s explicit request.',
  inputSchema: pauseSchema,
  execute: async (input: unknown, toolCtx?: EveToolCtx) => {
    const parsed = pauseSchema.safeParse(input ?? {});
    if (!parsed.success) return { error: 'Expected { watch_id: uuid, action: pause | resume }.' };
    const owner = await ownerFor(toolCtx);
    if ('error' in owner) return owner;
    const result =
      parsed.data.action === 'pause'
        ? await pauseWatch(owner.userId, parsed.data.watch_id)
        : await resumeWatch(owner.userId, parsed.data.watch_id);
    return result.status === 'ok' ? { watch: watchSummary(result.watch) } : { error: result.message };
  },
});
