import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { db } from './client';
import { brokerConnections } from './schema';
import { decryptSecret, encryptSecret, tokenFingerprint } from './crypto';

/**
 * The user's Dhan broker connection (v1: pasted 24h access token). Credentials
 * are AES-256-GCM ciphertext at rest and never enter the model context.
 *
 * A Dhan-side auth failure marks the row `token_expired` and surfaces as a
 * broker-status problem — never as a Zap 401 (which means "log in again").
 */

export interface DhanCredential {
  type: 'access_token';
  accessToken: string;
}

export interface BrokerStatus {
  connected: boolean;
  status: 'active' | 'token_expired' | 'disconnected' | 'none';
  dhanClientId?: string;
  connectedAt?: string;
  /** Auto-renewal (docs/plan-token-renewal.md): when the current token dies and when the sweep will renew it. */
  tokenExpiresAt?: string | null;
  renewAfter?: string | null;
  lastRenewedAt?: string | null;
  renewFailures?: number;
  lastRenewError?: string | null;
}

/** 12 h after issue by default (user decision 2026-11-05): a 12 h recovery budget if the ticker is down. */
export const RENEW_AFTER_HOURS = () => Number(process.env.BROKER_RENEW_AFTER_HOURS ?? 12);
const TOKEN_LIFETIME_MS = 24 * 3600 * 1000;

/** Dhan access tokens are JWTs; `exp` is the authoritative expiry. */
export function jwtExpiry(token: string): Date | null {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const json = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as {
      exp?: number;
    };
    return typeof json.exp === 'number' && json.exp > 0 ? new Date(json.exp * 1000) : null;
  } catch {
    return null;
  }
}

/** The renewal bookkeeping written whenever a token is (re)issued. */
function tokenFields(accessToken: string, issuedAt: Date, expiresAtHint?: Date | null) {
  const tokenExpiresAt = expiresAtHint ?? jwtExpiry(accessToken) ?? new Date(issuedAt.getTime() + TOKEN_LIFETIME_MS);
  const renewAfter = new Date(issuedAt.getTime() + RENEW_AFTER_HOURS() * 3600 * 1000);
  return {
    credentialFp: tokenFingerprint(accessToken),
    tokenIssuedAt: issuedAt,
    tokenExpiresAt,
    renewAfter,
    renewFailures: 0,
    lastRenewError: null as string | null,
  };
}

export async function connectBroker(
  userId: string,
  dhanClientId: string,
  credential: DhanCredential,
): Promise<void> {
  const credentialEnc = encryptSecret(JSON.stringify(credential));
  const now = new Date();
  const fields = tokenFields(credential.accessToken, now);
  await db()
    .insert(brokerConnections)
    .values({ userId, dhanClientId, credentialEnc, status: 'active', ...fields, lastRenewAttemptAt: null, lastRenewedAt: null })
    .onConflictDoUpdate({
      target: brokerConnections.userId,
      set: {
        dhanClientId,
        credentialEnc,
        status: 'active',
        connectedAt: now,
        updatedAt: now,
        ...fields,
        lastRenewAttemptAt: null,
        lastRenewedAt: null,
      },
    });
}

export async function brokerStatusFor(userId: string): Promise<BrokerStatus> {
  const row = await db().query.brokerConnections.findFirst({
    where: eq(brokerConnections.userId, userId),
  });
  if (!row || row.status === 'disconnected') {
    return { connected: false, status: row ? 'disconnected' : 'none' };
  }
  return {
    connected: row.status === 'active',
    status: row.status,
    dhanClientId: row.dhanClientId,
    connectedAt: row.connectedAt.toISOString(),
    tokenExpiresAt: row.tokenExpiresAt?.toISOString() ?? null,
    renewAfter: row.renewAfter?.toISOString() ?? null,
    lastRenewedAt: row.lastRenewedAt?.toISOString() ?? null,
    renewFailures: row.renewFailures,
    lastRenewError: row.lastRenewError,
  };
}

export interface ActiveBrokerCreds {
  dhanClientId: string;
  accessToken: string;
}

/**
 * Decrypted, ACTIVE credentials for a user. Tri-state: `none` = no usable
 * connection (`reason` says which), `error` = lookup or DECRYPT failure —
 * callers must fail closed, never fall back to a shared env credential.
 */
export async function getActiveBrokerCreds(
  userId: string,
): Promise<
  | { status: 'found'; creds: ActiveBrokerCreds }
  | { status: 'none'; reason: 'not_connected' | 'token_expired' | 'disconnected' }
  | { status: 'error' }
> {
  try {
    const row = await db().query.brokerConnections.findFirst({
      where: eq(brokerConnections.userId, userId),
    });
    if (!row) return { status: 'none', reason: 'not_connected' };
    if (row.status !== 'active') {
      return { status: 'none', reason: row.status === 'token_expired' ? 'token_expired' : 'disconnected' };
    }
    const credential = JSON.parse(decryptSecret(row.credentialEnc)) as DhanCredential;
    return {
      status: 'found',
      creds: { dhanClientId: row.dhanClientId, accessToken: credential.accessToken },
    };
  } catch (e) {
    console.error('[broker] credential lookup failed:', e instanceof Error ? e.message : e);
    return { status: 'error' };
  }
}

/**
 * Dhan said the token is dead — record it so the UI shows the reconnect banner.
 * Pass the token that FAILED: the row is expired only if it still holds that
 * token (fingerprint match, or a legacy row with no fingerprint). After an
 * auto-renewal a stale in-flight call must not expire the fresh token (D3).
 * Returns whether the row was marked.
 */
export async function markTokenExpired(userId: string, failedAccessToken?: string): Promise<boolean> {
  const guard = failedAccessToken
    ? or(isNull(brokerConnections.credentialFp), eq(brokerConnections.credentialFp, tokenFingerprint(failedAccessToken)))
    : undefined;
  const rows = await db()
    .update(brokerConnections)
    .set({ status: 'token_expired', updatedAt: new Date() })
    .where(and(eq(brokerConnections.userId, userId), eq(brokerConnections.status, 'active'), guard))
    .returning({ id: brokerConnections.id });
  return rows.length > 0;
}

// --- auto-renewal (docs/plan-token-renewal.md) ---------------------------

/** Rows a tick may still claim: a crashed attempt older than this is reclaimable. */
export const RENEW_CLAIM_MINUTES = 4;
/** Safety net: renew regardless of renew_after when this little life is left. */
export const RENEW_NET_HOURS = 1;

export interface RenewClaim {
  id: string;
  userId: string;
  dhanClientId: string;
  accessToken: string;
  tokenExpiresAt: Date | null;
  renewFailures: number;
}

/**
 * Atomically claim every ACTIVE row that is due (renew_after passed, legacy
 * NULL, or < RENEW_NET_HOURS of life left) and not claimed within the window.
 * One UPDATE … RETURNING, so overlapping ticks never share a row; a failed or
 * crashed attempt leaves the row due and a later tick reclaims it.
 */
export async function claimDueForRenewal(now: Date): Promise<RenewClaim[]> {
  const net = new Date(now.getTime() + RENEW_NET_HOURS * 3600 * 1000);
  const claimCutoff = new Date(now.getTime() - RENEW_CLAIM_MINUTES * 60 * 1000);
  const rows = await db()
    .update(brokerConnections)
    .set({ lastRenewAttemptAt: now })
    .where(
      and(
        eq(brokerConnections.status, 'active'),
        or(
          isNull(brokerConnections.renewAfter),
          lt(brokerConnections.renewAfter, now),
          lt(brokerConnections.tokenExpiresAt, net),
        ),
        or(isNull(brokerConnections.lastRenewAttemptAt), lt(brokerConnections.lastRenewAttemptAt, claimCutoff)),
      ),
    )
    .returning({
      id: brokerConnections.id,
      userId: brokerConnections.userId,
      dhanClientId: brokerConnections.dhanClientId,
      credentialEnc: brokerConnections.credentialEnc,
      tokenExpiresAt: brokerConnections.tokenExpiresAt,
      renewFailures: brokerConnections.renewFailures,
    });
  const out: RenewClaim[] = [];
  for (const r of rows) {
    try {
      const credential = JSON.parse(decryptSecret(r.credentialEnc)) as DhanCredential;
      out.push({ ...r, accessToken: credential.accessToken });
    } catch (e) {
      // Unreadable credential (key rotated): can't renew, can't tell Dhan — leave it; the user reconnects.
      await db()
        .update(brokerConnections)
        .set({ renewFailures: sql`${brokerConnections.renewFailures} + 1`, lastRenewError: 'stored credential unreadable' })
        .where(eq(brokerConnections.id, r.id));
      console.error('[renew] credential unreadable for user', r.userId, e instanceof Error ? e.message : e);
    }
  }
  return out;
}

/** The new token replaces the old one everywhere (single-token model); bookkeeping restarts. */
export async function storeRenewedToken(id: string, accessToken: string, expiresAtHint: Date | null, now: Date): Promise<void> {
  const credential: DhanCredential = { type: 'access_token', accessToken };
  await db()
    .update(brokerConnections)
    .set({
      credentialEnc: encryptSecret(JSON.stringify(credential)),
      ...tokenFields(accessToken, now, expiresAtHint),
      lastRenewedAt: now,
      updatedAt: now,
    })
    .where(eq(brokerConnections.id, id));
}

/** Transient failure: count it, keep the row active (still due → retried next tick after the claim window). */
export async function recordRenewFailure(id: string, message: string): Promise<void> {
  await db()
    .update(brokerConnections)
    .set({ renewFailures: sql`${brokerConnections.renewFailures} + 1`, lastRenewError: message.slice(0, 500) })
    .where(eq(brokerConnections.id, id));
}

/** The chain is broken (Dhan refused, or the token died before we could renew): expire + remember why. */
export async function breakRenewalChain(id: string, message: string): Promise<void> {
  await db()
    .update(brokerConnections)
    .set({
      status: 'token_expired',
      renewFailures: sql`${brokerConnections.renewFailures} + 1`,
      lastRenewError: message.slice(0, 500),
      updatedAt: new Date(),
    })
    .where(and(eq(brokerConnections.id, id), eq(brokerConnections.status, 'active')));
}

export async function disconnectBroker(userId: string): Promise<void> {
  await db()
    .update(brokerConnections)
    .set({ status: 'disconnected', credentialEnc: encryptSecret('{}'), updatedAt: new Date() })
    .where(eq(brokerConnections.userId, userId));
}
