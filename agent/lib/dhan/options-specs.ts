import { z } from 'zod';
import { dhan, type OptionChain, type OptionChainSide } from './client';
import type { DhanToolContext } from './context';
import { resolveUnderlying, resolveUnderlyingBySymbol, type Underlying } from './underlying';
import type { ToolSpec } from './shared';

/**
 * Options-specialist ToolSpecs (the `options` subagent's own tool surface).
 * Any-underlying: every tool takes an optional `underlying` ticker and falls
 * back to the underlying of the position this chat is about. Built on the
 * verified P1/P2 groundwork: all 8 indices + 228 NSE F&O stocks resolve, the
 * chain carries v2.5 fields (per-contract security_id → candle drill-down),
 * and /charts/rollingoption serves expired-contract history.
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

const underlyingSchema = z
  .string()
  .optional()
  .describe(
    'F&O underlying ticker (NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY, SENSEX, RELIANCE, BAJAJ-AUTO, …). Omit to use the underlying of the position this chat is about.',
  );

/** BSE-listed index underlyings — their option contracts trade on BSE_FNO. */
const BSE_INDEX_NAMES = new Set(['SENSEX', 'BANKEX', 'SNSX50']);

export const contractSegment = (u: Underlying): 'NSE_FNO' | 'BSE_FNO' =>
  BSE_INDEX_NAMES.has(u.name) ? 'BSE_FNO' : 'NSE_FNO';

export const contractInstrument = (u: Underlying): 'OPTIDX' | 'OPTSTK' =>
  u.seg === 'IDX_I' ? 'OPTIDX' : 'OPTSTK';

/**
 * The tool's target underlying: the explicit ticker if given; else the
 * position's underlying; else (equity/holding chats) the position's own
 * symbol when it is itself an F&O underlying.
 */
function targetUnderlying(
  ctx: DhanToolContext,
  raw?: string,
): { ok: true; underlying: Underlying } | { ok: false; error: string } {
  if (raw?.trim()) return resolveUnderlyingBySymbol(raw);
  const fromPosition = resolveUnderlying(ctx.position);
  if (fromPosition.ok) return fromPosition;
  const bySymbol = resolveUnderlyingBySymbol(ctx.position.symbol);
  if (bySymbol.ok) return bySymbol;
  return {
    ok: false,
    error: `${fromPosition.error} You can pass \`underlying\` explicitly (e.g. "NIFTY", "RELIANCE").`,
  };
}

/** Trim a raw chain to ±N strikes around ATM and flatten — else it's a token bomb. */
export function trimChain(chain: OptionChain, around = 10) {
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
  const side = (s?: OptionChainSide) =>
    s && {
      ltp: s.last_price,
      iv: s.implied_volatility,
      oi: s.oi,
      oiPrev: s.previous_oi,
      volume: s.volume,
      bid: s.top_bid_price,
      bidQty: s.top_bid_quantity,
      ask: s.top_ask_price,
      askQty: s.top_ask_quantity,
      avgPrice: s.average_price,
      prevClose: s.previous_close_price,
      securityId: s.security_id,
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

async function nearestExpiry(
  ctx: DhanToolContext,
  u: Underlying,
): Promise<{ ok: true; expiry: string } | { ok: false; error: string }> {
  const expiries = await dhan.getExpiryList(ctx.creds, {
    UnderlyingScrip: u.scrip,
    UnderlyingSeg: u.seg,
  });
  const today = ymd(new Date());
  const next = expiries.filter((e) => e >= today).sort()[0] ?? expiries[0];
  if (!next) return { ok: false, error: `Dhan returned no expiries for ${u.name}.` };
  return { ok: true, expiry: next };
}

export const optionsSpecs: ToolSpec[] = [
  {
    name: 'get_expiry_list',
    description:
      'Available option expiries for any F&O underlying (all NSE/BSE index and NSE stock underlyings). Omit `underlying` for this position’s underlying.',
    inputSchema: z.object({ underlying: underlyingSchema }),
    run: async (args, ctx) => {
      const t = targetUnderlying(ctx, args.underlying as string | undefined);
      if (!t.ok) return { error: t.error };
      const expiries = await dhan.getExpiryList(ctx.creds, {
        UnderlyingScrip: t.underlying.scrip,
        UnderlyingSeg: t.underlying.seg,
      });
      return { underlying: t.underlying.name, expiries };
    },
  },
  {
    name: 'get_option_chain',
    description:
      'Option chain for any F&O underlying — per-strike LTP, IV, greeks, OI (current + previous day), volume, top bid/ask with quantities, and each contract’s securityId (feed it to get_option_candles to study one strike). Trimmed to ±strikes_around around ATM. Omit `expiry` for the nearest one. One call per (underlying, expiry) per 3 s; at most 2 chain calls per turn.',
    inputSchema: z.object({
      underlying: underlyingSchema,
      expiry: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe('Expiry date YYYY-MM-DD (from get_expiry_list). Defaults to the nearest expiry.'),
      strikes_around: z
        .number()
        .int()
        .min(3)
        .max(20)
        .default(10)
        .describe('How many strikes to include on each side of ATM.'),
    }),
    run: async (args, ctx) => {
      const t = targetUnderlying(ctx, args.underlying as string | undefined);
      if (!t.ok) return { error: t.error };
      let expiry = args.expiry as string | undefined;
      if (!expiry) {
        const n = await nearestExpiry(ctx, t.underlying);
        if (!n.ok) return { error: n.error };
        expiry = n.expiry;
      }
      const chain = await dhan.getOptionChain(ctx.creds, {
        UnderlyingScrip: t.underlying.scrip,
        UnderlyingSeg: t.underlying.seg,
        Expiry: expiry,
      });
      return { underlying: t.underlying.name, expiry, ...trimChain(chain, (args.strikes_around as number) ?? 10) };
    },
  },
  {
    name: 'get_option_candles',
    description:
      'Intraday OHLCV + open-interest candles for ONE specific option contract, by the securityId from a get_option_chain row — study how a strike’s premium and OI moved. Pass the same `underlying` the chain call used (derives the exchange).',
    inputSchema: z.object({
      security_id: z.union([z.string(), z.number()]).describe('The contract securityId from get_option_chain.'),
      underlying: underlyingSchema,
      interval: z
        .union([z.literal(1), z.literal(5), z.literal(15), z.literal(25), z.literal(60)])
        .default(15)
        .describe('Candle interval in minutes.'),
      days_back: z.number().int().min(1).max(30).default(5).describe('How many days of history.'),
    }),
    run: async (args, ctx) => {
      const t = targetUnderlying(ctx, args.underlying as string | undefined);
      if (!t.ok) return { error: t.error };
      const candles = await dhan.getIntradayChart(ctx.creds, {
        securityId: String(args.security_id),
        exchangeSegment: contractSegment(t.underlying),
        instrument: contractInstrument(t.underlying),
        interval: (args.interval as number) ?? 15,
        fromDate: ymd(daysAgo((args.days_back as number) ?? 5)),
        toDate: ymd(tomorrow()),
        oi: true,
      });
      return { securityId: String(args.security_id), interval: args.interval ?? 15, candles };
    },
  },
  {
    name: 'get_expired_options',
    description:
      'History of EXPIRED option contracts (Dhan rolling-option data): premium, IV, OI and spot for the contract that was at ATM±N strikes, rolling across past expiries — for questions like "how did IV behave into last expiry". SLOW endpoint (~15 s) and windows are capped at 7 days per call — chunk longer ranges across calls.',
    inputSchema: z.object({
      underlying: underlyingSchema,
      option_type: z.enum(['CALL', 'PUT']).describe('Which side to fetch.'),
      strike: z
        .string()
        .regex(/^ATM([+-]([1-9]|10))?$/)
        .default('ATM')
        .describe('ATM, or ATM+N / ATM-N (indices up to ±10, stocks up to ±3).'),
      expiry_flag: z.enum(['WEEK', 'MONTH']).default('WEEK').describe('Weekly or monthly contract series.'),
      expiry_code: z
        .number()
        .int()
        .min(1)
        .max(4)
        .default(1)
        .describe('1 = nearest expiry of that series at each point in time, 2 = next, …'),
      interval: z
        .union([z.literal(1), z.literal(5), z.literal(15), z.literal(60)])
        .default(60)
        .describe('Bar interval in minutes.'),
      from_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Window start, YYYY-MM-DD.'),
      to_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Window end (non-inclusive), YYYY-MM-DD — at most 7 days after from_date.'),
      fields: z
        .array(z.enum(['open', 'high', 'low', 'close', 'iv', 'volume', 'strike', 'oi', 'spot']))
        .default(['close', 'iv', 'oi', 'strike', 'spot'])
        .describe('Which series to return per bar.'),
    }),
    run: async (args, ctx) => {
      const t = targetUnderlying(ctx, args.underlying as string | undefined);
      if (!t.ok) return { error: t.error };
      const from = args.from_date as string;
      const to = args.to_date as string;
      const spanDays = (new Date(to).getTime() - new Date(from).getTime()) / 86_400_000;
      if (!(spanDays > 0)) return { error: 'to_date must be after from_date.' };
      if (spanDays > 7) {
        return { error: 'Window too large — the endpoint times out beyond ~7 days. Chunk the range across calls.' };
      }
      const data = await dhan.getExpiredOptionData(ctx.creds, {
        exchangeSegment: contractSegment(t.underlying),
        securityId: String(t.underlying.scrip),
        instrument: contractInstrument(t.underlying),
        expiryCode: (args.expiry_code as number) ?? 1,
        expiryFlag: (args.expiry_flag as 'WEEK' | 'MONTH') ?? 'WEEK',
        drvOptionType: args.option_type as 'CALL' | 'PUT',
        strike: (args.strike as string) ?? 'ATM',
        interval: (args.interval as number) ?? 60,
        requiredData: (args.fields as string[]) ?? ['close', 'iv', 'oi', 'strike', 'spot'],
        fromDate: from,
        toDate: to,
      });
      const bars = (args.option_type === 'PUT' ? data.pe : data.ce) ?? data.ce ?? data.pe ?? [];
      return { underlying: t.underlying.name, optionType: args.option_type, bars };
    },
  },
];
