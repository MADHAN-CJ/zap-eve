// A chart selection is sent once as a full <chart_selection> block (CSV rows);
// while it stays active, follow-ups carry only a <chart_selection_ref/> line.
// Renderers strip both from bubbles and show a chip instead.

import {
  CHART_CONTEXT_RE,
  SELECTION_FULL_RE as FULL_RE,
  SELECTION_REF_RE as REF_RE,
} from '@/agent/lib/selection-markup';

/**
 * Invisible one-liner appended to every message sent from the chart screen so
 * the agent knows the chart's interval + toggled indicators (it cannot see
 * localStorage). Stripped from bubbles and titles like the other markup.
 */
export function buildChartContext(interval: string, indicators: readonly string[]): string {
  return `<chart_context interval="${interval}" indicators="${indicators.join(',')}"/>`;
}

export interface SelectedCandle {
  time: number; // epoch seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** One extra CSV column of indicator values, aligned 1:1 with `candles`. */
export interface IndicatorColumn {
  name: string; // CSV column name, e.g. "ema50", "rsi14", "macd_sig"
  values: Array<number | null>; // null = still warming up at that bar
}

export interface ChartSelection {
  symbol: string;
  exchangeSegment: string;
  interval: string;
  candles: SelectedCandle[];
  /** Values of the indicators the user has toggled on (P6). */
  indicatorColumns?: IndicatorColumn[];
}

export const SELECTION_CANDLE_CAP = 150;

const IST_OFFSET_MS = 5.5 * 3600 * 1000;

const istStamp = (epochS: number) =>
  new Date(epochS * 1000 + IST_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ');

/** Evenly sampled row indices so candles and indicator columns stay in step. */
function sampleIndices(length: number): { indices: number[]; sampled: boolean } {
  if (length <= SELECTION_CANDLE_CAP) return { indices: Array.from({ length }, (_, i) => i), sampled: false };
  const step = (length - 1) / (SELECTION_CANDLE_CAP - 1);
  return { indices: Array.from({ length: SELECTION_CANDLE_CAP }, (_, i) => Math.round(i * step)), sampled: true };
}

export function selectionBounds(sel: ChartSelection): { from: string; to: string } {
  return {
    from: istStamp(sel.candles[0].time),
    to: istStamp(sel.candles[sel.candles.length - 1].time),
  };
}

export function buildSelectionBlock(sel: ChartSelection): string {
  const { indices, sampled } = sampleIndices(sel.candles.length);
  const { from, to } = selectionBounds(sel);
  const extras = sel.indicatorColumns ?? [];
  const cell = (v: number | null | undefined) => (typeof v === 'number' ? v.toFixed(2) : '');
  const lines = indices
    .map((i) => {
      const c = sel.candles[i];
      const base = `${istStamp(c.time)},${c.open},${c.high},${c.low},${c.close},${c.volume}`;
      return extras.length ? `${base},${extras.map((col) => cell(col.values[i])).join(',')}` : base;
    })
    .join('\n');
  const columns = ['datetime_ist,open,high,low,close,volume', ...extras.map((col) => col.name)].join(',');
  return (
    `<chart_selection symbol="${sel.symbol}" segment="${sel.exchangeSegment}" interval="${sel.interval}" ` +
    `from="${from} IST" to="${to} IST" selected="${sel.candles.length}" rows="${indices.length}"` +
    `${extras.length ? ` indicators="${extras.map((col) => col.name).join(',')}"` : ''}` +
    `${sampled ? ' note="evenly downsampled from the selected range"' : ''}>\n` +
    `<columns>${columns}</columns>\n<candles>\n${lines}\n</candles>\n</chart_selection>`
  );
}

export function buildSelectionRef(sel: ChartSelection): string {
  const { from, to } = selectionBounds(sel);
  return `<chart_selection_ref symbol="${sel.symbol}" interval="${sel.interval}" from="${from} IST" to="${to} IST" candles="${sel.candles.length}" note="same selection as sent earlier in this conversation"/>`;
}

export interface SelectionChip {
  symbol: string;
  interval: string;
  from: string;
  to: string;
  count: string;
}

export function extractSelectionChip(text: string): { text: string; chip: SelectionChip | null } {
  // The chart_context line is never shown, selection or not.
  const cleaned = text.replace(CHART_CONTEXT_RE, '');
  const match = cleaned.match(FULL_RE) ?? cleaned.match(REF_RE);
  if (!match) return { text: cleaned, chip: null };
  const tag = match[0];
  const attr = (name: string) => tag.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? '';
  return {
    text: cleaned.replace(FULL_RE, '').replace(REF_RE, '').trim(),
    chip: {
      symbol: attr('symbol'),
      interval: attr('interval'),
      from: attr('from'),
      to: attr('to'),
      count: attr('selected') || attr('candles'),
    },
  };
}
