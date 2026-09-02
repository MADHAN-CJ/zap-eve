'use client';

import { useCallback, useEffect, useState } from 'react';
import { RadarIcon } from 'lucide-react';
import { listWatches, type WatchSummary } from '@/lib/client/watches-api';
import { WatchCard } from './watch-card';

const LIVE = new Set(['ARMED', 'PAUSED', 'ERROR']);

/**
 * The sidebar "Watchers" page: every market watch the user has, live ones
 * first, with pause/resume/cancel and a link into the owning chat.
 */
export function WatchersPage({ onOpenThread }: { readonly onOpenThread: (threadId: string) => void }) {
  const [watches, setWatches] = useState<WatchSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setWatches(await listWatches());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load watches.');
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(id);
  }, [refresh]);

  const patch = (updated: WatchSummary) =>
    setWatches((prev) => prev?.map((w) => (w.id === updated.id ? updated : w)) ?? prev);

  const live = (watches ?? []).filter((w) => LIVE.has(w.status));
  const done = (watches ?? []).filter((w) => !LIVE.has(w.status));

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-5">
      <div className="mx-auto flex max-w-2xl flex-col gap-4">
        <div>
          <h2 className="flex items-center gap-2 font-semibold text-lg">
            <RadarIcon className="size-5" /> Watchers
          </h2>
          <p className="text-muted-foreground text-sm">
            Background market watches armed from your chats. They poll during market hours and email
            you when the AI confirms a trigger is real. Ask the analyst in any position chat to set
            one up.
          </p>
        </div>

        {error ? <p className="text-red-600 text-sm dark:text-red-400">{error}</p> : null}
        {watches === null && !error ? <p className="text-muted-foreground text-sm">Loading…</p> : null}
        {watches !== null && watches.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No watches yet — open a position chat and ask for one.
          </p>
        ) : null}

        {live.length > 0 ? (
          <div className="flex flex-col gap-3">
            {live.map((w) => (
              <WatchCard key={w.id} onChanged={patch} onOpenThread={onOpenThread} watch={w} />
            ))}
          </div>
        ) : null}

        {done.length > 0 ? (
          <>
            <p className="pt-2 font-medium text-muted-foreground text-xs tracking-wider">FINISHED</p>
            <div className="flex flex-col gap-3 opacity-70">
              {done.map((w) => (
                <WatchCard key={w.id} onChanged={patch} onOpenThread={onOpenThread} watch={w} />
              ))}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
