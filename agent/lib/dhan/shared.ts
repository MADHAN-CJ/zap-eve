import { z } from 'zod';
import { DhanError } from './client';
import type { DhanToolContext } from './context';

/**
 * Read-only tool spec contract, independent of eve/AI-SDK. `run` performs the
 * real Dhan call; the builder in tools.ts wraps it. There is deliberately NO
 * confirm policy: every tool in this product is a read — the agent has no way
 * to place, modify, or cancel anything.
 */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: z.ZodObject;
  run: (args: Record<string, unknown>, ctx: DhanToolContext) => Promise<unknown>;
}

/**
 * Convert any thrown error into the `{ error }` envelope the model reads, so
 * a tool never throws out of execute(). Token-expiry marking happens in
 * tools.ts after a probe — not here.
 */
export function toErr(e: unknown): { error: string } {
  if (e instanceof DhanError) {
    if (isDataApiSubscriptionError(e)) {
      return {
        error:
          "This Dhan account has no Data-API subscription (Dhan error 806), which live quotes, candles and option chains require — the access token itself is fine, and trading data (positions, holdings, funds, orders) still works. Tell the user: subscribing to Data APIs on dhan.co enables these tools. For demat holdings, get_position_snapshot already includes a lastTradedPrice.",
      };
    }
    if (e.status === 401 || e.status === 403) {
      return {
        error:
          'Dhan rejected the access token (it likely expired — Dhan tokens last 24h). Tell the user to reconnect Dhan from the broker screen; do not retry this tool now.',
      };
    }
    return { error: e.message };
  }
  if (e instanceof Error) return { error: e.message };
  return { error: String(e) };
}

export function isDhanAuthError(e: unknown): boolean {
  return e instanceof DhanError && (e.status === 401 || e.status === 403);
}

/**
 * A Dhan 401 is not always a dead token: the paid Data APIs return
 * `{"data":{"806":"Data APIs not Subscribed"}}` on unsubscribed accounts
 * while the token works everywhere else.
 */
export function isDataApiSubscriptionError(e: unknown): boolean {
  if (!(e instanceof DhanError)) return false;
  const raw = `${e.message} ${JSON.stringify(e.body ?? '')}`;
  return raw.includes('806') || /not\s+subscribed/i.test(raw);
}
