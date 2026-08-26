/**
 * Chart colors — validated with the dataviz palette checker (light surface):
 *  - UP/DOWN is a polarity pair (ΔE 26 normal, 7.7 deutan → shape encoding
 *    required: up candles are hollow, down candles filled).
 *  - CE/PE is a categorical pair (ΔE 34 normal, 25 CVD) — legend + direct
 *    labels always shown.
 *  - OI (violet) is the lone series on its own pane; the header chip names it.
 */
export const CHART = {
  up: '#0c6b3d',
  down: '#b3261e',
  ce: '#2a78d6',
  pe: '#eb6834',
  oi: '#4a3aa7',
  text: '#6f7d75',
  grid: '#e2e8e4',
  ink: '#14201a',
  surface: '#ffffff',
} as const;

const inrFmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });
const compactFmt = new Intl.NumberFormat('en-IN', { notation: 'compact', maximumFractionDigits: 1 });

export const inr = (n: number) => `₹${inrFmt.format(n)}`;
export const compact = (n: number) => compactFmt.format(n);
export const pct = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
