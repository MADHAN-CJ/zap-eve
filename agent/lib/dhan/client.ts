/**
 * Minimal READ-ONLY Dhan API client — writes deliberately absent.
 *
 * Dhan quirks this client depends on:
 *  - Data APIs (option chain / expiry list / market quote) 401 without a
 *    `client-id` header; trading endpoints ignore it — sent on every call.
 *  - Option-chain endpoints allow 1 unique request / 3 s (own limiter, not
 *    the 5/s data bucket).
 *  - Chart responses are column-oriented; data-API payloads wrap in
 *    {data,status}.
 *  - Reads need no whitelisted static IP (setIP is order-placement only).
 */

const BASE_URL = process.env.DHAN_BASE_URL || 'https://api.dhan.co/v2';

export interface DhanCreds {
  dhanClientId: string;
  accessToken: string;
}

export class DhanError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: unknown,
  ) {
    super(message);
  }
}

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  openInterest?: number;
}

export interface QuoteTick {
  lastPrice: number;
  volume: number; // cumulative day volume
  dayOpen?: number;
  dayHigh?: number;
  dayLow?: number;
  lastTradeTime?: string;
}

export interface OptionChainSide {
  greeks?: { delta?: number; theta?: number; gamma?: number; vega?: number };
  implied_volatility?: number;
  last_price?: number;
  oi?: number;
  previous_oi?: number;
  volume?: number;
  top_bid_price?: number;
  top_ask_price?: number;
  // Dhan v2.5 (2026-02) additions:
  /** The option contract's own securityId — chainable into charts/quotes. */
  security_id?: number | string;
  average_price?: number;
  top_bid_quantity?: number;
  top_ask_quantity?: number;
  previous_close_price?: number;
  previous_volume?: number;
}

/** One zipped bar from /charts/rollingoption (fields follow requiredData). */
export interface ExpiredOptionBar {
  timestamp: number;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  volume?: number;
  iv?: number;
  oi?: number;
  strike?: number;
  spot?: number;
}

export interface OptionChain {
  last_price: number;
  oc: Record<string, { ce?: OptionChainSide; pe?: OptionChainSide }>;
}

/** Serialize calls in a class and enforce a minimum gap between them. */
class Throttle {
  private last = 0;
  private chain: Promise<void> = Promise.resolve();
  constructor(private readonly minGapMs: number) {}
  acquire(): Promise<void> {
    const run = this.chain.then(async () => {
      const wait = this.last + this.minGapMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.last = Date.now();
    });
    this.chain = run.catch(() => {});
    return run;
  }
}

// Dhan v2.5: the 1-req/3s option-chain limit is per UNIQUE (underlying,
// expiry) combination — distinct combos may go concurrently, repeats of the
// same combo must wait. One Throttle per key (bounded; oldest pruned).
const optionChainThrottles = new Map<string, Throttle>();
function chainThrottle(key: string): Throttle {
  let t = optionChainThrottles.get(key);
  if (!t) {
    if (optionChainThrottles.size >= 500) {
      const oldest = optionChainThrottles.keys().next().value;
      if (oldest !== undefined) optionChainThrottles.delete(oldest);
    }
    t = new Throttle(3100);
    optionChainThrottles.set(key, t);
  }
  return t;
}
const quoteThrottle = new Throttle(1100); // marketfeed: 1 req / s
const dataThrottle = new Throttle(250); // charts: 5/s bucket, be gentle

async function request<T>(
  creds: DhanCreds,
  op: string,
  path: string,
  init?: { method?: 'GET' | 'POST'; body?: unknown; timeoutMs?: number },
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method: init?.method ?? 'GET',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'access-token': creds.accessToken,
        'client-id': creds.dhanClientId,
      },
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(init?.timeoutMs ?? 15000),
    });
  } catch (e) {
    throw new DhanError(`Dhan ${op} failed: ${e instanceof Error ? e.message : 'network error'}`, 502);
  }
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const d = data as { errorMessage?: string; message?: string } | null;
    throw new DhanError(`Dhan ${op} failed: ${d?.errorMessage || d?.message || res.statusText}`, res.status, data);
  }
  return data as T;
}

/** Dhan chart payloads are column-oriented; zip into rows. */
function zipCandles(d: Record<string, unknown[]> | null): Candle[] {
  const ts = (d?.timestamp ?? []) as unknown[];
  const oi = (d?.open_interest ?? []) as unknown[];
  return ts.map((t, i) => ({
    timestamp: Number(t),
    open: Number((d?.open as unknown[])?.[i]),
    high: Number((d?.high as unknown[])?.[i]),
    low: Number((d?.low as unknown[])?.[i]),
    close: Number((d?.close as unknown[])?.[i]),
    volume: Number((d?.volume as unknown[])?.[i] ?? 0),
    ...(oi.length ? { openInterest: Number(oi[i] ?? 0) } : {}),
  }));
}

/** Unwrap Dhan's {data,status} envelope used by the data APIs. */
function unwrap<T>(payload: unknown): T {
  const p = payload as { data?: T } | null;
  return (p && typeof p === 'object' && 'data' in p ? (p.data as T) : (payload as T)) ?? (payload as T);
}

export const dhan = {
  getPositions: (creds: DhanCreds) => request<Record<string, unknown>[]>(creds, 'getPositions', '/positions'),
  getHoldings: (creds: DhanCreds) => request<Record<string, unknown>[]>(creds, 'getHoldings', '/holdings'),
  getFundLimit: (creds: DhanCreds) => request<Record<string, unknown>>(creds, 'getFundLimit', '/fundlimit'),
  getOrderBook: (creds: DhanCreds) => request<Record<string, unknown>[]>(creds, 'getOrderBook', '/orders'),
  getTradeBook: (creds: DhanCreds) => request<Record<string, unknown>[]>(creds, 'getTradeBook', '/trades'),

  async getIntradayChart(
    creds: DhanCreds,
    req: {
      securityId: string;
      exchangeSegment: string;
      instrument: string;
      interval: number;
      fromDate: string;
      toDate: string;
      oi?: boolean;
    },
  ): Promise<Candle[]> {
    await dataThrottle.acquire();
    return zipCandles(
      await request(creds, 'getIntradayChart', '/charts/intraday', { method: 'POST', body: req }),
    );
  },

  async getHistoricalChart(
    creds: DhanCreds,
    req: {
      securityId: string;
      exchangeSegment: string;
      instrument: string;
      fromDate: string;
      toDate: string;
      oi?: boolean;
      expiryCode?: number;
    },
  ): Promise<Candle[]> {
    await dataThrottle.acquire();
    return zipCandles(
      await request(creds, 'getHistoricalChart', '/charts/historical', { method: 'POST', body: req }),
    );
  },

  async getExpiryList(
    creds: DhanCreds,
    req: { UnderlyingScrip: number; UnderlyingSeg: string },
  ): Promise<string[]> {
    await chainThrottle(`${req.UnderlyingSeg}:${req.UnderlyingScrip}`).acquire();
    const d = unwrap<string[]>(
      await request(creds, 'getExpiryList', '/optionchain/expirylist', { method: 'POST', body: req }),
    );
    return Array.isArray(d) ? d : [];
  },

  async getOptionChain(
    creds: DhanCreds,
    req: { UnderlyingScrip: number; UnderlyingSeg: string; Expiry: string },
  ): Promise<OptionChain> {
    await chainThrottle(`${req.UnderlyingSeg}:${req.UnderlyingScrip}:${req.Expiry}`).acquire();
    const d = unwrap<OptionChain>(
      await request(creds, 'getOptionChain', '/optionchain', { method: 'POST', body: req }),
    );
    if (!d?.oc) throw new DhanError('Dhan getOptionChain failed: no chain in response', 502);
    return { last_price: Number(d.last_price ?? 0), oc: d.oc };
  },

  /**
   * Expired-options history (Dhan v2.3 "rolling option"): continuous data for
   * expired contracts addressed by ATM±N strike notation — no per-contract
   * securityIds needed. securityId here is the UNDERLYING's id (same value the
   * option-chain APIs take). Docs allow ≤30 days/call but the endpoint is SLOW
   * (11–18 s for a 2-day window, live 2026-09-04) and Dhan's gateway 504s at
   * ~30 s — keep windows ≤~7 days and chunk longer ranges. expiryCode starts
   * at 1 (1 = nearest expiry per expiryFlag, 2 = next…); 0 is rejected.
   * Un-requested requiredData fields come back as EMPTY arrays.
   */
  async getExpiredOptionData(
    creds: DhanCreds,
    req: {
      exchangeSegment: string;
      securityId: string;
      instrument: 'OPTIDX' | 'OPTSTK';
      expiryCode: number;
      expiryFlag: 'WEEK' | 'MONTH';
      drvOptionType: 'CALL' | 'PUT';
      strike: string; // 'ATM' | 'ATM+1'…'ATM+10' | 'ATM-1'…'ATM-10' (stocks: ±3)
      interval: number; // 1 | 5 | 15 | 25 | 60
      requiredData: string[]; // any of open/high/low/close/iv/volume/strike/oi/spot
      fromDate: string; // YYYY-MM-DD
      toDate: string; // YYYY-MM-DD (non-inclusive)
    },
  ): Promise<{ ce?: ExpiredOptionBar[]; pe?: ExpiredOptionBar[] }> {
    await dataThrottle.acquire();
    const d = unwrap<Record<string, Record<string, unknown[]>>>(
      await request(creds, 'getExpiredOptionData', '/charts/rollingoption', {
        method: 'POST',
        body: req,
        timeoutMs: 60000, // endpoint takes 11–18 s even for small windows
      }),
    );
    const zipSide = (side?: Record<string, unknown[]>): ExpiredOptionBar[] | undefined => {
      const ts = side?.timestamp;
      if (!Array.isArray(ts)) return undefined;
      const keys = Object.keys(side ?? {}).filter((k) => k !== 'timestamp');
      return ts.map((t, i) => {
        const bar: ExpiredOptionBar = { timestamp: Number(t) };
        for (const k of keys) {
          const v = Number(side?.[k]?.[i]);
          if (Number.isFinite(v)) (bar as unknown as Record<string, number>)[k] = v;
        }
        return bar;
      });
    };
    return { ce: zipSide(d?.ce), pe: zipSide(d?.pe) };
  },

  /** Batched last-traded prices: {SEGMENT: [securityId, …]} → {SEGMENT: {id: ltp}}. */
  async getLtp(creds: DhanCreds, req: Record<string, number[]>): Promise<Record<string, Record<string, number>>> {
    await quoteThrottle.acquire();
    const d = unwrap<Record<string, Record<string, { last_price?: number }>>>(
      await request(creds, 'getLtp', '/marketfeed/ltp', { method: 'POST', body: req }),
    );
    const out: Record<string, Record<string, number>> = {};
    for (const seg of Object.keys(d ?? {})) {
      out[seg] = {};
      for (const id of Object.keys(d[seg] ?? {})) {
        const lp = Number(d[seg][id]?.last_price);
        if (Number.isFinite(lp)) out[seg][id] = lp;
      }
    }
    return out;
  },

  /** Batched full quotes (LTP + day volume/OHLC): {SEGMENT: [securityId, …]}. */
  async getQuote(creds: DhanCreds, req: Record<string, number[]>): Promise<Record<string, Record<string, QuoteTick>>> {
    await quoteThrottle.acquire();
    const d = unwrap<
      Record<
        string,
        Record<
          string,
          {
            last_price?: number;
            volume?: number;
            ohlc?: { open?: number; high?: number; low?: number; close?: number };
            last_trade_time?: string;
          }
        >
      >
    >(await request(creds, 'getQuote', '/marketfeed/quote', { method: 'POST', body: req }));
    const out: Record<string, Record<string, QuoteTick>> = {};
    for (const seg of Object.keys(d ?? {})) {
      out[seg] = {};
      for (const id of Object.keys(d[seg] ?? {})) {
        const q = d[seg][id];
        const lp = Number(q?.last_price);
        if (!Number.isFinite(lp)) continue;
        out[seg][id] = {
          lastPrice: lp,
          volume: Number(q?.volume ?? 0),
          dayOpen: Number.isFinite(Number(q?.ohlc?.open)) ? Number(q?.ohlc?.open) : undefined,
          dayHigh: Number.isFinite(Number(q?.ohlc?.high)) ? Number(q?.ohlc?.high) : undefined,
          dayLow: Number.isFinite(Number(q?.ohlc?.low)) ? Number(q?.ohlc?.low) : undefined,
          lastTradeTime: q?.last_trade_time,
        };
      }
    }
    return out;
  },
};
