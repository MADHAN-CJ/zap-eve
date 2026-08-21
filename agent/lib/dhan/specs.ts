import { z } from 'zod';
import { dhan, type OptionChain } from './client';
import type { DhanToolContext } from './context';
import { chartInstrument, parseDerivative, resolveUnderlying } from './underlying';
import { isDataApiSubscriptionError, type ToolSpec } from './shared';

/**
 * The 11 read-only Dhan tools. Every `run` receives the resolved per-session
 * context (creds + the position this chat is about) — the model never passes
 * or sees credentials. Filenames in agent/tools/ must match `name` (eve tool
 * names come from filenames).
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

/** Trim a raw chain to ±N strikes around ATM and flatten — else it's a token bomb. */
function trimChain(chain: OptionChain, around = 10) {
  const strikes = Object.keys(chain.oc)
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const spot = chain.last_price;
  let atmIdx = 0;
  for (let i = 1; i < strikes.length; i++) {
    if (Math.abs(strikes[i] - spot) < Math.abs(strikes[atmIdx] - spot)) atmIdx = i;
  }
  const lo = Math.max(0, atmIdx - around);
  const hi = Math.min(strikes.length - 1, atmIdx + around);
  const side = (s?: import('./client').OptionChainSide) =>
    s && {
      ltp: s.last_price,
      iv: s.implied_volatility,
      oi: s.oi,
      oiPrev: s.previous_oi,
      volume: s.volume,
      bid: s.top_bid_price,
      ask: s.top_ask_price,
      delta: s.greeks?.delta,
      theta: s.greeks?.theta,
      gamma: s.greeks?.gamma,
      vega: s.greeks?.vega,
    };
  return {
    underlyingLastPrice: spot,
    strikes: strikes.slice(lo, hi + 1).map((k) => {
      const row = chain.oc[k.toFixed(6)] ?? chain.oc[String(k)] ?? {};
      return { strike: k, ce: side(row.ce), pe: side(row.pe) };
    }),
  };
}

async function nearestExpiry(ctx: DhanToolContext): Promise<{ ok: true; expiry: string; scrip: number; seg: string } | { ok: false; error: string }> {
  const res = resolveUnderlying(ctx.position);
  if (!res.ok) return res;
  const expiries = await dhan.getExpiryList(ctx.creds, {
    UnderlyingScrip: res.underlying.scrip,
    UnderlyingSeg: res.underlying.seg,
  });
  const today = ymd(new Date());
  const next = expiries.filter((e) => e >= today).sort()[0] ?? expiries[0];
  if (!next) return { ok: false, error: 'Dhan returned no expiries for this underlying.' };
  return { ok: true, expiry: next, scrip: res.underlying.scrip, seg: res.underlying.seg };
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
    name: 'get_expiry_list',
    description:
      'Available option expiries for the underlying of this derivative position (NIFTY/BANKNIFTY verified; others not yet supported).',
    inputSchema: z.object({}),
    run: async (_args, ctx) => {
      const res = resolveUnderlying(ctx.position);
      if (!res.ok) return { error: res.error };
      const expiries = await dhan.getExpiryList(ctx.creds, {
        UnderlyingScrip: res.underlying.scrip,
        UnderlyingSeg: res.underlying.seg,
      });
      return { underlying: res.underlying.name, expiries };
    },
  },
  {
    name: 'get_option_chain',
    description:
      'Option chain for the underlying of this derivative position — per-strike LTP, IV, greeks, OI, bid/ask, trimmed to ±10 strikes around ATM. Omit `expiry` for the nearest one. Throttled to one call per 3 seconds; at most 2 calls per turn.',
    inputSchema: z.object({
      expiry: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe('Expiry date YYYY-MM-DD (from get_expiry_list). Defaults to the nearest expiry.'),
    }),
    run: async (args, ctx) => {
      let expiry = args.expiry as string | undefined;
      let scrip: number;
      let seg: string;
      if (expiry) {
        const res = resolveUnderlying(ctx.position);
        if (!res.ok) return { error: res.error };
        scrip = res.underlying.scrip;
        seg = res.underlying.seg;
      } else {
        const n = await nearestExpiry(ctx);
        if (!n.ok) return { error: n.error };
        ({ expiry, scrip, seg } = n);
      }
      const chain = await dhan.getOptionChain(ctx.creds, {
        UnderlyingScrip: scrip,
        UnderlyingSeg: seg,
        Expiry: expiry,
      });
      return { expiry, ...trimChain(chain) };
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
