'use client';

import { useCallback, useEffect, useState } from 'react';
import { RadarIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { describeCondition } from '@/agent/lib/watch/trigger-format';
import { listWatches, mutateWatch, type WatchAction, type WatchSummary } from '@/lib/client/watches-api';

/**
 * One market watch as a card: status pill, what is being watched, last
 * activity, and pause/resume/cancel actions. Used inline in a thread (under
 * the create_watch tool card) and on the Watchers page.
 */

const STATUS_STYLE: Record<string, string> = {
  ARMED: 'bg-emerald-600/10 text-emerald-700 dark:text-emerald-400',
  PAUSED: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
  ERROR: 'bg-red-600/10 text-red-700 dark:text-red-400',
  EXPIRED: 'bg-muted text-muted-foreground',
  CANCELLED: 'bg-muted text-muted-foreground',
};

const timeAgo = (iso?: string): string | null => {
  if (!iso) return null;
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
};

export function watchDescription(w: WatchSummary): string {
  if (w.kind === 'ai_check') return `AI re-checks the chart every ${w.checkIntervalMinutes ?? 30} min`;
  const conds = (w.conditions ?? []).map(describeCondition);
  return conds.join(w.mode === 'all' ? ' AND ' : ' OR ') || '—';
}

export function WatchCard({
  watch,
  onChanged,
  onOpenThread,
}: {
  readonly watch: WatchSummary;
  readonly onChanged: (updated: WatchSummary) => void;
  /** Set on the Watchers page — renders an "Open chat" link. */
  readonly onOpenThread?: (threadId: string) => void;
}) {
  const [busy, setBusy] = useState<WatchAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmCancelOpen, setConfirmCancelOpen] = useState(false);

  const act = async (action: WatchAction) => {
    setBusy(action);
    setError(null);
    try {
      onChanged(await mutateWatch(watch.id, action));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed.');
    } finally {
      setBusy(null);
    }
  };

  const live = watch.status === 'ARMED' || watch.status === 'PAUSED' || watch.status === 'ERROR';
  const checked = timeAgo(watch.lastCheckedAt);
  const alerted = timeAgo(watch.lastAlertAt);

  return (
    <div className="flex max-w-md flex-col gap-2 rounded-lg border bg-background/60 p-3 text-sm">
      <div className="flex items-center gap-2">
        <RadarIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-medium">
          {watch.symbol} <span className="font-normal text-muted-foreground">· {watch.interval}</span>
        </span>
        <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', STATUS_STYLE[watch.status] ?? 'bg-muted')}>
          {watch.status === 'ARMED' ? 'watching' : watch.status.toLowerCase()}
        </span>
      </div>
      <p className="text-muted-foreground">{watchDescription(watch)}</p>
      <p className="truncate text-muted-foreground text-xs" title={watch.instruction}>
        “{watch.instruction}”
      </p>
      {watch.status === 'ERROR' && watch.errorMessage ? (
        <p className="text-red-600 text-xs dark:text-red-400">{watch.errorMessage}</p>
      ) : null}
      <p className="text-muted-foreground/70 text-xs">
        {checked ? `checked ${checked}` : 'not checked yet'}
        {alerted ? ` · alerted ${alerted}` : ''}
        {` · expires ${new Date(watch.expiresAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}`}
      </p>
      {error ? <p className="text-red-600 text-xs dark:text-red-400">{error}</p> : null}
      {live ? (
        <div className="flex items-center gap-2">
          {watch.status === 'ARMED' ? (
            <Button disabled={busy !== null} onClick={() => void act('pause')} size="xs" variant="secondary">
              {busy === 'pause' ? 'Pausing…' : 'Pause'}
            </Button>
          ) : (
            <Button disabled={busy !== null} onClick={() => void act('resume')} size="xs" variant="secondary">
              {busy === 'resume' ? 'Resuming…' : 'Resume'}
            </Button>
          )}
          <Button disabled={busy !== null} onClick={() => setConfirmCancelOpen(true)} size="xs" variant="ghost">
            {busy === 'cancel' ? 'Cancelling…' : 'Cancel'}
          </Button>
          {onOpenThread ? (
            <Button className="ml-auto" onClick={() => onOpenThread(watch.threadId)} size="xs" variant="ghost">
              Open chat →
            </Button>
          ) : null}
        </div>
      ) : onOpenThread ? (
        <div className="flex">
          <Button className="ml-auto" onClick={() => onOpenThread(watch.threadId)} size="xs" variant="ghost">
            Open chat →
          </Button>
        </div>
      ) : null}

      <Dialog onOpenChange={setConfirmCancelOpen} open={confirmCancelOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel this watch</DialogTitle>
            <DialogDescription>
              Stop watching {watch.symbol} ({watchDescription(watch)})? A cancelled watch cannot be
              restarted — you would ask the analyst for a new one.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button onClick={() => setConfirmCancelOpen(false)} type="button" variant="ghost">
              Keep watching
            </Button>
            <Button
              className="text-destructive hover:text-destructive"
              onClick={() => {
                setConfirmCancelOpen(false);
                void act('cancel');
              }}
              type="button"
              variant="ghost"
            >
              Cancel watch
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * Live wrapper used inside a thread under the create_watch tool card: seeds
 * from the tool result, then polls the REST list every 10s while the watch is
 * in a live state so status/last-check stay current.
 */
export function ThreadWatchCard({ initial }: { readonly initial: WatchSummary }) {
  const [watch, setWatch] = useState<WatchSummary>(initial);

  const refresh = useCallback(async () => {
    try {
      const rows = await listWatches(initial.threadId);
      const current = rows.find((r) => r.id === initial.id);
      if (current) setWatch(current);
    } catch {
      // transient — keep showing the last known state
    }
  }, [initial.id, initial.threadId]);

  useEffect(() => {
    const live = watch.status === 'ARMED' || watch.status === 'PAUSED';
    if (!live) return;
    const id = window.setInterval(() => void refresh(), 10_000);
    return () => window.clearInterval(id);
  }, [watch.status, refresh]);

  // seed can be stale when history reloads — fetch once on mount
  useEffect(() => {
    void refresh();
  }, [refresh]);

  return <WatchCard onChanged={setWatch} watch={watch} />;
}

/** Dispatcher mounted beside ToolResultChart: renders the live watch card under a successful create_watch call. */
export function ToolResultWatch({ toolName, output }: { readonly toolName: string; readonly output: unknown }) {
  if (toolName !== 'create_watch') return null;
  const data = (typeof output === 'object' && output !== null ? output : {}) as { watch?: WatchSummary };
  if (!data.watch?.id || !data.watch.threadId) return null;
  return <ThreadWatchCard initial={data.watch} />;
}
