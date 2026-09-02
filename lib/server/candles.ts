import { dhan, type Candle, type DhanCreds } from '@/agent/lib/dhan/client';
import { chartInstrument } from '@/agent/lib/dhan/underlying';

/**
 * One shared Dhan candle fetch for the chart route and the watch sweeper —
 * same intervals, same depth windows, same instrument derivation.
 */

export type CandleInterval = '1min' | '5min' | '15min' | '1h' | '1day';

export const INTRADAY_MINUTES: Record<Exclude<CandleInterval, '1day'>, number> = {
  '1min': 1,
  '5min': 5,
  '15min': 15,
  '1h': 60,
};

// deep enough that a 200-period EMA CONVERGES (not merely warms up) — EMA
// seeding error decays by (1−2/201)^bars, so ~1300+ bars ≈ fully converged
// (NSE ≈ 26×15m / 78×5m / 6.5×1h bars per trading day; Dhan caps intraday at 90d/call)
export const DEFAULT_DAYS: Record<CandleInterval, number> = {
  '1min': 4,
  '5min': 30,
  '15min': 60,
  '1h': 90,
  '1day': 2000,
};

const ymd = (d: Date) => d.toISOString().slice(0, 10);

export interface CandleTarget {
  securityId: string;
  exchangeSegment: string;
  symbol: string;
  /** Only F&O derivation reads it — pass '' when unknown (watches). */
  productType: string;
}

export async function fetchDhanCandles(
  creds: DhanCreds,
  target: CandleTarget,
  interval: CandleInterval,
  daysBack: number = DEFAULT_DAYS[interval],
  now: Date = new Date(),
): Promise<Candle[]> {
  const instrument = chartInstrument(target, 'position');
  const from = new Date(now.getTime() - daysBack * 24 * 3600 * 1000);
  const to = new Date(now.getTime() + 24 * 3600 * 1000);
  const isFno = target.exchangeSegment.toUpperCase().endsWith('_FNO');
  const base = {
    securityId: target.securityId,
    exchangeSegment: target.exchangeSegment,
    instrument,
    fromDate: ymd(from),
    toDate: ymd(to),
    oi: isFno,
  };
  return interval === '1day'
    ? dhan.getHistoricalChart(creds, base)
    : dhan.getIntradayChart(creds, { ...base, interval: INTRADAY_MINUTES[interval] });
}

const INTERVAL_SECONDS: Record<CandleInterval, number> = {
  '1min': 60,
  '5min': 300,
  '15min': 900,
  '1h': 3600,
  '1day': 86400,
};

/**
 * Drop a still-forming last bar so watch conditions are judged on CLOSED
 * candles only.
 * Dhan timestamps are the bar's open time (epoch seconds).
 */
export function dropFormingBar(candles: Candle[], interval: CandleInterval, now: Date = new Date()): Candle[] {
  if (candles.length === 0) return candles;
  const last = candles[candles.length - 1];
  const closesAt = (last.timestamp + INTERVAL_SECONDS[interval]) * 1000;
  return closesAt > now.getTime() ? candles.slice(0, -1) : candles;
}
