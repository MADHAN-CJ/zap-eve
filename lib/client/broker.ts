import { authHeaders } from './settings';

/**
 * Typed client for the broker routes. A 409 with code BROKER_TOKEN_EXPIRED is
 * a broker-status event (show the reconnect banner) — NEVER a Zap logout; a
 * 401 anywhere means the Zap session itself expired.
 */

export interface BrokerStatus {
  connected: boolean;
  status: 'active' | 'token_expired' | 'disconnected' | 'none';
  dhanClientId?: string;
  connectedAt?: string;
}

/** A Dhan position row (fields we rely on; Dhan sends more — passed through). */
export interface DhanPosition {
  securityId: string;
  tradingSymbol: string;
  exchangeSegment: string;
  productType: string;
  positionType: 'LONG' | 'SHORT' | 'CLOSED';
  netQty: number;
  buyAvg: number;
  sellAvg: number;
  realizedProfit: number;
  unrealizedProfit: number;
  [key: string]: unknown;
}

/** A Dhan demat holding row (delivery equity — separate from positions). */
export interface DhanHolding {
  exchange: string;
  tradingSymbol: string;
  securityId: string;
  isin: string;
  totalQty: number;
  availableQty: number;
  avgCostPrice: number;
  [key: string]: unknown;
}

export class SessionExpiredError extends Error {}

async function failure(res: Response, fallback: string): Promise<Error> {
  if (res.status === 401) return new SessionExpiredError('Your session expired — sign in again.');
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return new Error(body?.error ?? fallback);
}

export async function getBrokerStatus(): Promise<BrokerStatus> {
  const res = await fetch('/api/broker', { headers: authHeaders() });
  if (!res.ok) throw await failure(res, 'Could not load broker status.');
  return (await res.json()) as BrokerStatus;
}

export async function connectBroker(
  dhanClientId: string,
  accessToken: string,
): Promise<{ ok: true; status: BrokerStatus } | { ok: false; error: string }> {
  const res = await fetch('/api/broker', {
    method: 'POST',
    headers: { ...authHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({ dhanClientId, accessToken }),
  });
  if (res.status === 401) throw new SessionExpiredError('Your session expired — sign in again.');
  const body = (await res.json().catch(() => null)) as (BrokerStatus & { error?: string }) | null;
  if (!res.ok) return { ok: false, error: body?.error ?? 'Could not connect Dhan.' };
  return { ok: true, status: body as BrokerStatus };
}

export async function disconnectBroker(): Promise<BrokerStatus> {
  const res = await fetch('/api/broker', { method: 'DELETE', headers: authHeaders() });
  if (!res.ok) throw await failure(res, 'Could not disconnect.');
  return (await res.json()) as BrokerStatus;
}

type BrokerFetch<K extends string, T> =
  | ({ ok: true } & Record<K, T[]>)
  | { ok: false; code: 'BROKER_TOKEN_EXPIRED' | 'BROKER_NOT_CONNECTED'; error: string };

async function brokerList<K extends string, T>(path: string, key: K, label: string): Promise<BrokerFetch<K, T>> {
  const res = await fetch(path, { headers: authHeaders() });
  if (res.status === 409) {
    const body = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
    return {
      ok: false,
      code: body?.code === 'BROKER_TOKEN_EXPIRED' ? 'BROKER_TOKEN_EXPIRED' : 'BROKER_NOT_CONNECTED',
      error: body?.error ?? 'Dhan is not connected.',
    };
  }
  if (!res.ok) throw await failure(res, `Could not load ${label}.`);
  const body = (await res.json()) as Record<K, T[]>;
  return { ok: true, [key]: body[key] } as { ok: true } & Record<K, T[]>;
}

export function getPositions(): Promise<BrokerFetch<'positions', DhanPosition>> {
  return brokerList('/api/broker/positions', 'positions', 'positions');
}

export function getHoldings(): Promise<BrokerFetch<'holdings', DhanHolding>> {
  return brokerList('/api/broker/holdings', 'holdings', 'holdings');
}
