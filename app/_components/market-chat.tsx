'use client';

import React from 'react';
import type { IChartApi } from 'lightweight-charts';
import { authHeaders } from '@/lib/client/settings';
import type { PositionRef } from '@/lib/client/threads-api';
import {
  buildSelectionBlock,
  buildSelectionRef,
  selectionBounds,
  type ChartSelection,
} from '@/lib/chart-selection';
import { drawingsKey, loadDrawings, saveDrawings, type Drawing, type DrawingTool } from '@/lib/chart-drawings';
import { computeIndicators, INDICATOR_LABELS, INDICATOR_MIN_BARS, indicatorColumnsForRange, type IndicatorKey } from '@/lib/indicators';
import { applyDefaultZoom, InteractiveChart, smoothZoomBy, type ChartCandle, type LiveBarUpdate, type RangeSelection } from './interactive-chart';
import { ThreadChat, type ComposerAttachment } from './thread-chat';

type Interval = '1min' | '5min' | '15min' | '1h' | '1day';
type DataState = 'loading' | 'live' | 'error' | 'no_data_api' | 'not_connected';

const intervals: Array<{ label: string; value: Interval }> = [
  { label: '1m', value: '1min' },
  { label: '5m', value: '5min' },
  { label: '15m', value: '15min' },
  { label: '1h', value: '1h' },
  { label: '1D', value: '1day' },
];

const numberFormatter = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const volumeFormatter = new Intl.NumberFormat('en-IN', { notation: 'compact', maximumFractionDigits: 1 });
const IST_OFFSET_MS = 5.5 * 3600 * 1000;
const istLabel = (epochS: number) =>
  new Date(epochS * 1000 + IST_OFFSET_MS).toLocaleString('en-IN', { timeZone: 'UTC', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

const INTERVAL_SECONDS: Record<Interval, number> = { '1min': 60, '5min': 300, '15min': 900, '1h': 3600, '1day': 86400 };
const QUOTE_POLL_MS = 5000;
const INDICATORS_STORAGE_KEY = 'zap-eve.indicators.v1';

function loadStoredIndicators(): IndicatorKey[] {
  try {
    const raw = JSON.parse(localStorage.getItem(INDICATORS_STORAGE_KEY) ?? '[]') as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter((k): k is IndicatorKey => typeof k === 'string' && k in INDICATOR_LABELS);
  } catch {
    return [];
  }
}

function isNseMarketOpen(): boolean {
  const ist = new Date(Date.now() + IST_OFFSET_MS);
  const day = ist.getUTCDay();
  if (day === 0 || day === 6) return false;
  const minutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return minutes >= 9 * 60 + 15 && minutes <= 15 * 60 + 30;
}

const sameIstDay = (aEpochS: number, bEpochS: number) =>
  new Date(aEpochS * 1000 + IST_OFFSET_MS).toISOString().slice(0, 10) ===
  new Date(bEpochS * 1000 + IST_OFFSET_MS).toISOString().slice(0, 10);

// must match the MA period InteractiveChart renders
function lastMovingAverage(rows: ChartCandle[], period = 12): number {
  const slice = rows.slice(Math.max(0, rows.length - period));
  return slice.reduce((sum, c) => sum + c.close, 0) / slice.length;
}

export interface ThreadChatBinding {
  history: React.ComponentProps<typeof ThreadChat>['history'];
  session?: React.ComponentProps<typeof ThreadChat>['session'];
  starters?: React.ComponentProps<typeof ThreadChat>['starters'];
  onSessionCreated?: (eveSessionId: string) => void;
  onTurnSettled?: () => void;
}

export function MarketChat({
  position,
  chat,
  onOpenBroker,
}: {
  readonly position: PositionRef;
  readonly chat: ThreadChatBinding;
  readonly onOpenBroker: () => void;
}) {
  const [interval, setInterval] = React.useState<Interval>('15min');
  const [candles, setCandles] = React.useState<ChartCandle[]>([]);
  const [dataState, setDataState] = React.useState<DataState>('loading');
  const [dataMessage, setDataMessage] = React.useState('Fetching NSE candles…');
  const [hoveredCandle, setHoveredCandle] = React.useState<ChartCandle | null>(null);
  const [selection, setSelection] = React.useState<RangeSelection | null>(null);
  const [selectionSent, setSelectionSent] = React.useState(false);
  const [selectionMode, setSelectionMode] = React.useState(false);
  const [activeTool, setActiveTool] = React.useState<DrawingTool | null>(null);
  const [drawings, setDrawings] = React.useState<Drawing[]>([]);
  const [selectedDrawingId, setSelectedDrawingId] = React.useState<string | null>(null);
  const chartApiRef = React.useRef<IChartApi | null>(null);
  const liveRef = React.useRef<LiveBarUpdate | null>(null);
  // day-volume total at the live bar's start; live bar volume = day total − base
  const volumeBaseRef = React.useRef<number | null>(null);
  const resyncAtRef = React.useRef(0);
  const [liveTick, setLiveTick] = React.useState(0);
  const [activeIndicators, setActiveIndicators] = React.useState<IndicatorKey[]>([]);
  const [indicatorMenuOpen, setIndicatorMenuOpen] = React.useState(false);

  // restore persisted toggles after mount (not in the initializer — SSR/hydration)
  React.useEffect(() => {
    const stored = loadStoredIndicators();
    if (stored.length > 0) setActiveIndicators(stored);
  }, []);

  // drawings live per position+interval (D5)
  const storageKey = drawingsKey(position, interval);
  React.useEffect(() => {
    setDrawings(loadDrawings(storageKey));
    setSelectedDrawingId(null);
    setActiveTool(null);
  }, [storageKey]);

  const addDrawing = React.useCallback((drawing: Drawing) => {
    setDrawings((current) => {
      const next = [...current, drawing];
      saveDrawings(storageKey, next);
      return next;
    });
    setActiveTool(null); // one drawing per arm, like the real thing
    setSelectedDrawingId(drawing.id);
  }, [storageKey]);

  const deleteSelectedDrawing = React.useCallback(() => {
    setSelectedDrawingId((id) => {
      if (id !== null) {
        setDrawings((current) => {
          const next = current.filter((d) => d.id !== id);
          saveDrawings(storageKey, next);
          return next;
        });
      }
      return null;
    });
  }, [storageKey]);

  React.useEffect(() => {
    if (selectedDrawingId === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Delete' && event.key !== 'Backspace') return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      deleteSelectedDrawing();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [selectedDrawingId, deleteSelectedDrawing]);

  const armTool = (tool: DrawingTool) => {
    setActiveTool((current) => (current === tool ? null : tool));
    setSelectionMode(false);
    setSelectedDrawingId(null);
  };

  const loadCandles = React.useCallback(async () => {
    setDataState('loading');
    setDataMessage('Fetching candles from Dhan…');
    try {
      const qs = new URLSearchParams({
        securityId: position.securityId,
        exchangeSegment: position.exchangeSegment,
        productType: position.productType,
        symbol: position.symbol,
        interval,
      });
      const res = await fetch(`/api/broker/candles?${qs}`, { headers: authHeaders() });
      const payload = (await res.json().catch(() => null)) as
        | { candles?: ChartCandle[]; error?: string; code?: string }
        | null;
      if (res.status === 409) {
        if (payload?.code === 'DATA_API_NOT_SUBSCRIBED') {
          setCandles([]);
          setDataState('no_data_api');
          setDataMessage('This Dhan account has no Data-API subscription — subscribe on dhan.co to see charts. Chat still works.');
          return;
        }
        setCandles([]);
        setDataState('not_connected');
        setDataMessage(payload?.error ?? 'Dhan is not connected.');
        onOpenBroker();
        return;
      }
      if (!res.ok || !payload?.candles) throw new Error(payload?.error || 'Could not load candles.');
      const rows = payload.candles
        .map((c) => ({ ...c, time: Number((c as { timestamp?: number }).timestamp ?? c.time) }))
        .filter((c) => Number.isFinite(c.time) && Number.isFinite(c.close));
      setCandles(rows.slice(-1500)); // deep tail so EMA200 converges; render cost is fine
      volumeBaseRef.current = null;
      setDataState('live');
      setDataMessage(`Dhan data updated ${new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`);
    } catch (error) {
      setCandles([]);
      setDataState('error');
      setDataMessage(error instanceof Error ? error.message : 'Could not load market data.');
    }
  }, [position.securityId, position.exchangeSegment, position.productType, position.symbol, interval, onOpenBroker]);

  React.useEffect(() => {
    setSelection(null);
    setSelectionSent(false);
    void loadCandles();
  }, [loadCandles]);

  // Live bar: poll the quote endpoint during market hours and patch the last
  // candle in place (via liveRef → series.update) so pan/zoom survive.
  React.useEffect(() => {
    if (dataState !== 'live' || candles.length === 0) return;
    let stopped = false;
    const step = INTERVAL_SECONDS[interval];

    const tick = async () => {
      if (stopped || !isNseMarketOpen()) return;
      let quote: { lastPrice: number; volume: number } | null = null;
      try {
        const qs = new URLSearchParams({ securityId: position.securityId, exchangeSegment: position.exchangeSegment });
        const res = await fetch(`/api/broker/quote?${qs}`, { headers: authHeaders() });
        if (res.status === 409) {
          stopped = true;
          window.clearInterval(timer);
          return;
        }
        if (!res.ok) return;
        quote = ((await res.json()) as { quote?: { lastPrice: number; volume: number } }).quote ?? null;
      } catch {
        return; // transient network error — next tick retries
      }
      if (stopped || !quote || !Number.isFinite(quote.lastPrice)) return;

      const last = candles[candles.length - 1];
      const nowS = Math.floor(Date.now() / 1000);
      const ltp = quote.lastPrice;

      let bar: ChartCandle;
      if (interval === '1day') {
        // only today's forming daily bar; dailies are never rolled client-side
        if (!sameIstDay(last.time, nowS)) return;
        bar = { ...last, close: ltp, high: Math.max(last.high, ltp), low: Math.min(last.low, ltp), volume: quote.volume || last.volume };
        candles[candles.length - 1] = bar;
      } else if (nowS >= last.time + 2 * step) {
        // too far behind (e.g. market opened on stale data) — refetch rather than guess bars
        if (Date.now() - resyncAtRef.current > 60_000) {
          resyncAtRef.current = Date.now();
          void loadCandles();
        }
        return;
      } else {
        if (volumeBaseRef.current === null) volumeBaseRef.current = quote.volume - last.volume;
        if (nowS >= last.time + step) {
          volumeBaseRef.current = quote.volume;
          bar = { time: last.time + step, open: ltp, high: ltp, low: ltp, close: ltp, volume: 0 };
          candles.push(bar);
        } else {
          bar = { ...last, close: ltp, high: Math.max(last.high, ltp), low: Math.min(last.low, ltp), volume: Math.max(0, quote.volume - volumeBaseRef.current) };
          candles[candles.length - 1] = bar;
        }
      }
      liveRef.current?.(bar, lastMovingAverage(candles));
      setLiveTick((t) => t + 1);
      setDataMessage(`Live · ${new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`);
    };

    const timer = window.setInterval(() => void tick(), QUOTE_POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [dataState, candles, interval, position.securityId, position.exchangeSegment, loadCandles]);

  // recomputed on load AND on every live tick (candles is mutated in place)
  const indicatorData = React.useMemo(() => {
    void liveTick;
    return activeIndicators.length > 0 && candles.length > 0 ? computeIndicators(candles, activeIndicators) : undefined;
  }, [candles, activeIndicators, liveTick]);

  const toggleIndicator = (key: IndicatorKey) =>
    setActiveIndicators((current) => {
      const next = current.includes(key) ? current.filter((k) => k !== key) : [...current, key];
      try {
        localStorage.setItem(INDICATORS_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // storage unavailable (private mode) — toggles still work for the session
      }
      return next;
    });

  React.useEffect(() => {
    if (!indicatorMenuOpen) return;
    const close = (event: MouseEvent) => {
      if (!(event.target as HTMLElement | null)?.closest('.indicator-menu')) setIndicatorMenuOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [indicatorMenuOpen]);

  const latest = candles[candles.length - 1] ?? null;
  const first = candles[0] ?? null;
  const displayedCandle = hoveredCandle || latest;
  const displayedIndex = displayedCandle ? candles.findIndex((c) => c.time === displayedCandle.time) : -1;
  const change = latest && first ? latest.close - first.open : 0;
  const changePercent = latest && first && first.open ? (change / first.open) * 100 : 0;
  const iv = (values: Array<number | null> | undefined, digits = 2) => {
    const v = displayedIndex >= 0 ? values?.[displayedIndex] : null;
    return typeof v === 'number' ? v.toFixed(digits) : '—';
  };

  const handleSelection = React.useCallback((next: RangeSelection) => {
    setSelection(next);
    setSelectionSent(false);
  }, []);
  const clearSelection = React.useCallback(() => {
    setSelection(null);
    setSelectionSent(false);
  }, []);

  const chartSelection: ChartSelection | null = selection
    ? {
        symbol: position.symbol,
        exchangeSegment: position.exchangeSegment,
        interval: intervals.find((i) => i.value === interval)?.label ?? interval,
        candles: selection.candles,
        indicatorColumns: indicatorData ? indicatorColumnsForRange(indicatorData, selection.startIndex, selection.endIndex) : undefined,
      }
    : null;

  const attachment: ComposerAttachment | null = chartSelection
    ? {
        label: 'Chart context',
        sub:
          `${chartSelection.candles.length} selected candles · ${selectionBounds(chartSelection).from} → ${selectionBounds(chartSelection).to} IST` +
          (activeIndicators.length > 0 ? ` · with ${activeIndicators.map((k) => INDICATOR_LABELS[k]).join(', ')}` : ''),
        buildBlock: () => (selectionSent ? buildSelectionRef(chartSelection) : buildSelectionBlock(chartSelection)),
        onSent: () => setSelectionSent(true),
        onClear: clearSelection,
      }
    : null;

  return (
    <div className="mkts flex min-h-0 flex-1 flex-col">
      <div className="terminal-shell flex min-h-0 flex-1 flex-col">

        <div className="workspace min-h-0 flex-1" style={{ minHeight: 0 }}>
          <section aria-labelledby="instrument-heading" className="chart-workspace flex min-h-0 flex-col">
            <div className="instrument-row">
              <div>
                <div className="eyebrow">{position.exchangeSegment} · {position.productType}</div>
                <h1 id="instrument-heading">{position.symbol}</h1>
              </div>
              {latest ? (
                <div className="quote-block">
                  <strong>₹{numberFormatter.format(latest.close)}</strong>
                  <span className={change >= 0 ? 'positive' : 'negative'}>
                    {change >= 0 ? '+' : ''}{numberFormatter.format(change)} ({change >= 0 ? '+' : ''}{changePercent.toFixed(2)}%)
                  </span>
                </div>
              ) : null}
            </div>

            <div className="chart-toolbar">
              <div aria-label="Chart interval" className="intervals">
                {intervals.map((item) => (
                  <button className={interval === item.value ? 'active' : ''} key={item.value} onClick={() => setInterval(item.value)} type="button">{item.label}</button>
                ))}
              </div>
              <div className="toolbar-divider" />
              <button className={selectionMode ? 'active select-range-button' : 'select-range-button'} onClick={() => { setSelectionMode((a) => !a); setActiveTool(null); }} title="Select a candle range for the analyst" type="button">
                <span aria-hidden="true" className="icon">⌁</span> {selectionMode ? 'Selecting' : 'Select range'}
              </button>
              {selection && <button className="clear-selection" onClick={clearSelection} title="Clear selected candles" type="button">Clear selection</button>}
              <button className={activeTool === 'trend' ? 'active' : ''} onClick={() => armTool('trend')} title="Draw a trend line (drag between two points)" type="button">
                <span aria-hidden="true" className="icon">╱</span> Trend
              </button>
              <button className={activeTool === 'horizontal' ? 'active' : ''} onClick={() => armTool('horizontal')} title="Draw a horizontal price line (click a price)" type="button">
                <span aria-hidden="true" className="icon">─</span> Level
              </button>
              {selectedDrawingId ? (
                <button className="clear-selection" onClick={deleteSelectedDrawing} title="Delete the selected line (Del)" type="button">Delete line</button>
              ) : null}
              <div className="toolbar-divider" />
              <div className="indicator-menu">
                <button className={activeIndicators.length > 0 ? 'active' : ''} onClick={() => setIndicatorMenuOpen((o) => !o)} title="Toggle indicators" type="button">
                  <span aria-hidden="true" className="icon">∿</span> Indicators{activeIndicators.length > 0 ? ` · ${activeIndicators.length}` : ''}
                </button>
                {indicatorMenuOpen ? (
                  <div className="indicator-dropdown">
                    {(Object.keys(INDICATOR_LABELS) as IndicatorKey[]).map((key) => (
                      <label key={key}>
                        <input checked={activeIndicators.includes(key)} onChange={() => toggleIndicator(key)} type="checkbox" />
                        {INDICATOR_LABELS[key]}
                        {candles.length > 0 && candles.length < INDICATOR_MIN_BARS[key] ? (
                          <em className="indicator-nodata">needs {INDICATOR_MIN_BARS[key]} bars · have {candles.length}</em>
                        ) : null}
                      </label>
                    ))}
                  </div>
                ) : null}
              </div>
              <div className="toolbar-spacer" />
              <button disabled={dataState === 'loading'} onClick={() => void loadCandles()} title="Refresh market data" type="button"><span aria-hidden="true" className="icon">↻</span> Refresh</button>
            </div>

            <div aria-label="Open high low close values" className="quote-strip">
              <span className="candle-time">{hoveredCandle && displayedCandle ? istLabel(displayedCandle.time) : 'LATEST'}</span>
              {displayedCandle ? (
                <>
                  <span>O <b>₹{numberFormatter.format(displayedCandle.open)}</b></span>
                  <span>H <b>₹{numberFormatter.format(displayedCandle.high)}</b></span>
                  <span>L <b>₹{numberFormatter.format(displayedCandle.low)}</b></span>
                  <span>C <b className={displayedCandle.close >= displayedCandle.open ? 'positive' : 'negative'}>₹{numberFormatter.format(displayedCandle.close)}</b></span>
                  <span>VOL <b>{volumeFormatter.format(displayedCandle.volume)}</b></span>
                  {indicatorData?.ema50 && <span>EMA50 <b style={{ color: '#d97706' }}>{iv(indicatorData.ema50)}</b></span>}
                  {indicatorData?.ema200 && <span>EMA200 <b style={{ color: '#7c3aed' }}>{iv(indicatorData.ema200)}</b></span>}
                  {indicatorData?.bollinger && (
                    <span>BB <b style={{ color: '#5b8bc4' }}>{iv(indicatorData.bollinger.lower)} · {iv(indicatorData.bollinger.middle)} · {iv(indicatorData.bollinger.upper)}</b></span>
                  )}
                  {indicatorData?.rsi && <span>RSI <b style={{ color: '#7c3aed' }}>{iv(indicatorData.rsi, 1)}</b></span>}
                  {indicatorData?.macd && (
                    <span>MACD <b style={{ color: '#2a78d6' }}>{iv(indicatorData.macd.macd)}</b> / <b style={{ color: '#d97706' }}>{iv(indicatorData.macd.signal)}</b></span>
                  )}
                  {indicatorData?.dmi && (
                    <span>DMI <b style={{ color: '#0c6b3d' }}>+{iv(indicatorData.dmi.plusDi, 1)}</b> <b style={{ color: '#b3261e' }}>−{iv(indicatorData.dmi.minusDi, 1)}</b> ADX <b>{iv(indicatorData.dmi.adx, 1)}</b></span>
                  )}
                </>
              ) : null}
              <span className={`data-label ${dataState === 'live' ? 'live' : dataState === 'loading' ? 'loading' : 'error'}`}>
                {dataState === 'loading' ? 'SYNCING' : dataState === 'live' ? 'LIVE DATA' : dataState === 'no_data_api' ? 'NO DATA API' : dataState === 'not_connected' ? 'NOT CONNECTED' : 'DATA ERROR'}
              </span>
            </div>

            <div className="chart-stage min-h-0 flex-1">
              {candles.length > 0 ? (
                <>
                  <InteractiveChart
                    activeTool={activeTool}
                    candles={candles}
                    chartApiRef={chartApiRef}
                    drawings={drawings}
                    indicators={indicatorData}
                    onDrawingComplete={addDrawing}
                    onSelectDrawing={setSelectedDrawingId}
                    selectedDrawingId={selectedDrawingId}
                    liveRef={liveRef}
                    onHover={setHoveredCandle}
                    onSelection={handleSelection}
                    selection={selection}
                    selectionMode={selectionMode}
                    symbol={position.symbol}
                  />
                  {dataState === 'loading' ? (
                    <div aria-live="polite" className="chart-loading" role="status">
                      <span className="chart-spinner" />
                      Updating…
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="chart-empty">
                  {dataState === 'loading' ? (
                    <>
                      <span className="chart-spinner" />
                      Loading candles…
                    </>
                  ) : (
                    dataMessage
                  )}
                  {dataState === 'not_connected' ? (
                    <button className="footer-select-range" onClick={onOpenBroker} type="button">Connect Dhan</button>
                  ) : null}
                </div>
              )}
            </div>
            <footer className="chart-footer">
              <span className={dataState === 'error' || dataState === 'not_connected' ? 'negative' : ''}>{dataMessage}</span>
              <div className="chart-footer-actions">
                <div aria-label="Zoom controls" className="zoom-controls">
                  <button aria-label="Zoom out" disabled={candles.length === 0} onClick={() => chartApiRef.current && smoothZoomBy(chartApiRef.current, candles.length, 1.35)} title="Zoom out" type="button">−</button>
                  <button aria-label="Zoom in" disabled={candles.length === 0} onClick={() => chartApiRef.current && smoothZoomBy(chartApiRef.current, candles.length, 1 / 1.35)} title="Zoom in" type="button">+</button>
                  <button disabled={candles.length === 0} onClick={() => chartApiRef.current && applyDefaultZoom(chartApiRef.current, candles.length)} title="Back to the latest candles at default zoom" type="button">Reset view</button>
                </div>
                {selection ? (
                  <span className="selection-summary">{selection.candles.length} candles selected</span>
                ) : selectionMode ? (
                  <span>Drag across candles to select a range for the analyst</span>
                ) : activeTool === 'trend' ? (
                  <span>Drag between two points to draw a trend line</span>
                ) : activeTool === 'horizontal' ? (
                  <span>Click a price to drop a horizontal level</span>
                ) : null}
              </div>
            </footer>
          </section>

          <aside aria-labelledby="ai-heading" className="ai-panel">
            <div className="ai-context">
              <span>Analysing</span>
              <b>{position.symbol} · {position.exchangeSegment}</b>
              <span>{selection ? `${selection.candles.length}-candle selection` : `${intervals.find((i) => i.value === interval)?.label} chart`}</span>
            </div>

            <ThreadChat
              attachment={attachment}
              history={chat.history}
              onSessionCreated={chat.onSessionCreated}
              onTurnSettled={chat.onTurnSettled}
              position={position}
              session={chat.session}
              starters={chat.starters}
            />
            <p className="ai-disclaimer">Zap AI provides chart research, not financial advice. Read-only — it can never trade.</p>
          </aside>
        </div>
      </div>
    </div>
  );
}
