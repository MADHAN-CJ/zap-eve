// A chart selection is sent once as a full <chart_selection> block (CSV rows);
// while it stays active, follow-ups carry only a <chart_selection_ref/> line.
// Renderers strip both from bubbles and show a chip instead.

export interface SelectedCandle {
  time: number; // epoch seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface ChartSelection {
  symbol: string;
  exchangeSegment: string;
  interval: string;
  candles: SelectedCandle[];
}

export const SELECTION_CANDLE_CAP = 150;

const IST_OFFSET_MS = 5.5 * 3600 * 1000;

const istStamp = (epochS: number) =>
  new Date(epochS * 1000 + IST_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ');

function downsample(candles: SelectedCandle[]): { rows: SelectedCandle[]; sampled: boolean } {
  if (candles.length <= SELECTION_CANDLE_CAP) return { rows: candles, sampled: false };
  const step = (candles.length - 1) / (SELECTION_CANDLE_CAP - 1);
  const rows = Array.from({ length: SELECTION_CANDLE_CAP }, (_, i) => candles[Math.round(i * step)]);
  return { rows, sampled: true };
}

export function selectionBounds(sel: ChartSelection): { from: string; to: string } {
  return {
    from: istStamp(sel.candles[0].time),
    to: istStamp(sel.candles[sel.candles.length - 1].time),
  };
}

export function buildSelectionBlock(sel: ChartSelection): string {
  const { rows, sampled } = downsample(sel.candles);
  const { from, to } = selectionBounds(sel);
  const lines = rows
    .map((c) => `${istStamp(c.time)},${c.open},${c.high},${c.low},${c.close},${c.volume}`)
    .join('\n');
  return (
    `<chart_selection symbol="${sel.symbol}" segment="${sel.exchangeSegment}" interval="${sel.interval}" ` +
    `from="${from} IST" to="${to} IST" selected="${sel.candles.length}" rows="${rows.length}"` +
    `${sampled ? ' note="evenly downsampled from the selected range"' : ''}>\n` +
    `<columns>datetime_ist,open,high,low,close,volume</columns>\n<candles>\n${lines}\n</candles>\n</chart_selection>`
  );
}

export function buildSelectionRef(sel: ChartSelection): string {
  const { from, to } = selectionBounds(sel);
  return `<chart_selection_ref symbol="${sel.symbol}" interval="${sel.interval}" from="${from} IST" to="${to} IST" candles="${sel.candles.length}" note="same selection as sent earlier in this conversation"/>`;
}

const FULL_RE = /<chart_selection\s[^>]*>[\s\S]*?<\/chart_selection>\s*/;
const REF_RE = /<chart_selection_ref\s[^>]*\/>\s*/;

export interface SelectionChip {
  symbol: string;
  interval: string;
  from: string;
  to: string;
  count: string;
}

export function extractSelectionChip(text: string): { text: string; chip: SelectionChip | null } {
  const match = text.match(FULL_RE) ?? text.match(REF_RE);
  if (!match) return { text, chip: null };
  const tag = match[0];
  const attr = (name: string) => tag.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? '';
  return {
    text: text.replace(FULL_RE, '').replace(REF_RE, '').trim(),
    chip: {
      symbol: attr('symbol'),
      interval: attr('interval'),
      from: attr('from'),
      to: attr('to'),
      count: attr('selected') || attr('candles'),
    },
  };
}
