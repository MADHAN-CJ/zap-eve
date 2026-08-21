import { eq } from 'drizzle-orm';
import { db } from './client';
import { sessionContext } from './schema';

/**
 * Per-session ownership + position context. WRITTEN only by the eve proxy
 * (before forwarding each send), READ only by the per-tool credential
 * resolution (agent/lib/dhan/context.ts) and the persist hook's owner
 * backfill. No secret lives here — credentials stay in broker_connections,
 * looked up by userId at tool-execution time.
 */

export interface PositionIdentity {
  securityId: string;
  exchangeSegment: string;
  productType: string;
  symbol: string;
}

export async function upsertSessionContext(
  eveSessionId: string,
  userId: string,
  position: PositionIdentity,
): Promise<void> {
  await db()
    .insert(sessionContext)
    .values({ eveSessionId, userId, ...position })
    .onConflictDoUpdate({
      target: sessionContext.eveSessionId,
      set: { userId, ...position, updatedAt: new Date() },
    });
}

export interface SessionOwner {
  userId: string;
  position: PositionIdentity;
}

/**
 * Ownership for a session. Distinguishes "no row" (caller may fall back to the
 * env Dhan credential — bench/direct sends have no proxy) from a lookup
 * FAILURE, which the caller must treat as fail-closed: running a turn on the
 * env account when the session actually belongs to a user would execute one
 * user's request against another account.
 */
export async function getSessionContext(
  eveSessionId: string,
): Promise<{ status: 'found'; owner: SessionOwner } | { status: 'none' } | { status: 'error' }> {
  try {
    const row = await db().query.sessionContext.findFirst({
      where: eq(sessionContext.eveSessionId, eveSessionId),
    });
    if (!row) return { status: 'none' };
    return {
      status: 'found',
      owner: {
        userId: row.userId,
        position: {
          securityId: row.securityId,
          exchangeSegment: row.exchangeSegment,
          productType: row.productType,
          symbol: row.symbol,
        },
      },
    };
  } catch (e) {
    console.error('[session-context] lookup failed:', e instanceof Error ? e.message : e);
    return { status: 'error' };
  }
}
