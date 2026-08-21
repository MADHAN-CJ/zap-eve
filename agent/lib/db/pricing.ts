import type { Cost, Usage } from './types';

/**
 * Server-side cost computation for persisted assistant turns (plan §4.1: the
 * client only formats money, never derives it). Prices are $/MTok list rates
 * for the active model — keep MODEL_ID and PRICE in sync with agent/agent.ts
 * and lib/usage.ts (the live-stream footer uses the same numbers).
 */

const MODEL_ID = 'claude-sonnet-5';

// $/MTok — claude-sonnet-5 list rates (cache read 0.1x, cache write 1.25x)
const PRICE = { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 };

/**
 * Build the persisted Cost object from a turn's summed usage. Returns null when
 * there is no usable usage (errored turns) — the UI then shows no cost line.
 * `inputTokens` follows the AI-SDK convention of being inclusive of cache
 * read/write tokens; guard for the exclusive convention anyway.
 */
export function costForUsage(usage: Usage | undefined): Cost | null {
  if (!usage) return null;
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  if (input + output + cacheRead + cacheWrite === 0) return null;

  let uncached = input - cacheRead - cacheWrite;
  if (uncached < 0) uncached = input;

  const breakdown = {
    input: (uncached * PRICE.input) / 1e6,
    output: (output * PRICE.output) / 1e6,
    cacheRead: (cacheRead * PRICE.cacheRead) / 1e6,
    cacheWrite: (cacheWrite * PRICE.cacheWrite) / 1e6,
  };
  return {
    currency: 'USD',
    model: MODEL_ID,
    total: breakdown.input + breakdown.output + breakdown.cacheRead + breakdown.cacheWrite,
    breakdown,
  };
}
