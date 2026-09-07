import { z } from 'zod';
import { dhan } from './client';
import type { DhanToolContext } from './context';
import { chartInstrument, parseDerivative, resolveUnderlying } from './underlying';
import { isDataApiSubscriptionError, type ToolSpec } from './shared';

/**
 * The ROOT agent's read-only Dhan tools (position-scoped). Every `run`
 * receives the resolved per-session context (creds + the position this chat
 * is about) — the model never passes or sees credentials. Filenames in
 * agent/tools/ must match `name` (eve tool names come from filenames).
 * Option-chain/expiry tools live in options-specs.ts — the `options`
 * subagent's surface (clean split, plan-options-subagent.md D2).
 */

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
};
const tomorrow = () => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d;
};

/** Position row match: same security in the same segment and product. */
function isThisPosition(row: Record<string, unknown>, ctx: DhanToolContext): boolean {
  return (
    String(row.securityId) === ctx.position.securityId &&
    String(row.exchangeSegment) === ctx.position.exchangeSegment &&
    String(row.productType) === ctx.position.productType
  );
}

const targetSchema = z
  .enum(['position', 'underlying'])
  .default('position')
  .describe(
    'Which instrument: "position" = the instrument this chat is about; "underlying" = its underlying (index/stock) for derivative positions.',
  );

function resolveTarget(ctx: DhanToolContext, target: 'position' | 'underlying') {
  if (target === 'position') {
    return {
      ok: true as const,
      securityId: ctx.position.securityId,
      exchangeSegment: ctx.position.exchangeSegment,
      label: ctx.position.symbol,
    };
  }
  const res = resolveUnderlying(ctx.position);
  if (!res.ok) return { ok: false as const, error: res.error };
  return {
    ok: true as const,
    securityId: String(res.underlying.scrip),
    exchangeSegment: res.underlying.seg,
    label: res.underlying.name,
  };
}

export const allSpecs: ToolSpec[] = [
  {
    name: 'get_position_snapshot',
    description:
      'The live state of THE position (or demat holding) this chat is about: quantities, averages, P&L, straight from Dhan. Call this first in most conversations. Delivery holdings live in Dhan holdings (not positions) and carry no LTP — pair with get_ltp for current value.',
    inputSchema: z.object({}),
    run: async (_args, ctx) => {
      const positions = await dhan.getPositions(ctx.creds);
      const match = positions.find((p) => isThisPosition(p, ctx));
      if (match) return { position: match, closed: Number(match.netQty ?? 0) === 0 };
      // Delivery holdings never appear in /positions unless traded today.
      const holdings = await dhan.getHoldings(ctx.creds);
      const holding = holdings.find((h) => String(h.securityId) === ctx.position.securityId);
      if (holding) {
        return {
          holding,
          note: 'This is a demat delivery holding (not an open trading position): quantity, average cost, and a lastTradedPrice come from holdings — enough for current value/P&L even without the Data-API subscription.',
        };
      }
      return {
        position: null,
        note: `No open position or holding found for ${ctx.position.symbol} (${ctx.position.exchangeSegment}, ${ctx.position.productType}) — it appears closed, squared off, or sold. History and post-mortem analysis are still fine; just say so plainly.`,
      };
    },
  },
  {
    name: 'get_positions',
    description:
      "All of the user's open positions across instruments (the current chat is scoped to one of them, but comparisons and portfolio-level context are fine).",
    inputSchema: z.object({}),
    run: (_args, ctx) => dhan.getPositions(ctx.creds),
  },
  {
    name: 'get_holdings',
    description: "The user's demat holdings (delivery equity): quantities, average cost, ISIN.",
    inputSchema: z.object({}),
    run: (_args, ctx) => dhan.getHoldings(ctx.creds),
  },
  {
    name: 'get_funds',
    description:
      "The user's fund limits: available balance (Dhan spells it `availabelBalance`), utilized amount, collateral, withdrawable balance.",
    inputSchema: z.object({}),
    run: (_args, ctx) => dhan.getFundLimit(ctx.creds),
  },
  {
    name: 'get_order_book',
    description: "Today's orders (all statuses: pending, traded, rejected, cancelled) from Dhan.",
    inputSchema: z.object({}),
    run: (_args, ctx) => dhan.getOrderBook(ctx.creds),
  },
  {
    name: 'get_trade_book',
    description: "Today's executed trades (fills) from Dhan.",
    inputSchema: z.object({}),
    run: (_args, ctx) => dhan.getTradeBook(ctx.creds),
  },
  {
    name: 'get_ltp',
    description:
      'Last traded price for the position instrument or (for derivatives) its underlying index. On accounts without the Dhan Data-API subscription, equity prices fall back to the lastTradedPrice in holdings.',
    inputSchema: z.object({ target: targetSchema }),
    run: async (args, ctx) => {
      const t = resolveTarget(ctx, (args.target as 'position' | 'underlying') ?? 'position');
      if (!t.ok) return { error: t.error };
      try {
        const map = await dhan.getLtp(ctx.creds, { [t.exchangeSegment]: [Number(t.securityId)] });
        const ltp = map[t.exchangeSegment]?.[t.securityId];
        if (ltp === undefined) return { error: `No LTP returned for ${t.label} — the market feed may be closed or the instrument unsupported.` };
        return { instrument: t.label, exchangeSegment: t.exchangeSegment, securityId: t.securityId, ltp };
      } catch (e) {
        // Marketfeed is a paid Data API; holdings carry a lastTradedPrice.
        if (isDataApiSubscriptionError(e) && t.exchangeSegment.endsWith('_EQ')) {
          const holdings = await dhan.getHoldings(ctx.creds);
          const h = holdings.find((row) => String(row.securityId) === t.securityId);
          const last = h ? Number(h.lastTradedPrice) : NaN;
          if (Number.isFinite(last)) {
            return {
              instrument: t.label,
              ltp: last,
              source:
                'holdings.lastTradedPrice — the account has no Dhan Data-API subscription, so this comes from the holdings feed and may lag the live market slightly.',
            };
          }
        }
        throw e;
      }
    },
  },
  {
    name: 'get_intraday_candles',
    description:
      'Intraday OHLCV candles (with open interest for F&O) for the position instrument or its underlying.',
    inputSchema: z.object({
      target: targetSchema,
      interval: z.union([z.literal(1), z.literal(5), z.literal(15), z.literal(25), z.literal(60)]).default(15).describe('Candle interval in minutes.'),
      daysBack: z.number().int().min(1).max(90).default(5).describe('How many days of history (max 90).'),
    }),
    run: async (args, ctx) => {
      const target = (args.target as 'position' | 'underlying') ?? 'position';
      const t = resolveTarget(ctx, target);
      if (!t.ok) return { error: t.error };
      const candles = await dhan.getIntradayChart(ctx.creds, {
        securityId: t.securityId,
        exchangeSegment: t.exchangeSegment,
        instrument: chartInstrument(ctx.position, target),
        interval: (args.interval as number) ?? 15,
        fromDate: ymd(daysAgo((args.daysBack as number) ?? 5)),
        toDate: ymd(tomorrow()),
        oi: parseDerivative(ctx.position).isDerivative && target === 'position',
      });
      return { instrument: t.label, interval: args.interval ?? 15, candles };
    },
  },
  {
    name: 'get_daily_candles',
    description:
      'Daily OHLCV candles for the position instrument or its underlying — for trend and level analysis.',
    inputSchema: z.object({
      target: targetSchema,
      daysBack: z.number().int().min(5).max(365).default(90).describe('How many calendar days of history.'),
    }),
    run: async (args, ctx) => {
      const target = (args.target as 'position' | 'underlying') ?? 'position';
      const t = resolveTarget(ctx, target);
      if (!t.ok) return { error: t.error };
      const candles = await dhan.getHistoricalChart(ctx.creds, {
        securityId: t.securityId,
        exchangeSegment: t.exchangeSegment,
        instrument: chartInstrument(ctx.position, target),
        fromDate: ymd(daysAgo((args.daysBack as number) ?? 90)),
        toDate: ymd(tomorrow()),
        oi: parseDerivative(ctx.position).isDerivative && target === 'position',
      });
      return { instrument: t.label, candles };
    },
  },
];
