// dist import on purpose: the package's `module` field points at raw TS
// (src/index.ts), which Turbopack refuses to load
import { IndicatorsSync } from '@ixjb94/indicators/dist/index.js';

// Batch indicator math for the chart (plan docs/plan-indicators-drawings.md, P1).
// All outputs are aligned to the input candle array: same length, leading nulls
// until the indicator has warmed up. Recomputed on every candle load; only
// closed candles should be fed here (the live bar is patched separately).

export interface IndicatorCandle {
  high: number;
  low: number;
  close: number;
}

export type IndicatorSeriesValues = Array<number | null>;

export interface MacdResult {
  macd: IndicatorSeriesValues;
  signal: IndicatorSeriesValues;
  histogram: IndicatorSeriesValues;
}

export interface BollingerResult {
  upper: IndicatorSeriesValues;
  middle: IndicatorSeriesValues;
  lower: IndicatorSeriesValues;
}

export interface DmiResult {
  plusDi: IndicatorSeriesValues;
  minusDi: IndicatorSeriesValues;
  adx: IndicatorSeriesValues;
}

export type IndicatorKey = 'ema50' | 'ema200' | 'bollinger' | 'rsi' | 'macd' | 'dmi';

/** Computed values for the active indicators, keyed like the toggles. */
export interface IndicatorData {
  ema50?: IndicatorSeriesValues;
  ema200?: IndicatorSeriesValues;
  bollinger?: BollingerResult;
  rsi?: IndicatorSeriesValues;
  macd?: MacdResult;
  dmi?: DmiResult;
}

export function computeIndicators(
  candles: IndicatorCandle[],
  active: readonly IndicatorKey[],
): IndicatorData {
  const closes = candles.map((c) => c.close);
  const data: IndicatorData = {};
  if (active.includes('ema50')) data.ema50 = computeEma(closes, 50);
  if (active.includes('ema200')) data.ema200 = computeEma(closes, 200);
  if (active.includes('bollinger')) data.bollinger = computeBollinger(closes);
  if (active.includes('rsi')) data.rsi = computeRsi(closes);
  if (active.includes('macd')) data.macd = computeMacd(closes);
  if (active.includes('dmi')) data.dmi = computeDmi(candles);
  return data;
}

export const INDICATOR_LABELS: Record<IndicatorKey, string> = {
  ema50: 'EMA 50',
  ema200: 'EMA 200',
  bollinger: 'Bollinger (20, 2)',
  rsi: 'RSI 14',
  macd: 'MACD (12, 26, 9)',
  dmi: 'DMI 14',
};

/** Closed candles needed before the indicator has its first value. */
export const INDICATOR_MIN_BARS: Record<IndicatorKey, number> = {
  ema50: 50,
  ema200: 200,
  bollinger: 20,
  rsi: 15,
  macd: 35, // long EMA (26) + signal (9)
  dmi: 29, // period × 2 + 1 (DI warm-up + ADX seed)
};

const ta = new IndicatorsSync();

/** Right-align `values` to `length` entries, null-padding the warm-up gap. */
function padFront(values: number[], length: number): IndicatorSeriesValues {
  const offset = length - values.length;
  if (offset < 0) throw new Error(`indicator output longer than input (${values.length} > ${length})`);
  return [...Array<null>(offset).fill(null), ...values];
}

export function computeEma(closes: number[], period: number): IndicatorSeriesValues {
  if (closes.length < period) return closes.map(() => null);
  return padFront(ta.ema(closes, period), closes.length);
}

export function computeRsi(closes: number[], period = 14): IndicatorSeriesValues {
  if (closes.length <= period) return closes.map(() => null);
  return padFront(ta.rsi(closes, period), closes.length);
}

export function computeMacd(closes: number[], short = 12, long = 26, signalPeriod = 9): MacdResult {
  const empty = closes.map(() => null);
  if (closes.length < long + signalPeriod) return { macd: empty, signal: empty, histogram: empty };
  const [macd, signal, histogram] = ta.macd(closes, short, long, signalPeriod);
  return {
    macd: padFront(macd, closes.length),
    signal: padFront(signal, closes.length),
    histogram: padFront(histogram, closes.length),
  };
}

export function computeBollinger(closes: number[], period = 20, stddev = 2): BollingerResult {
  const empty = closes.map(() => null);
  if (closes.length < period) return { upper: empty, middle: empty, lower: empty };
  const [lower, middle, upper] = ta.bbands(closes, period, stddev);
  return {
    upper: padFront(upper, closes.length),
    middle: padFront(middle, closes.length),
    lower: padFront(lower, closes.length),
  };
}

/**
 * +DI/−DI from the library; ADX derived as Wilder's smoothing of
 * DX = 100·|+DI − −DI| / (+DI + −DI), seeded with the SMA of the first
 * `period` DX values. (The library's own adx() is Tulip-style — high/low
 * only, no true range — which diverges from the TradingView convention;
 * the derived version is cross-checked against trading-signals in
 * scripts/test-indicators.ts.)
 */
export function computeDmi(candles: IndicatorCandle[], period = 14): DmiResult {
  const empty = candles.map(() => null);
  if (candles.length <= period * 2) return { plusDi: empty, minusDi: empty, adx: empty };
  const high = candles.map((c) => c.high);
  const low = candles.map((c) => c.low);
  const close = candles.map((c) => c.close);
  const [plusDi, minusDi] = ta.di(high, low, close, period);

  const dx = plusDi.map((p, i) => {
    const sum = p + minusDi[i];
    return sum === 0 ? 0 : (100 * Math.abs(p - minusDi[i])) / sum;
  });
  const adx: number[] = [];
  if (dx.length >= period) {
    let value = dx.slice(0, period).reduce((sum, v) => sum + v, 0) / period;
    adx.push(value);
    for (let i = period; i < dx.length; i++) {
      value = (value * (period - 1) + dx[i]) / period;
      adx.push(value);
    }
  }
  return {
    plusDi: padFront(plusDi, candles.length),
    minusDi: padFront(minusDi, candles.length),
    adx: padFront(adx, candles.length),
  };
}
