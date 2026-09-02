/**
 * Market-watch condition DSL (docs/plan-watcher.md §1). A `levels` watch is a
 * set of numeric conditions the sweeper evaluates with pure math; an
 * `ai_check` watch has no conditions — the AI re-judges the chart on a fixed
 * cadence instead.
 */

/** Everything a condition can measure, computed from closed candles. */
export type WatchMetric =
  | 'price' // close of the last closed candle
  | 'ema50'
  | 'ema200'
  | 'rsi14'
  | 'macd_line'
  | 'macd_signal'
  | 'macd_hist'
  | 'bb_upper'
  | 'bb_middle'
  | 'bb_lower'
  | 'adx14'
  | 'di_plus'
  | 'di_minus';

export type WatchComparator = 'above' | 'below' | 'crosses_above' | 'crosses_below';

export interface WatchCondition {
  metric: WatchMetric;
  comparator: WatchComparator;
  /** A fixed level, or another metric (e.g. ema50 crosses_above ema200). */
  target: number | WatchMetric;
}

/** any = alert when any one condition trips; all = only when every one holds. */
export type WatchMode = 'any' | 'all';

export type WatchKind = 'levels' | 'ai_check';

export type WatchStatus = 'ARMED' | 'PAUSED' | 'ERROR' | 'EXPIRED' | 'CANCELLED';

/** ai_check repeat-alert latch: email only on a not_met → met transition. */
export type WatchVerdict = 'met' | 'not_met';

/** Metric values recorded at the last sweep (null = indicator still warming up). */
export type WatchValues = Partial<Record<WatchMetric, number | null>>;

/**
 * Edge-trigger state (W7): a tripped condition is latched until observed
 * un-met, so a level that stays crossed can't re-fire every sweep.
 * `conditions[i]` latches per condition (mode 'any'); `combined` latches the
 * whole predicate (mode 'all').
 */
export interface WatchLatched {
  combined: boolean;
  conditions: boolean[];
}
