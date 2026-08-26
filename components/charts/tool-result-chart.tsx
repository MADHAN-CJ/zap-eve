'use client';

import { CandleChart, type Candle } from './candle-chart';
import { OptionChainChart, type ChainStrike } from './option-chain-chart';

/**
 * Renders a chart under a tool card when the tool's result carries plottable
 * data. Used for both the live stream and reloaded history (same JSON). Any
 * shape mismatch or `{ error }` result renders nothing — the card is unchanged.
 */
export function ToolResultChart({ toolName, output }: { readonly toolName: string; readonly output: unknown }) {
  const data = normalize(output);
  if (!data || 'error' in data) return null;

  if (toolName === 'get_daily_candles' || toolName === 'get_intraday_candles') {
    const candles = Array.isArray(data.candles) ? (data.candles as Candle[]) : [];
    if (candles.length < 2) return null;
    return (
      <CandleChart
        candles={candles}
        instrument={String(data.instrument ?? '')}
        interval={toolName === 'get_intraday_candles' ? Number(data.interval) || 15 : undefined}
      />
    );
  }

  if (toolName === 'get_option_chain') {
    const strikes = Array.isArray(data.strikes) ? (data.strikes as ChainStrike[]) : [];
    const spot = Number(data.underlyingLastPrice);
    if (strikes.length < 2 || !Number.isFinite(spot)) return null;
    return (
      <OptionChainChart
        expiry={typeof data.expiry === 'string' ? data.expiry : undefined}
        strikes={strikes}
        underlyingLastPrice={spot}
      />
    );
  }

  return null;
}

function normalize(output: unknown): Record<string, unknown> | null {
  let value = output;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
