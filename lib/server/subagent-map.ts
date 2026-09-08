import { eq, sql } from 'drizzle-orm';
import { db } from '@/agent/lib/db/client';
import { messages, sessionContext, threads } from '@/agent/lib/db/schema';

/**
 * Child-session bookkeeping for subagent delegations, driven by the PROXY
 * (app/api/eve/v1) tee-ing the root stream — because eve 0.22.1 never
 * dispatches `subagent.called` to hooks (verified: streamIndex undercounts by
 * exactly one per delegation; the emit in dispatch-runtime-actions-step.js
 * skips dispatchStreamEventHooks). The persist-hook handler stays in place
 * and is idempotent with this, so a later eve fixing the dispatch breaks
 * nothing.
 *
 * Two writes, both idempotent and fail-soft:
 *  1. IMMEDIATELY on subagent.called: a session_context row for the child
 *     (copied from the root) — the proxy's ownership proof for the child
 *     stream, needed while the delegation is still running.
 *  2. AT THE TURN BOUNDARY: childSessionId stamped onto the persisted
 *     delegation tool_call part (drives nested history replay). It cannot be
 *     stamped mid-turn — the persist hook's flushAssistant rewrites `parts`
 *     wholesale from its buffer on every later event (verified live:
 *     rowCount=1 then erased) — so the tee defers until it sees the
 *     turn-boundary event, then stamps and VERIFIES, re-stamping if a late
 *     hook flush overwrote it.
 *
 * Known limitation: if the streaming client disconnects mid-turn, the stamp
 * may never run for that delegation (ownership row survives; only nested
 * history replay is lost for that turn).
 */

function copyChildContext(rootSessionId: string, childSessionId: string): void {
  void db()
    .execute(
      sql`
        insert into ${sessionContext}
          (eve_session_id, user_id, security_id, exchange_segment, product_type, symbol)
        select ${childSessionId}, user_id, security_id, exchange_segment, product_type, symbol
          from ${sessionContext} where eve_session_id = ${rootSessionId}
        on conflict (eve_session_id) do nothing`,
    )
    .catch((e) => {
      console.error('[subagent-map] context copy failed:', e instanceof Error ? e.message : e);
    });
}

async function stampOnce(threadId: string, callId: string, childSessionId: string): Promise<boolean> {
  const res = await db().execute(sql`
    update ${messages} set parts = (
      select coalesce(jsonb_agg(
        case when t.p->>'type' = 'tool_call' and t.p->>'toolCallId' = ${callId}
          then t.p || jsonb_build_object('childSessionId', ${childSessionId}::text)
          else t.p end), '[]'::jsonb)
      from jsonb_array_elements(${messages.parts}) as t(p))
    where ${messages.threadId} = ${threadId}
      and ${messages.parts} @> ${JSON.stringify([{ toolCallId: callId, type: 'tool_call' }])}::jsonb`);
  return ((res as { rowCount?: number }).rowCount ?? 0) > 0;
}

async function isStamped(threadId: string, callId: string, childSessionId: string): Promise<boolean> {
  const rows = await db().execute(sql`
    select 1 from ${messages}
    where ${messages.threadId} = ${threadId}
      and ${messages.parts} @> ${JSON.stringify([{ toolCallId: callId, childSessionId }])}::jsonb
    limit 1`);
  return ((rows as { rowCount?: number }).rowCount ?? 0) > 0;
}

/** Stamp after the turn settles; verify and re-stamp if a late flush erased it. */
function stampWhenStable(rootSessionId: string, callId: string, childSessionId: string): void {
  void (async () => {
    try {
      for (let round = 0; round < 8; round++) {
        await new Promise((r) => setTimeout(r, 1500));
        const thread = await db().query.threads.findFirst({
          columns: { id: true },
          where: eq(threads.eveSessionId, rootSessionId),
        });
        if (!thread) continue;
        if (await isStamped(thread.id, callId, childSessionId)) return;
        await stampOnce(thread.id, callId, childSessionId);
      }
    } catch (e) {
      console.error('[subagent-map] part stamp failed:', e instanceof Error ? e.message : e);
    }
  })();
}

/** NDJSON tee: passes bytes through untouched, observes subagent + boundary events. */
export function teeSubagentCalls(rootSessionId: string, upstream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  let buf = '';
  /** Delegations seen this connection whose part stamp is still pending. */
  const pending: { callId: string; childSessionId: string }[] = [];
  const flushPending = () => {
    for (const p of pending.splice(0)) stampWhenStable(rootSessionId, p.callId, p.childSessionId);
  };
  const scan = (chunk: Uint8Array) => {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      if (line.includes('subagent.called')) {
        try {
          const ev = JSON.parse(line) as { type?: string; data?: { callId?: string; childSessionId?: string } };
          if (ev.type === 'subagent.called' && ev.data?.callId && ev.data.childSessionId) {
            copyChildContext(rootSessionId, ev.data.childSessionId);
            pending.push({ callId: ev.data.callId, childSessionId: ev.data.childSessionId });
          }
        } catch {
          // partial/foreign line — never disturb the passthrough
        }
      } else if (pending.length > 0 && /"type":"session\.(waiting|completed|failed)"/.test(line)) {
        flushPending();
      }
    }
    // Keep the tail bounded: a pathological no-newline stream must not grow it.
    if (buf.length > 262144) buf = buf.slice(-131072);
  };
  return upstream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk);
        try {
          scan(chunk);
        } catch {
          // observation must never break the stream
        }
      },
      flush() {
        // Upstream ended (or client is gone) — fire whatever is still queued.
        try {
          flushPending();
        } catch {}
      },
    }),
  );
}
