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
import { applyDefaultZoom, InteractiveChart, smoothZoomBy, type ChartCandle, type RangeSelection } from './interactive-chart';
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
  const chartApiRef = React.useRef<IChartApi | null>(null);

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
      setCandles(rows.slice(-500));
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

  const latest = candles[candles.length - 1] ?? null;
  const first = candles[0] ?? null;
  const displayedCandle = hoveredCandle || latest;
  const change = latest && first ? latest.close - first.open : 0;
  const changePercent = latest && first && first.open ? (change / first.open) * 100 : 0;

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
      }
    : null;

  const attachment: ComposerAttachment | null = chartSelection
    ? {
        label: 'Chart context',
        sub: `${chartSelection.candles.length} selected candles · ${selectionBounds(chartSelection).from} → ${selectionBounds(chartSelection).to} IST`,
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
              <button className={selectionMode ? 'active select-range-button' : 'select-range-button'} onClick={() => setSelectionMode((a) => !a)} title="Select a candle range for the analyst" type="button">
                <span aria-hidden="true" className="icon">⌁</span> {selectionMode ? 'Selecting' : 'Select range'}
              </button>
              {selection && <button className="clear-selection" onClick={clearSelection} title="Clear selected candles" type="button">Clear selection</button>}
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
                    candles={candles}
                    chartApiRef={chartApiRef}
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
