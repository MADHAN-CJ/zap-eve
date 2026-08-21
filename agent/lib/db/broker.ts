import { eq } from 'drizzle-orm';
import { db } from './client';
import { brokerConnections } from './schema';
import { decryptSecret, encryptSecret } from './crypto';

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
}

export async function connectBroker(
  userId: string,
  dhanClientId: string,
  credential: DhanCredential,
): Promise<void> {
  const credentialEnc = encryptSecret(JSON.stringify(credential));
  await db()
    .insert(brokerConnections)
    .values({ userId, dhanClientId, credentialEnc, status: 'active' })
    .onConflictDoUpdate({
      target: brokerConnections.userId,
      set: {
        dhanClientId,
        credentialEnc,
        status: 'active',
        connectedAt: new Date(),
        updatedAt: new Date(),
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

/** Dhan said the token is dead — record it so the UI shows the reconnect banner. */
export async function markTokenExpired(userId: string): Promise<void> {
  await db()
    .update(brokerConnections)
    .set({ status: 'token_expired', updatedAt: new Date() })
    .where(eq(brokerConnections.userId, userId));
}

export async function disconnectBroker(userId: string): Promise<void> {
  await db()
    .update(brokerConnections)
    .set({ status: 'disconnected', credentialEnc: encryptSecret('{}'), updatedAt: new Date() })
    .where(eq(brokerConnections.userId, userId));
}
