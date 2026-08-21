'use client';

import { Loader2Icon, MessageSquareTextIcon, RefreshCwIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { DhanHolding, DhanPosition } from '@/lib/client/broker';

/**
 * The home pane: the user's open positions AND demat holdings (Dhan keeps
 * them separate — /positions is today's trading, /holdings is delivery
 * stock), one tap → chat about it. A row that already has a chat resumes it
 * (the workspace decides — this component only reports the tap).
 */

const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });

export function PositionsList({
  positions,
  holdings,
  loading,
  error,
  onRefresh,
  onChat,
  onChatHolding,
}: {
  readonly positions: DhanPosition[];
  readonly holdings: DhanHolding[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly onRefresh: () => void;
  readonly onChat: (position: DhanPosition) => void;
  readonly onChatHolding: (holding: DhanHolding) => void;
}) {
  const open = positions.filter((p) => p.positionType !== 'CLOSED' && Number(p.netQty) !== 0);
  const closed = positions.filter((p) => p.positionType === 'CLOSED' || Number(p.netQty) === 0);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 overflow-y-auto px-4 py-6 sm:px-6">
      <div className="flex items-center justify-between">
        <h2 className="font-medium text-lg tracking-tight">Your positions</h2>
        <Button disabled={loading} onClick={onRefresh} size="sm" variant="ghost">
          {loading ? <Loader2Icon className="size-4 animate-spin" /> : <RefreshCwIcon className="size-4" />}
          Refresh
        </Button>
      </div>

      {error ? <p className="text-destructive text-sm">{error}</p> : null}

      {!loading && !error && positions.length === 0 && holdings.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          Nothing to show yet. Open positions and demat holdings in your Dhan account will appear
          here — tap one to chat about it.
        </p>
      ) : null}

      {!loading && open.length === 0 && holdings.length > 0 ? (
        <p className="text-muted-foreground text-sm">
          No open trading positions today — your demat holdings are below.
        </p>
      ) : null}

      {open.map((p) => (
        <PositionCard key={rowKey(p)} onChat={onChat} position={p} />
      ))}

      {holdings.length > 0 ? (
        <>
          <p className="pt-2 font-medium text-muted-foreground text-xs tracking-wider">HOLDINGS</p>
          {holdings.map((h) => (
            <HoldingCard holding={h} key={`${h.exchange}:${h.securityId}`} onChat={onChatHolding} />
          ))}
        </>
      ) : null}

      {closed.length > 0 ? (
        <>
          <p className="pt-2 font-medium text-muted-foreground text-xs tracking-wider">CLOSED TODAY</p>
          {closed.map((p) => (
            <PositionCard key={rowKey(p)} onChat={onChat} position={p} />
          ))}
        </>
      ) : null}
    </div>
  );
}

function HoldingCard({
  holding: h,
  onChat,
}: {
  readonly holding: DhanHolding;
  readonly onChat: (holding: DhanHolding) => void;
}) {
  const qty = Number(h.totalQty ?? 0);
  const invested = qty * Number(h.avgCostPrice ?? 0);
  return (
    <button
      className="flex w-full items-center justify-between gap-3 rounded-lg border bg-card px-4 py-3 text-left transition-colors hover:border-ring/40 hover:bg-accent/40"
      onClick={() => onChat(h)}
      type="button"
    >
      <span className="min-w-0">
        <span className="flex items-center gap-2">
          <span className="truncate font-medium text-sm">{h.tradingSymbol}</span>
          <span className="rounded-full bg-secondary px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-secondary-foreground">
            Holding
          </span>
        </span>
        <span className="mt-0.5 block text-muted-foreground text-xs">
          {h.exchange} · qty {qty} @ ₹{inr.format(Number(h.avgCostPrice ?? 0))}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-3">
        {/* Dhan holdings carry no LTP, so we show invested value, not P&L. */}
        <span className="font-medium text-sm tabular-nums">₹{inr.format(invested)}</span>
        <MessageSquareTextIcon className="size-4 text-muted-foreground" />
      </span>
    </button>
  );
}

const rowKey = (p: DhanPosition) => `${p.exchangeSegment}:${p.securityId}:${p.productType}`;

function PositionCard({
  position: p,
  onChat,
}: {
  readonly position: DhanPosition;
  readonly onChat: (position: DhanPosition) => void;
}) {
  const pnl = Number(p.unrealizedProfit ?? 0) + Number(p.realizedProfit ?? 0);
  const qty = Number(p.netQty);
  const avg = qty >= 0 ? Number(p.buyAvg ?? 0) : Number(p.sellAvg ?? 0);
  return (
    <button
      className="flex w-full items-center justify-between gap-3 rounded-lg border bg-card px-4 py-3 text-left transition-colors hover:border-ring/40 hover:bg-accent/40"
      onClick={() => onChat(p)}
      type="button"
    >
      <span className="min-w-0">
        <span className="flex items-center gap-2">
          <span className="truncate font-medium text-sm">{p.tradingSymbol}</span>
          <span
            className={cn(
              'rounded-full px-1.5 py-0.5 text-[10px] uppercase tracking-wide',
              p.positionType === 'LONG'
                ? 'bg-primary/10 text-primary'
                : p.positionType === 'SHORT'
                  ? 'bg-destructive/10 text-destructive'
                  : 'bg-muted text-muted-foreground',
            )}
          >
            {p.positionType}
          </span>
        </span>
        <span className="mt-0.5 block text-muted-foreground text-xs">
          {p.exchangeSegment} · {p.productType} · qty {qty} @ ₹{inr.format(avg)}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-3">
        <span className={cn('font-medium text-sm tabular-nums', pnl >= 0 ? 'text-primary' : 'text-destructive')}>
          {pnl >= 0 ? '+' : '−'}₹{inr.format(Math.abs(pnl))}
        </span>
        <MessageSquareTextIcon className="size-4 text-muted-foreground" />
      </span>
    </button>
  );
}
