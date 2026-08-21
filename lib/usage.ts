/**
 * Per-turn token usage derived from eve's raw stream events (`step.completed`
 * carries provider-reported usage per model call). Costs use claude-sonnet-5
 * list pricing — keep in sync with agent/agent.ts's model.
 */

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  steps: number;
}

// $/MTok — claude-sonnet-5 (cache read 0.1x, cache write 1.25x)
const PRICE = { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 };

export function estCostUsd(u: TurnUsage): number {
  // inputTokens is AI-SDK-style: inclusive of cache read/write (guard for the
  // exclusive convention anyway).
  let uncached = u.inputTokens - u.cacheReadTokens - u.cacheWriteTokens;
  if (uncached < 0) uncached = u.inputTokens;
  return (
    (uncached * PRICE.input +
      u.cacheReadTokens * PRICE.cacheRead +
      u.cacheWriteTokens * PRICE.cacheWrite +
      u.outputTokens * PRICE.output) /
    1e6
  );
}

interface StepCompletedLike {
  type?: string;
  data?: {
    turnId?: string;
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    };
  };
}

/** Fold the raw event stream into per-turn usage totals. */
export function usageByTurn(events: readonly unknown[]): Map<string, TurnUsage> {
  const byTurn = new Map<string, TurnUsage>();
  for (const raw of events) {
    const e = raw as StepCompletedLike;
    if (e.type !== 'step.completed') continue;
    const turnId = e.data?.turnId;
    if (!turnId) continue;
    const u = e.data?.usage ?? {};
    const t = byTurn.get(turnId) ?? {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      steps: 0,
    };
    t.inputTokens += u.inputTokens ?? 0;
    t.outputTokens += u.outputTokens ?? 0;
    t.cacheReadTokens += u.cacheReadTokens ?? 0;
    t.cacheWriteTokens += u.cacheWriteTokens ?? 0;
    t.steps += 1;
    byTurn.set(turnId, t);
  }
  return byTurn;
}

export function totalCostUsd(byTurn: Map<string, TurnUsage>): number {
  let total = 0;
  for (const u of byTurn.values()) total += estCostUsd(u);
  return total;
}

const nf = new Intl.NumberFormat('en-US');

/**
 * Money formatting ported from the old frontend: up to 6 decimals (per-turn
 * costs are fractions of a cent), trailing zeros trimmed, minimum 2 decimals,
 * `< $0.000001` for dust. Values are computed server-side; this only formats.
 */
export function formatCost(amount: number, currency = 'USD'): string {
  const symbol = currency === 'USD' ? '$' : `${currency} `;
  if (!Number.isFinite(amount) || amount <= 0) return `${symbol}0.00`;
  if (amount < 0.000001) return `< ${symbol}0.000001`;
  let s = amount.toFixed(6).replace(/0+$/, '');
  const decimals = s.length - s.indexOf('.') - 1;
  if (decimals < 2) s = amount.toFixed(2);
  return `${symbol}${s}`;
}

/** Usage line for a PERSISTED assistant message (usage/cost from the DB). */
export function formatStoredUsageLine(
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  } | null,
  cost: { total: number; currency: string } | null,
): string | null {
  const parts: string[] = [];
  if (usage) {
    if (usage.inputTokens !== undefined) parts.push(`${nf.format(usage.inputTokens)} in`);
    if (usage.outputTokens !== undefined) parts.push(`${nf.format(usage.outputTokens)} out`);
    if (usage.cacheReadTokens) parts.push(`${nf.format(usage.cacheReadTokens)} cache read`);
    if (usage.cacheWriteTokens) parts.push(`${nf.format(usage.cacheWriteTokens)} cache write`);
  }
  if (cost) parts.push(formatCost(cost.total, cost.currency));
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** "18,353 in · 752 out · 19,105 total [· N cache read] [· N cache write] · $0.022113" */
export function formatUsageLine(u: TurnUsage): string {
  const parts = [
    `${nf.format(u.inputTokens)} in`,
    `${nf.format(u.outputTokens)} out`,
    `${nf.format(u.inputTokens + u.outputTokens)} total`,
  ];
  if (u.cacheReadTokens > 0) parts.push(`${nf.format(u.cacheReadTokens)} cache read`);
  if (u.cacheWriteTokens > 0) parts.push(`${nf.format(u.cacheWriteTokens)} cache write`);
  parts.push(`$${estCostUsd(u).toFixed(6)}`);
  return parts.join(' · ');
}
