import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { defineHook } from 'eve/hooks';

/**
 * Per-call token accounting. Every model step's provider-reported usage is appended to
 * usage-log.ndjson (gitignored) as one JSON line, plus a per-turn TOTAL line when the
 * turn completes — the raw data for comparing this 7-domain-tool shape against
 * backend/'s deferred-tool-loading economics (workspace CLAUDE.md follow-up #6).
 *
 * Hooks are observe-only and run after each event is durably recorded, so this adds
 * no behavior and cannot affect tool execution.
 */
const LOG_PATH = join(process.cwd(), 'usage-log.ndjson');

interface StepUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
}

const turnTotals = new Map<string, { steps: number; usage: Required<Omit<StepUsage, 'costUsd'>>; startedAt: number }>();

function log(entry: Record<string, unknown>): void {
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    appendFileSync(LOG_PATH, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
  } catch {
    // Never let accounting break the agent loop.
  }
}

export default defineHook({
  events: {
    'turn.started'(event, ctx) {
      const turnId = (event.data as { turnId?: string }).turnId ?? 'unknown';
      turnTotals.set(turnId, {
        steps: 0,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        startedAt: Date.now(),
      });
      log({ kind: 'turn.started', sessionId: ctx.session.id, turnId });
    },
    'step.completed'(event, ctx) {
      const d = event.data as { turnId?: string; stepIndex?: number; finishReason?: string; usage?: StepUsage };
      const u = d.usage ?? {};
      log({
        kind: 'step',
        sessionId: ctx.session.id,
        turnId: d.turnId,
        stepIndex: d.stepIndex,
        finishReason: d.finishReason,
        inputTokens: u.inputTokens ?? 0,
        outputTokens: u.outputTokens ?? 0,
        cacheReadTokens: u.cacheReadTokens ?? 0,
        cacheWriteTokens: u.cacheWriteTokens ?? 0,
        ...(u.costUsd !== undefined ? { costUsd: u.costUsd } : {}),
      });
      const t = d.turnId ? turnTotals.get(d.turnId) : undefined;
      if (t) {
        t.steps += 1;
        t.usage.inputTokens += u.inputTokens ?? 0;
        t.usage.outputTokens += u.outputTokens ?? 0;
        t.usage.cacheReadTokens += u.cacheReadTokens ?? 0;
        t.usage.cacheWriteTokens += u.cacheWriteTokens ?? 0;
      }
    },
    'turn.completed'(event, ctx) {
      const turnId = (event.data as { turnId?: string }).turnId ?? 'unknown';
      const t = turnTotals.get(turnId);
      if (!t) return;
      turnTotals.delete(turnId);
      log({
        kind: 'turn.total',
        sessionId: ctx.session.id,
        turnId,
        steps: t.steps,
        wallMs: Date.now() - t.startedAt,
        ...t.usage,
        totalTokens: t.usage.inputTokens + t.usage.outputTokens + t.usage.cacheReadTokens + t.usage.cacheWriteTokens,
      });
    },
  },
});
