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

export interface OptionChainSide {
  greeks?: { delta?: number; theta?: number; gamma?: number; vega?: number };
  implied_volatility?: number;
  last_price?: number;
  oi?: number;
  previous_oi?: number;
  volume?: number;
  top_bid_price?: number;
  top_ask_price?: number;
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

const optionChainThrottle = new Throttle(3100); // Dhan: 1 unique req / 3 s
const quoteThrottle = new Throttle(1100); // marketfeed: 1 req / s
const dataThrottle = new Throttle(250); // charts: 5/s bucket, be gentle

async function request<T>(
  creds: DhanCreds,
  op: string,
  path: string,
  init?: { method?: 'GET' | 'POST'; body?: unknown },
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
      signal: AbortSignal.timeout(15000),
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
    await optionChainThrottle.acquire();
    const d = unwrap<string[]>(
      await request(creds, 'getExpiryList', '/optionchain/expirylist', { method: 'POST', body: req }),
    );
    return Array.isArray(d) ? d : [];
  },

  async getOptionChain(
    creds: DhanCreds,
    req: { UnderlyingScrip: number; UnderlyingSeg: string; Expiry: string },
  ): Promise<OptionChain> {
    await optionChainThrottle.acquire();
    const d = unwrap<OptionChain>(
      await request(creds, 'getOptionChain', '/optionchain', { method: 'POST', body: req }),
    );
    if (!d?.oc) throw new DhanError('Dhan getOptionChain failed: no chain in response', 502);
    return { last_price: Number(d.last_price ?? 0), oc: d.oc };
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
};
