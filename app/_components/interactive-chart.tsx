'use client';

import React from 'react';
import {
  CandlestickSeries,
  ColorType,
  createChart,
  HistogramSeries,
  LineSeries,
  type IChartApi,
  type Time,
} from 'lightweight-charts';

export interface ChartCandle {
  time: number; // epoch seconds; IST shift is display-only
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  openInterest?: number;
}

export interface RangeSelection {
  startIndex: number;
  endIndex: number;
  candles: ChartCandle[];
}

const IST_OFFSET_S = 5.5 * 3600;

export const DEFAULT_VISIBLE_CANDLES = 90;
const MIN_SPAN = 8;

function clampRange(from: number, to: number, count: number): { from: number; to: number } | null {
  if (to - from < MIN_SPAN) return null;
  const maxSpan = Math.max(count * 3, DEFAULT_VISIBLE_CANDLES);
  if (to - from > maxSpan) return null;
  return { from: Math.max(from, -count), to: Math.min(to, count * 2) };
}

export function zoomBy(chart: IChartApi, count: number, factor: number, anchor?: number): void {
  const ts = chart.timeScale();
  const range = ts.getVisibleLogicalRange();
  if (!range) return;
  const a = anchor ?? (range.from + range.to) / 2;
  const next = clampRange(a - (a - range.from) * factor, a + (range.to - a) * factor, count);
  if (next) ts.setVisibleLogicalRange(next);
}

export function smoothZoomBy(chart: IChartApi, count: number, factor: number): void {
  const steps = 8;
  const perStep = factor ** (1 / steps);
  let i = 0;
  const tick = () => {
    zoomBy(chart, count, perStep);
    if (++i < steps) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

export function applyDefaultZoom(chart: IChartApi, count: number): void {
  if (count > DEFAULT_VISIBLE_CANDLES) {
    chart.timeScale().setVisibleLogicalRange({ from: count - DEFAULT_VISIBLE_CANDLES - 0.5, to: count + 4 });
  } else {
    chart.timeScale().fitContent();
  }
}

function movingAverage(candles: ChartCandle[], period = 12) {
  return candles.map((_, index) => {
    const slice = candles.slice(Math.max(0, index - period + 1), index + 1);
    return slice.reduce((sum, candle) => sum + candle.close, 0) / slice.length;
  });
}

export function InteractiveChart({
  candles,
  symbol,
  selectionMode,
  selection,
  onHover,
  onSelection,
  chartApiRef,
}: {
  readonly candles: ChartCandle[];
  readonly symbol: string;
  readonly selectionMode: boolean;
  readonly selection: RangeSelection | null;
  readonly onHover: (candle: ChartCandle | null) => void;
  readonly onSelection: (selection: RangeSelection) => void;
  readonly chartApiRef: React.MutableRefObject<IChartApi | null>;
}) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const dragStartRef = React.useRef<number | null>(null);
  const [dragRange, setDragRange] = React.useState<{ start: number; end: number } | null>(null);
  // bumped on pan/zoom/resize so the highlight re-derives its pixel position
  const [viewVersion, setViewVersion] = React.useState(0);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container || candles.length === 0) return;
    const chart = createChart(container, {
      width: container.clientWidth,
      height: container.clientHeight,
      layout: { background: { type: ColorType.Solid, color: '#ffffff' }, textColor: '#6f7d75', fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif', fontSize: 11 },
      grid: { vertLines: { color: '#eef2ef' }, horzLines: { color: '#eef2ef' } },
      rightPriceScale: { borderColor: '#e2e8e4', minimumWidth: 78 },
      timeScale: { borderColor: '#e2e8e4', timeVisible: true, secondsVisible: false, rightOffset: 4, barSpacing: 8 },
      crosshair: { mode: 0, vertLine: { color: '#9aa8a0', width: 1, style: 2, labelBackgroundColor: '#14201a' }, horzLine: { color: '#9aa8a0', width: 1, style: 2, labelBackgroundColor: '#14201a' } },
      // built-in wheel zoom is too coarse; handled by our own listener below
      handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
      handleScale: { axisPressedMouseMove: true, mouseWheel: false, pinch: true },
    });
    chartApiRef.current = chart;
    const candleSeries = chart.addSeries(CandlestickSeries, { upColor: '#0c6b3d', downColor: '#b3261e', borderVisible: false, wickUpColor: '#0c6b3d', wickDownColor: '#b3261e', priceLineColor: '#6f7d75', priceLineStyle: 2 });
    const volumeSeries = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: 'volume', lastValueVisible: false, priceLineVisible: false });
    const averageSeries = chart.addSeries(LineSeries, { color: '#2a78d6', lineWidth: 2, crosshairMarkerVisible: false, lastValueVisible: false, priceLineVisible: false });
    chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.78, bottom: 0 }, visible: false });

    const displayTime = (c: ChartCandle) => (c.time + IST_OFFSET_S) as Time;
    candleSeries.setData(candles.map((c) => ({ time: displayTime(c), open: c.open, high: c.high, low: c.low, close: c.close })));
    volumeSeries.setData(candles.map((c) => ({ time: displayTime(c), value: c.volume, color: c.close >= c.open ? '#0c6b3d40' : '#b3261e33' })));
    averageSeries.setData(movingAverage(candles).map((value, index) => ({ time: displayTime(candles[index]), value })));
    applyDefaultZoom(chart, candles.length);

    chart.subscribeCrosshairMove((parameter) => {
      const hit = parameter.seriesData.get(candleSeries);
      if (!hit || parameter.time === undefined) { onHover(null); return; }
      onHover(candles.find((c) => c.time + IST_OFFSET_S === Number(parameter.time)) || null);
    });
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const ts = chart.timeScale();
      const range = ts.getVisibleLogicalRange();
      if (!range) return;
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        const barWidth = container.clientWidth / Math.max(1, range.to - range.from);
        const shift = event.deltaX / Math.max(1, barWidth);
        const next = clampRange(range.from + shift, range.to + shift, candles.length);
        if (next) ts.setVisibleLogicalRange(next);
        return;
      }
      const factor = Math.exp(event.deltaY * 0.0016);
      const x = event.clientX - container.getBoundingClientRect().left;
      const anchor = ts.coordinateToLogical(x);
      zoomBy(chart, candles.length, factor, anchor === null ? undefined : anchor);
    };
    container.addEventListener('wheel', onWheel, { passive: false });

    const bumpView = () => setViewVersion((v) => v + 1);
    chart.timeScale().subscribeVisibleLogicalRangeChange(bumpView);
    const resize = new ResizeObserver(([entry]) => {
      chart.applyOptions({ width: entry.contentRect.width, height: entry.contentRect.height });
      bumpView();
    });
    resize.observe(container);
    return () => { container.removeEventListener('wheel', onWheel); resize.disconnect(); chart.remove(); chartApiRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles, chartApiRef, onHover]);

  function indexForPointer(event: React.PointerEvent<HTMLDivElement>): number {
    const chart = chartApiRef.current;
    const { left } = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - left;
    const logical = chart?.timeScale().coordinateToLogical(x);
    const raw = logical === null || logical === undefined ? 0 : Math.round(logical);
    return Math.min(candles.length - 1, Math.max(0, raw));
  }

  function startSelection(event: React.PointerEvent<HTMLDivElement>) {
    if (!selectionMode) return;
    try {
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      dragStartRef.current = indexForPointer(event);
      setDragRange({ start: dragStartRef.current, end: dragStartRef.current });
    } catch {
      dragStartRef.current = null;
      setDragRange(null);
    }
  }

  function moveSelection(event: React.PointerEvent<HTMLDivElement>) {
    if (!selectionMode || dragStartRef.current === null) return;
    event.preventDefault();
    event.stopPropagation();
    const end = indexForPointer(event);
    setDragRange((current) => (current ? { ...current, end } : null));
  }

  function endSelection(event: React.PointerEvent<HTMLDivElement>) {
    if (!selectionMode || dragStartRef.current === null) return;
    try {
      event.preventDefault();
      event.stopPropagation();
      const from = Math.min(dragStartRef.current, indexForPointer(event));
      const to = Math.max(dragStartRef.current, indexForPointer(event));
      const selected = candles.slice(from, to + 1);
      if (selected.length) onSelection({ startIndex: from, endIndex: to, candles: selected });
    } finally {
      dragStartRef.current = null;
      setDragRange(null);
    }
  }

  function pixelsForRange(range: { start: number; end: number }): { left: number; width: number } | null {
    void viewVersion; // re-run when the view changes
    const timeScale = chartApiRef.current?.timeScale();
    if (!timeScale) return null;
    const a = timeScale.logicalToCoordinate(Math.min(range.start, range.end) as never);
    const b = timeScale.logicalToCoordinate(Math.max(range.start, range.end) as never);
    if (a === null || b === null) return null;
    const half = 4;
    return { left: a - half, width: Math.max(2, b - a + half * 2) };
  }

  const highlight = dragRange
    ? pixelsForRange(dragRange)
    : selection
      ? pixelsForRange({ start: selection.startIndex, end: selection.endIndex })
      : null;

  return (
    <div className="interactive-chart-shell">
      <div aria-label={`Interactive ${symbol} candlestick chart. Drag to pan, use scroll or pinch to zoom, and hover candles for OHLC values.`} className="trading-chart" ref={containerRef} role="img" />
      <div className={`range-capture ${selectionMode ? 'active' : ''}`} onPointerDown={startSelection} onPointerMove={moveSelection} onPointerUp={endSelection}>
        {highlight && <span className="range-highlight" style={{ left: highlight.left, width: highlight.width }} />}
      </div>
    </div>
  );
}
