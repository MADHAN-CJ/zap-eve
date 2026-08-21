import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '#lib/db/client.js';
import { brokerConnections, messages, sessionContext, threads, users } from '#lib/db/schema.js';
import { decryptSecret, encryptSecret, otpHash } from '#lib/db/crypto.js';

/**
 * Round-trip smoke test for the schema + crypto (run: npm run db:smoke).
 * Creates a user → broker connection (encrypted) → thread + message +
 * session_context, reads everything back, then deletes the user (cascades).
 */
async function main() {
  const email = `smoke-${randomUUID().slice(0, 8)}@example.com`;

  const [user] = await db().insert(users).values({ email }).returning();
  console.log('user:', user.id, user.email);

  const secret = JSON.stringify({ type: 'access_token', accessToken: 'smoke-token' });
  await db()
    .insert(brokerConnections)
    .values({ userId: user.id, dhanClientId: '1100000000', credentialEnc: encryptSecret(secret) });
  const conn = await db().query.brokerConnections.findFirst({
    where: eq(brokerConnections.userId, user.id),
  });
  if (!conn || decryptSecret(conn.credentialEnc) !== secret) throw new Error('credential round-trip failed');
  console.log('broker connection: encrypted round-trip OK, status', conn.status);

  if (otpHash('123456', email) !== otpHash('123456', email.toUpperCase())) {
    throw new Error('otpHash should be case-insensitive on email');
  }

  const eveSessionId = `wrun_SMOKE${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`;
  const position = { securityId: '2885', exchangeSegment: 'NSE_EQ', productType: 'INTRADAY', symbol: 'RELIANCE' };
  await db().insert(sessionContext).values({ eveSessionId, userId: user.id, ...position });
  const [thread] = await db()
    .insert(threads)
    .values({ eveSessionId, userId: user.id, ...position, title: position.symbol })
    .returning();
  await db()
    .insert(messages)
    .values({ threadId: thread.id, turnSequence: 0, role: 'user', content: 'How is my position?' });
  const msgs = await db().select().from(messages).where(eq(messages.threadId, thread.id));
  console.log('thread:', thread.id, '→', msgs.length, 'message(s)');

  await db().delete(sessionContext).where(eq(sessionContext.eveSessionId, eveSessionId));
  await db().delete(users).where(eq(users.id, user.id)); // cascades connection/thread/message
  console.log('cleanup OK — schema smoke passed');
  process.exit(0);
}

main().catch((e) => {
  console.error('db-smoke failed:', e);
  process.exit(1);
});
