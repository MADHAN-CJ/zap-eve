import type { Cost, MessagePart, Role, Usage } from '@/agent/lib/db/types';
import { authHeaders } from './settings';

/**
 * Typed client for the thread REST API (plan Phase 2 routes). Shapes mirror
 * lib/server/threads.ts (kept in sync by hand — they can't be imported here
 * because the server module pulls in the DB client).
 */

export interface PositionRef {
  securityId: string;
  exchangeSegment: string;
  productType: string;
  symbol: string;
}

export interface ThreadSummary {
  id: string;
  title: string | null;
  eveSessionId: string;
  position: PositionRef | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApiMessage {
  id: string;
  role: Role;
  content: string;
  parts: MessagePart[];
  usage: Usage | null;
  cost: Cost | null;
  createdAt: string;
}

export interface ThreadDetail extends ThreadSummary {
  streamIndex: number;
  messages: ApiMessage[];
}

async function failure(res: Response): Promise<Error> {
  let detail = res.statusText;
  try {
    const body = (await res.json()) as { error?: string };
    if (typeof body.error === 'string') detail = body.error;
  } catch {
    /* non-JSON body */
  }
  return new Error(detail || `Request failed (${res.status})`);
}

export async function listThreads(): Promise<ThreadSummary[]> {
  const res = await fetch('/api/threads', { headers: authHeaders() });
  if (!res.ok) throw await failure(res);
  const body = (await res.json()) as { threads: ThreadSummary[] };
  return body.threads;
}

/** Stable key for grouping threads under a position. */
export function positionKey(p: Pick<PositionRef, 'securityId' | 'exchangeSegment' | 'productType'>): string {
  return `${p.exchangeSegment}:${p.securityId}:${p.productType}`;
}

/** That position's threads, newest first. */
export async function listThreadsByPosition(position: Omit<PositionRef, 'symbol'>): Promise<ThreadSummary[]> {
  const qs = new URLSearchParams({
    securityId: position.securityId,
    exchangeSegment: position.exchangeSegment,
    productType: position.productType,
  });
  const res = await fetch(`/api/threads?${qs}`, { headers: authHeaders() });
  if (!res.ok) throw await failure(res);
  const body = (await res.json()) as { threads: ThreadSummary[] };
  return body.threads;
}

export async function renameThread(id: string, title: string): Promise<ThreadSummary> {
  const res = await fetch(`/api/threads/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { ...authHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) throw await failure(res);
  return (await res.json()) as ThreadSummary;
}

export async function getThread(id: string): Promise<ThreadDetail> {
  const res = await fetch(`/api/threads/${encodeURIComponent(id)}`, { headers: authHeaders() });
  if (!res.ok) throw await failure(res);
  return (await res.json()) as ThreadDetail;
}

/** Resolves on 404 too (already gone) — matches the old app's contract. */
export async function deleteThread(id: string): Promise<void> {
  const res = await fetch(`/api/threads/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  if (res.status === 404) return;
  if (!res.ok) throw await failure(res);
}
