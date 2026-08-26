'use client';

import { useEffect, useRef, useState } from 'react';
import {
  CandlestickSeries,
  ColorType,
  createChart,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  type UTCTimestamp,
} from 'lightweight-charts';
import { CHART, compact, inr, pct } from './chart-theme';

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  openInterest?: number;
}

/** Dhan timestamps are epoch seconds; the chart renders UTC, so shift to IST for labels. */
const IST_OFFSET_S = 5.5 * 3600;

function prepare(candles: Candle[]): Candle[] {
  const byTime = new Map<number, Candle>();
  for (const c of candles) {
    if ([c.timestamp, c.open, c.high, c.low, c.close].every(Number.isFinite)) byTime.set(c.timestamp, c);
  }
  return [...byTime.values()].sort((a, b) => a.timestamp - b.timestamp);
}

export function CandleChart({
  candles,
  instrument,
  interval,
}: {
  readonly candles: Candle[];
  readonly instrument: string;
  /** Minutes for intraday; undefined for daily. */
  readonly interval?: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<Candle | null>(null);
  const data = prepare(candles);
  const first = data[0];
  const last = data[data.length - 1];
  const shown = hover ?? last;
  // F&O candles carry open interest; equities don't — the OI pane is conditional.
  const hasOI = data.some((c) => Number.isFinite(c.openInterest));

  useEffect(() => {
    const el = containerRef.current;
    if (!el || data.length < 2) return;

    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: CHART.text,
        fontSize: 11,
        attributionLogo: false,
      },
      grid: { vertLines: { visible: false }, horzLines: { color: CHART.grid, style: 1 } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderVisible: false },
      timeScale: {
        borderVisible: false,
        timeVisible: interval !== undefined,
        secondsVisible: false,
      },
      handleScroll: { vertTouchDrag: false },
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: CHART.surface,
      downColor: CHART.down,
      borderUpColor: CHART.up,
      borderDownColor: CHART.down,
      wickUpColor: CHART.up,
      wickDownColor: CHART.down,
      priceFormat: { type: 'price', precision: 2, minMove: 0.05 },
      // The readout above the chart shows the close; an axis label here only
      // collides with the tick labels.
      lastValueVisible: false,
    });
    // Panes tile exactly: candles / (OI line) / volume.
    candleSeries.priceScale().applyOptions({
      scaleMargins: hasOI ? { top: 0.1, bottom: 0.42 } : { top: 0.12, bottom: 0.25 },
    });

    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
      priceLineVisible: false,
      lastValueVisible: false,
    });
    chart.priceScale('volume').applyOptions({ scaleMargins: { top: hasOI ? 0.82 : 0.75, bottom: 0 } });

    if (hasOI) {
      const oiSeries = chart.addSeries(LineSeries, {
        color: CHART.oi,
        lineWidth: 2,
        priceScaleId: 'oi',
        priceFormat: { type: 'volume' },
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerRadius: 4,
      });
      chart.priceScale('oi').applyOptions({ scaleMargins: { top: 0.6, bottom: 0.2 } });
      oiSeries.setData(
        data
          .filter((c) => Number.isFinite(c.openInterest))
          .map((c) => ({ time: (c.timestamp + IST_OFFSET_S) as UTCTimestamp, value: c.openInterest as number })),
      );
    }

    const times = new Map<number, Candle>();
    candleSeries.setData(
      data.map((c) => {
        const time = (c.timestamp + IST_OFFSET_S) as UTCTimestamp;
        times.set(time, c);
        return { time, open: c.open, high: c.high, low: c.low, close: c.close };
      }),
    );
    volumeSeries.setData(
      data.map((c) => ({
        time: (c.timestamp + IST_OFFSET_S) as UTCTimestamp,
        value: c.volume,
        color: c.close >= c.open ? `${CHART.up}55` : `${CHART.down}55`,
      })),
    );
    chart.timeScale().setVisibleLogicalRange({ from: -1, to: data.length });

    chart.subscribeCrosshairMove((param) => {
      const t = typeof param.time === 'number' ? param.time : null;
      setHover(t !== null ? (times.get(t) ?? null) : null);
    });

    return () => chart.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles, interval, hasOI]);

  if (data.length < 2 || !first || !last) return null;

  const windowChange = last.close - first.open;
  const windowPct = first.open ? (windowChange / first.open) * 100 : 0;
  const high = Math.max(...data.map((c) => c.high));
  const low = Math.min(...data.map((c) => c.low));
  const up = shown.close >= shown.open;

  return (
    <figure className="rounded-lg border bg-card p-3">
      <figcaption className="mb-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="flex items-center gap-2 font-medium text-sm">
          {instrument} · {interval ? `${interval}m candles` : 'daily candles'} · {data.length} bars
          {hasOI ? (
            <span className="flex items-center gap-1 font-normal text-muted-foreground text-xs">
              <i className="inline-block h-0.5 w-3 rounded" style={{ background: CHART.oi }} /> OI
            </span>
          ) : null}
        </span>
        <span className="text-muted-foreground text-xs tabular-nums">
          window {inr(windowChange)} ({pct(windowPct)}) · high {inr(high)} · low {inr(low)}
        </span>
      </figcaption>
      <div className="mb-1 flex flex-wrap gap-x-3 text-xs tabular-nums" aria-live="polite">
        <span className="text-muted-foreground">{formatTime(shown.timestamp, interval !== undefined)}</span>
        <span>O {inr(shown.open)}</span>
        <span>H {inr(shown.high)}</span>
        <span>L {inr(shown.low)}</span>
        <span style={{ color: up ? CHART.up : CHART.down }}>
          C {inr(shown.close)}
        </span>
        <span className="text-muted-foreground">V {compact(shown.volume)}</span>
        {shown.openInterest !== undefined ? <span className="text-muted-foreground">OI {compact(shown.openInterest)}</span> : null}
      </div>
      <div className={hasOI ? 'h-80 w-full' : 'h-64 w-full'} ref={containerRef} />
    </figure>
  );
}

function formatTime(epochSeconds: number, withTime: boolean): string {
  const d = new Date(epochSeconds * 1000);
  return d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    ...(withTime ? { hour: '2-digit', minute: '2-digit', hour12: false } : { year: 'numeric' }),
  });
}
