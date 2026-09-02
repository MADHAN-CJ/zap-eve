import {
  computeBollinger,
  computeDmi,
  computeEma,
  computeMacd,
  computeRsi,
  type IndicatorCandle,
} from '../../../lib/indicators';
import type {
  WatchCondition,
  WatchLatched,
  WatchMetric,
  WatchMode,
  WatchValues,
} from './types';

/**
 * Pure-math evaluation of a levels watch against closed candles — zero AI
 * cost per sweep (W3). Semantics (docs/plan-watcher.md §1):
 *
 * - The very first sweep after (re)arm only records a BASELINE: values are
 *   stored, nothing fires, and any condition that is ALREADY met starts
 *   latched — a level that was true at arm time must reset before it can
 *   alert (the user asked to be told when something happens, not about the
 *   state of the world at arm time).
 * - `crosses_*` compares this sweep's values against the PREVIOUS SWEEP's
 *   (`lastValues`), not the previous bar — robust to sweep gaps: a cross that
 *   happened while the ticker was down still fires on the next sweep.
 * - Edge-trigger latch (W7): mode 'any' latches per condition (A staying
 *   tripped must not mute a later trip of B); mode 'all' latches the combined
 *   predicate. Latches release only when the condition is OBSERVED un-met
 *   with valid values — a warm-up null neither fires, latches, nor releases.
 */

export interface EvaluateInput {
  conditions: WatchCondition[];
  mode: WatchMode;
  /** Closed candles, oldest → newest, at the watch's interval. */
  candles: IndicatorCandle[];
  /** Values recorded by the previous sweep; null/undefined = first sweep. */
  lastValues: WatchValues | null | undefined;
  latched: WatchLatched | null | undefined;
}

export interface EvaluateResult {
  fired: boolean;
  /** Condition indexes that caused this fire (any-mode; all indexes in all-mode). */
  firedConditions: number[];
  /** Per-condition truth this sweep (null-valued metrics evaluate false). */
  met: boolean[];
  /** Store back as lastValues — next sweep's crossing baseline. */
  values: WatchValues;
  /** Store back as latched. */
  latched: WatchLatched;
  /** True when this sweep only recorded the baseline (never fires). */
  baseline: boolean;
}

/** The metrics a condition set reads (left sides + metric targets). */
export function metricsUsed(conditions: readonly WatchCondition[]): WatchMetric[] {
  const set = new Set<WatchMetric>();
  for (const c of conditions) {
    set.add(c.metric);
    if (typeof c.target === 'string') set.add(c.target);
  }
  return [...set];
}

/** Latest value of every referenced metric, computed from the candle window. */
export function computeMetricValues(
  candles: IndicatorCandle[],
  metrics: readonly WatchMetric[],
): WatchValues {
  const closes = candles.map((c) => c.close);
  const last = <T>(series: readonly T[]): T | null =>
    series.length > 0 ? series[series.length - 1] : null;

  const values: WatchValues = {};
  const want = new Set(metrics);
  if (want.has('price')) values.price = last(closes);
  if (want.has('ema50')) values.ema50 = last(computeEma(closes, 50));
  if (want.has('ema200')) values.ema200 = last(computeEma(closes, 200));
  if (want.has('rsi14')) values.rsi14 = last(computeRsi(closes));
  if (want.has('macd_line') || want.has('macd_signal') || want.has('macd_hist')) {
    const macd = computeMacd(closes);
    if (want.has('macd_line')) values.macd_line = last(macd.macd);
    if (want.has('macd_signal')) values.macd_signal = last(macd.signal);
    if (want.has('macd_hist')) values.macd_hist = last(macd.histogram);
  }
  if (want.has('bb_upper') || want.has('bb_middle') || want.has('bb_lower')) {
    const bb = computeBollinger(closes);
    if (want.has('bb_upper')) values.bb_upper = last(bb.upper);
    if (want.has('bb_middle')) values.bb_middle = last(bb.middle);
    if (want.has('bb_lower')) values.bb_lower = last(bb.lower);
  }
  if (want.has('adx14') || want.has('di_plus') || want.has('di_minus')) {
    const dmi = computeDmi(candles);
    if (want.has('adx14')) values.adx14 = last(dmi.adx);
    if (want.has('di_plus')) values.di_plus = last(dmi.plusDi);
    if (want.has('di_minus')) values.di_minus = last(dmi.minusDi);
  }
  return values;
}

const valueOf = (values: WatchValues, metric: WatchMetric): number | null =>
  values[metric] ?? null;

const targetOf = (values: WatchValues, target: number | WatchMetric): number | null =>
  typeof target === 'number' ? target : valueOf(values, target);

/** Truth of one condition given current (and, for crosses, previous) values. */
function conditionMet(c: WatchCondition, cur: WatchValues, prev: WatchValues | null): boolean {
  const left = valueOf(cur, c.metric);
  const right = targetOf(cur, c.target);
  if (left === null || right === null) return false; // warm-up → inert
  switch (c.comparator) {
    case 'above':
      return left > right;
    case 'below':
      return left < right;
    case 'crosses_above': {
      if (!prev) return false; // no baseline for this metric yet
      const prevLeft = valueOf(prev, c.metric);
      const prevRight = targetOf(prev, c.target);
      if (prevLeft === null || prevRight === null) return false;
      return prevLeft <= prevRight && left > right;
    }
    case 'crosses_below': {
      if (!prev) return false;
      const prevLeft = valueOf(prev, c.metric);
      const prevRight = targetOf(prev, c.target);
      if (prevLeft === null || prevRight === null) return false;
      return prevLeft >= prevRight && left < right;
    }
  }
}

/** Whether the condition's value(s) were observable this sweep (non-null). */
function conditionObservable(c: WatchCondition, cur: WatchValues): boolean {
  return valueOf(cur, c.metric) !== null && targetOf(cur, c.target) !== null;
}

export function evaluateWatch(input: EvaluateInput): EvaluateResult {
  const { conditions, mode, candles, lastValues } = input;
  const values = computeMetricValues(candles, metricsUsed(conditions));

  // First sweep after (re)arm: record baseline; already-true conditions latch.
  if (!lastValues) {
    const met = conditions.map((c) => conditionMet(c, values, null));
    return {
      fired: false,
      firedConditions: [],
      met,
      values,
      latched: { combined: mode === 'all' ? met.every(Boolean) : false, conditions: met },
      baseline: true,
    };
  }

  const latched: WatchLatched = {
    combined: input.latched?.combined ?? false,
    conditions: conditions.map((_, i) => input.latched?.conditions[i] ?? false),
  };

  const met = conditions.map((c) => conditionMet(c, values, lastValues));
  const combinedMet = mode === 'all' ? met.every(Boolean) : met.some(Boolean);

  // Release latches only on an OBSERVED un-met — nulls keep the latch.
  for (let i = 0; i < conditions.length; i++) {
    if (latched.conditions[i] && !met[i] && conditionObservable(conditions[i], values)) {
      latched.conditions[i] = false;
    }
  }
  if (latched.combined && !combinedMet) {
    // The ALL-predicate is definitively false once any condition is OBSERVED
    // un-met; nulls alone (warm-up) never release the latch.
    const definitelyFalse = conditions.some((c, i) => !met[i] && conditionObservable(c, values));
    if (definitelyFalse) latched.combined = false;
  }

  let fired = false;
  let firedConditions: number[] = [];
  if (mode === 'all') {
    if (combinedMet && !latched.combined) {
      fired = true;
      firedConditions = conditions.map((_, i) => i);
      latched.combined = true;
    }
  } else {
    firedConditions = met
      .map((m, i) => (m && !latched.conditions[i] ? i : -1))
      .filter((i) => i >= 0);
    fired = firedConditions.length > 0;
    if (fired) {
      // Latch every currently-met condition, not just the firers — they were
      // all part of this alert's world state and must reset before re-firing.
      for (let i = 0; i < met.length; i++) if (met[i]) latched.conditions[i] = true;
    }
  }

  return { fired, firedConditions, met, values, latched, baseline: false };
}
