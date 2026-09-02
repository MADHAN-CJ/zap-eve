import { authHeaders } from './settings';
import type { WatchCondition, WatchKind, WatchMode, WatchStatus } from '@/agent/lib/watch/types';

/** Mirror of agent/lib/watch/service.ts `watchSummary`. */
export interface WatchSummary {
  id: string;
  threadId: string;
  symbol: string;
  exchangeSegment: string;
  interval: string;
  kind: WatchKind;
  status: WatchStatus;
  mode: WatchMode;
  conditions?: WatchCondition[];
  checkIntervalMinutes?: number;
  instruction: string;
  lastCheckedAt?: string;
  lastFiredAt?: string;
  lastAlertAt?: string;
  expiresAt: string;
  createdAt: string;
  errorMessage?: string;
}

export type WatchAction = 'pause' | 'resume' | 'cancel';

export async function listWatches(threadId?: string): Promise<WatchSummary[]> {
  const qs = threadId ? `?threadId=${encodeURIComponent(threadId)}` : '';
  const res = await fetch(`/api/watches${qs}`, { headers: authHeaders() });
  if (!res.ok) throw new Error('Could not load watches.');
  const payload = (await res.json()) as { watches: WatchSummary[] };
  return payload.watches;
}

export async function mutateWatch(id: string, action: WatchAction): Promise<WatchSummary> {
  const res = await fetch(`/api/watches/${id}`, {
    method: 'PATCH',
    headers: { ...authHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({ action }),
  });
  const payload = (await res.json().catch(() => null)) as { watch?: WatchSummary; error?: string } | null;
  if (!res.ok || !payload?.watch) throw new Error(payload?.error ?? 'Could not update the watch.');
  return payload.watch;
}
