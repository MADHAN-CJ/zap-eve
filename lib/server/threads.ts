import { and, desc, eq, isNull } from 'drizzle-orm';
import { db } from '@/agent/lib/db/client';
import { messages, threads } from '@/agent/lib/db/schema';
import type { Cost, MessagePart, Role, Usage } from '@/agent/lib/db/types';
import { HttpError } from './auth';
import type { PositionIdentity } from '@/agent/lib/db/session-context';

/**
 * Server-side thread service. Every entry point takes the authenticated
 * USER ID (from the session JWT — never a client-supplied id) and only ever
 * returns rows that user owns. One live thread per position (schema enforces
 * it); deleted threads don't block starting a fresh chat on the same position.
 */

export interface ThreadSummary {
  id: string;
  title: string | null;
  eveSessionId: string;
  position: PositionIdentity | null;
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
  /**
   * Resume cursor: the client opens the event stream here on its next send, so
   * history (already rendered from `messages`) never replays into the live
   * view. The continuation token is NOT exposed — the proxy injects it.
   */
  streamIndex: number;
  messages: ApiMessage[];
}

type ThreadRowShape = typeof threads.$inferSelect;

function rowPosition(r: Pick<ThreadRowShape, 'securityId' | 'exchangeSegment' | 'productType' | 'symbol'>): PositionIdentity | null {
  if (!r.securityId || !r.exchangeSegment || !r.productType || !r.symbol) return null;
  return {
    securityId: r.securityId,
    exchangeSegment: r.exchangeSegment,
    productType: r.productType,
    symbol: r.symbol,
  };
}

function summarize(r: ThreadRowShape): ThreadSummary {
  return {
    id: r.id,
    title: r.title,
    eveSessionId: r.eveSessionId,
    position: rowPosition(r),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export async function listThreads(userId: string): Promise<ThreadSummary[]> {
  const rows = await db()
    .select()
    .from(threads)
    .where(and(eq(threads.userId, userId), isNull(threads.deletedAt)))
    .orderBy(desc(threads.updatedAt));
  return rows.map(summarize);
}

/** The live thread for a position, if any — lets the UI resume instead of forking. */
export async function findThreadByPosition(
  userId: string,
  position: Pick<PositionIdentity, 'securityId' | 'exchangeSegment' | 'productType'>,
): Promise<ThreadSummary | null> {
  const row = await db().query.threads.findFirst({
    where: and(
      eq(threads.userId, userId),
      eq(threads.securityId, position.securityId),
      eq(threads.exchangeSegment, position.exchangeSegment),
      eq(threads.productType, position.productType),
      isNull(threads.deletedAt),
    ),
  });
  return row ? summarize(row) : null;
}

/** The owned, live thread row or a typed 404/403. */
async function ownedThread(userId: string, threadId: string) {
  const row = await db().query.threads.findFirst({ where: eq(threads.id, threadId) });
  if (!row || row.deletedAt) throw new HttpError(404, 'Conversation not found.');
  if (row.userId !== userId) throw new HttpError(403, 'This conversation belongs to a different account.');
  return row;
}

/**
 * Approval semantics put an approved tool's result in the NEXT turn's message:
 * message N ends with a `tool_call`, message N+1 starts with the matching
 * `tool_result`. Move each message's LEADING orphan result parts onto the
 * earlier message that holds the matching call, so the UI renders one
 * resolved tool panel. (No approvals in this read-only product, but the
 * stitch is harmless and keeps the chassis intact.)
 */
function stitchOrphanResults(msgs: ApiMessage[]): ApiMessage[] {
  const callSites = new Map<string, ApiMessage>();
  for (const msg of msgs) {
    let leading = true;
    const kept: MessagePart[] = [];
    for (const part of msg.parts) {
      if (part.type === 'tool_call') {
        callSites.set(part.toolCallId, msg);
        leading = false;
        kept.push(part);
        continue;
      }
      const owner = leading ? callSites.get(part.toolCallId) : undefined;
      if (owner && owner !== msg) {
        owner.parts.push(part);
      } else {
        kept.push(part);
      }
    }
    msg.parts = kept;
  }
  return msgs;
}

export async function getThread(userId: string, threadId: string): Promise<ThreadDetail> {
  const thread = await ownedThread(userId, threadId);
  const rows = await db()
    .select()
    .from(messages)
    .where(eq(messages.threadId, threadId))
    .orderBy(messages.turnSequence, desc(messages.role), messages.createdAt);
  const shaped: ApiMessage[] = rows.map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    parts: m.parts,
    usage: m.usage ?? null,
    cost: m.cost ?? null,
    createdAt: m.createdAt.toISOString(),
  }));
  return {
    ...summarize(thread),
    streamIndex: thread.streamIndex,
    messages: stitchOrphanResults(shaped),
  };
}

export async function deleteThread(userId: string, threadId: string): Promise<void> {
  await ownedThread(userId, threadId); // throws 404/403
  await db().update(threads).set({ deletedAt: new Date() }).where(eq(threads.id, threadId));
}
