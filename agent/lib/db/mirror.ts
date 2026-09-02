import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from './client';
import { messages, sessionContext, threads } from './schema';
import { costForUsage } from './pricing';
import type { MessagePart, Usage } from './types';
import { stripKickoff } from '../kickoff';
import { stripSelectionMarkup } from '../selection-markup';

/**
 * DB operations behind agent/hooks/persist.ts — the projection of eve's stream
 * into the product chat-history schema. The hook is the only writer of
 * `messages`; the proxy owns `session_context`; both touch `threads`.
 *
 * Turn assembly: user rows insert once on message.received; the assistant row
 * is UPSERTED (unique per thread+turn via messages_assistant_turn_uidx) every
 * time a fragment lands, so each flush is durable.
 *
 * HITL park semantics: when a tool call waits for
 * approval, eve emits `turn.completed` AT THE PARK, and the approval's
 * `action.result` (and any post-approval steps) arrive after it under the same
 * turnId. So buffers must outlive turn.completed — they're evicted when the
 * session's NEXT turn starts, when the session ends, or by age. If the process
 * restarted while parked (buffer gone), late events fall back to durable SQL
 * appends on the persisted row, so an approval verdict is never lost; only the
 * usage of post-restart steps goes uncounted (accepted).
 */

/** First-user-message title, matching the old frontend's fallback rule. */
const TITLE_MAX = 40;

/** Parked-approval buffers die after this long; SQL fallbacks take over. */
const BUFFER_MAX_AGE_MS = 6 * 60 * 60 * 1000;

interface TurnBuffer {
  sessionId: string;
  turnId: string;
  threadId: string;
  turnSequence: number;
  assistantMessageId: string;
  /** Completed assistant text blocks, in stream order. */
  texts: string[];
  /** Ordered tool activity (tool_call at request time, result/error appended). */
  parts: MessagePart[];
  usage: Required<Omit<Usage, 'totalTokens'>>;
  steps: number;
  createdAt: number;
}

const buffers = new Map<string, TurnBuffer>();

const bufferKey = (sessionId: string, turnId: string) => `${sessionId}/${turnId}`;

function evictStaleBuffers(): void {
  const now = Date.now();
  for (const [key, buf] of buffers) {
    if (now - buf.createdAt > BUFFER_MAX_AGE_MS) buffers.delete(key);
  }
}

/**
 * Upsert the thread row for a session and return its id. Sets the title only
 * when the row doesn't have one yet; always bumps updated_at.
 */
async function ensureThread(eveSessionId: string, titleCandidate?: string): Promise<string> {
  const candidate = titleCandidate ? stripSelectionMarkup(stripKickoff(titleCandidate)).trim() : '';
  const title = candidate ? candidate.slice(0, TITLE_MAX) : null;
  const [row] = await db()
    .insert(threads)
    .values({ eveSessionId, title })
    .onConflictDoUpdate({
      target: threads.eveSessionId,
      set: {
        title: sql`coalesce(${threads.title}, ${title})`,
        updatedAt: sql`now()`,
      },
    })
    .returning({ id: threads.id });
  return row.id;
}

async function threadIdFor(eveSessionId: string): Promise<string | null> {
  const row = await db().query.threads.findFirst({
    columns: { id: true },
    where: eq(threads.eveSessionId, eveSessionId),
  });
  return row?.id ?? null;
}

/**
 * Copy the owner (and position identity) from session_context once it exists —
 * the proxy may write the context after the hook created the thread row.
 */
async function backfillOwner(eveSessionId: string): Promise<void> {
  await db()
    .update(threads)
    .set({
      userId: sql`(select ${sessionContext.userId} from ${sessionContext}
        where ${sessionContext.eveSessionId} = ${eveSessionId})`,
      securityId: sql`(select ${sessionContext.securityId} from ${sessionContext}
        where ${sessionContext.eveSessionId} = ${eveSessionId})`,
      exchangeSegment: sql`(select ${sessionContext.exchangeSegment} from ${sessionContext}
        where ${sessionContext.eveSessionId} = ${eveSessionId})`,
      productType: sql`(select ${sessionContext.productType} from ${sessionContext}
        where ${sessionContext.eveSessionId} = ${eveSessionId})`,
      symbol: sql`(select ${sessionContext.symbol} from ${sessionContext}
        where ${sessionContext.eveSessionId} = ${eveSessionId})`,
    })
    .where(and(eq(threads.eveSessionId, eveSessionId), isNull(threads.userId)));
}

function turnBuffer(sessionId: string, turnId: string, threadId: string, turnSequence: number): TurnBuffer {
  const key = bufferKey(sessionId, turnId);
  let buf = buffers.get(key);
  if (!buf) {
    buf = {
      sessionId,
      turnId,
      threadId,
      turnSequence,
      assistantMessageId: randomUUID(),
      texts: [],
      parts: [],
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      steps: 0,
      createdAt: Date.now(),
    };
    buffers.set(key, buf);
  }
  return buf;
}

/** Durable write of the assistant row as currently assembled (buffer = truth). */
async function flushAssistant(buf: TurnBuffer): Promise<void> {
  const usage: Usage | null =
    buf.steps > 0
      ? { ...buf.usage, totalTokens: buf.usage.inputTokens + buf.usage.outputTokens }
      : null;
  await db()
    .insert(messages)
    .values({
      id: buf.assistantMessageId,
      threadId: buf.threadId,
      turnSequence: buf.turnSequence,
      role: 'assistant',
      content: buf.texts.join('\n\n'),
      parts: buf.parts,
      usage,
      cost: costForUsage(usage ?? undefined),
    })
    .onConflictDoUpdate({
      target: [messages.threadId, messages.turnSequence],
      targetWhere: sql`role = 'assistant'`,
      set: {
        content: sql`excluded.content`,
        parts: sql`excluded.parts`,
        usage: sql`excluded.usage`,
        cost: sql`excluded.cost`,
      },
    });
}

/**
 * Buffer-miss fallback (process restarted while the turn was parked): append
 * text/parts onto the persisted assistant row directly, creating it if the
 * restart happened before any flush. Existing usage/cost are left untouched.
 */
async function appendDurable(
  sessionId: string,
  turnSequence: number,
  delta: { text?: string; parts?: MessagePart[] },
): Promise<void> {
  const threadId = await threadIdFor(sessionId);
  if (!threadId) return; // nothing mirrored for this session at all — give up
  const text = delta.text?.trim() ? delta.text : '';
  await db()
    .insert(messages)
    .values({
      id: randomUUID(),
      threadId,
      turnSequence,
      role: 'assistant',
      content: text,
      parts: delta.parts ?? [],
    })
    .onConflictDoUpdate({
      target: [messages.threadId, messages.turnSequence],
      targetWhere: sql`role = 'assistant'`,
      set: {
        parts: sql`${messages.parts} || excluded.parts`,
        content: sql`btrim(${messages.content} || E'\n\n' || excluded.content, E'\n')`,
      },
    });
}

// --- Event entry points (called by agent/hooks/persist.ts) ---

/** First stream event of a session — make sure the thread row exists. */
export async function onSessionStarted(sessionId: string): Promise<void> {
  await ensureThread(sessionId);
}

/**
 * Wildcard counter: one increment per stream event (the client resume cursor —
 * see schema.streamIndex). Retries once through ensureThread when the very
 * first events race the row's creation.
 */
export async function onAnyEvent(sessionId: string): Promise<void> {
  const bump = () =>
    db()
      .update(threads)
      .set({ streamIndex: sql`${threads.streamIndex} + 1` })
      .where(eq(threads.eveSessionId, sessionId))
      .returning({ id: threads.id });
  const updated = await bump();
  if (updated.length === 0) {
    await ensureThread(sessionId);
    await bump();
  }
}

/** New turn: evict finished buffers (other turns of this session + stale). */
export function onTurnStarted(sessionId: string, turnId: string): void {
  for (const [key, buf] of buffers) {
    if (buf.sessionId === sessionId && buf.turnId !== turnId) buffers.delete(key);
  }
  evictStaleBuffers();
}

export async function onMessageReceived(
  sessionId: string,
  data: { message: string; sequence: number; turnId: string },
): Promise<void> {
  const threadId = await ensureThread(sessionId, data.message);
  await backfillOwner(sessionId);
  // Seed the turn buffer now so later fragments know the thread/sequence.
  turnBuffer(sessionId, data.turnId, threadId, data.sequence);
  await db().insert(messages).values({
    threadId,
    turnSequence: data.sequence,
    role: 'user',
    content: data.message,
  });
}

export async function onActionsRequested(
  sessionId: string,
  data: {
    turnId: string;
    sequence: number;
    actions: readonly { kind: string; callId: string; toolName?: string; input?: unknown }[];
  },
): Promise<void> {
  const toolCalls = data.actions.filter((a) => a.kind === 'tool-call');
  if (toolCalls.length === 0) return;
  const parts: MessagePart[] = toolCalls.map((a) => ({
    type: 'tool_call',
    toolCallId: a.callId,
    toolName: a.toolName ?? 'tool',
    input: a.input,
  }));
  const buf = buffers.get(bufferKey(sessionId, data.turnId));
  if (!buf) return appendDurable(sessionId, data.sequence, { parts });
  buf.parts.push(...parts);
  await flushAssistant(buf);
}

export async function onActionResult(
  sessionId: string,
  data: {
    turnId: string;
    sequence: number;
    status: 'completed' | 'failed' | 'rejected';
    error?: { code: string; message: string };
    result: { kind: string; callId: string; toolName?: string; output?: unknown };
  },
): Promise<void> {
  if (data.result.kind !== 'tool-result') return;
  const toolName = data.result.toolName ?? 'tool';
  const part: MessagePart =
    data.status === 'completed'
      ? { type: 'tool_result', toolCallId: data.result.callId, toolName, output: data.result.output }
      : {
          type: 'tool_error',
          toolCallId: data.result.callId,
          toolName,
          error:
            data.status === 'rejected'
              ? 'Declined by user'
              : (data.error?.message ?? 'Tool call failed'),
        };
  const buf = buffers.get(bufferKey(sessionId, data.turnId));
  if (!buf) return appendDurable(sessionId, data.sequence, { parts: [part] });
  buf.parts.push(part);
  await flushAssistant(buf);
}

export async function onMessageCompleted(
  sessionId: string,
  data: { turnId: string; sequence: number; message: string | null },
): Promise<void> {
  if (!data.message || !data.message.trim()) return;
  const buf = buffers.get(bufferKey(sessionId, data.turnId));
  if (!buf) return appendDurable(sessionId, data.sequence, { text: data.message });
  buf.texts.push(data.message);
  await flushAssistant(buf);
}

export function onStepCompleted(
  sessionId: string,
  data: { turnId: string; usage?: Usage },
): void {
  const buf = buffers.get(bufferKey(sessionId, data.turnId));
  if (!buf) return; // post-restart steps go uncounted (accepted)
  buf.steps += 1;
  buf.usage.inputTokens += data.usage?.inputTokens ?? 0;
  buf.usage.outputTokens += data.usage?.outputTokens ?? 0;
  buf.usage.cacheReadTokens += data.usage?.cacheReadTokens ?? 0;
  buf.usage.cacheWriteTokens += data.usage?.cacheWriteTokens ?? 0;
}

/**
 * turn.completed / turn.failed. NOTE: for a HITL park this fires at the park —
 * the buffer is intentionally kept alive for the late approval events.
 */
export async function onTurnEnded(sessionId: string, turnId: string): Promise<void> {
  const buf = buffers.get(bufferKey(sessionId, turnId));
  if (!buf) return;
  // Empty failed turns (no text, no tools, no steps) leave no assistant row.
  if (buf.texts.length === 0 && buf.parts.length === 0 && buf.steps === 0) return;
  await flushAssistant(buf);
  await db().update(threads).set({ updatedAt: sql`now()` }).where(eq(threads.id, buf.threadId));
}

export async function onSessionWaiting(
  sessionId: string,
  continuationToken: string | undefined,
): Promise<void> {
  // Late approval events may have mutated a kept-alive buffer — flush them.
  for (const buf of buffers.values()) {
    if (buf.sessionId === sessionId && (buf.texts.length || buf.parts.length || buf.steps)) {
      await flushAssistant(buf);
    }
  }
  await backfillOwner(sessionId);
  if (!continuationToken) return;
  await db()
    .update(threads)
    .set({ continuationToken, updatedAt: sql`now()` })
    .where(eq(threads.eveSessionId, sessionId));
}

/** Terminal session outcome — drop everything buffered for the session. */
export function onSessionEnded(sessionId: string): void {
  for (const [key, buf] of buffers) {
    if (buf.sessionId === sessionId) buffers.delete(key);
  }
}
