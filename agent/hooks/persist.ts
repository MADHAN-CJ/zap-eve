import { defineHook } from 'eve/hooks';
import {
  onActionResult,
  onActionsRequested,
  onAnyEvent,
  onMessageCompleted,
  onMessageReceived,
  onSessionEnded,
  onSessionStarted,
  onSessionWaiting,
  onStepCompleted,
  onTurnEnded,
  onTurnStarted,
} from '#lib/db/mirror.js';

/**
 * Chat-history projection: mirrors the session stream into
 * Postgres so the product UI can list threads and reload history without ever
 * touching eve's workflow store. Hooks run after each event is
 * durably recorded and are observe-only, so persistence can lag but never
 * corrupt or block a turn.
 *
 * Every handler swallows its own errors: a down database must never break the
 * agent loop. Failures are logged once per event with the session id only —
 * never message content, never credentials.
 */

/**
 * The hook context namespaces the continuation token with the channel
 * namespace, so for the default eve channel it reads `eve:eve:<uuid>` while
 * the HTTP API expects `eve:<uuid>`. Strip one copy of a REPEATED leading
 * segment (`X:X:…` → `X:…`) — the only corruption observed, and a rule that
 * cannot alter a well-formed single-namespace token. NOTE:
 * sending the double-prefixed form to POST /eve/v1/session/<id> does NOT
 * error — it silently starts a NEW session (routing follows the token, not
 * the URL), so storing the wrong form would fork every resumed thread.
 */
function apiContinuationToken(channel: { continuationToken?: string }): string | undefined {
  const raw = channel.continuationToken;
  if (!raw) return raw;
  const doubled = /^([^:]+):\1:(.+)$/.exec(raw);
  return doubled ? `${doubled[1]}:${doubled[2]}` : raw;
}

function guard(label: string, work: Promise<void> | void): Promise<void> | void {
  if (!(work instanceof Promise)) return;
  return work.catch((e) => {
    console.error(`[persist] ${label} failed:`, e instanceof Error ? e.message : e);
  });
}

export default defineHook({
  events: {
    /** Resume-cursor counter: one increment per stream event (schema.streamIndex). */
    async '*'(_event, ctx) {
      await guard('*', onAnyEvent(ctx.session.id));
    },
    async 'session.started'(_event, ctx) {
      await guard('session.started', onSessionStarted(ctx.session.id));
    },
    'turn.started'(event, ctx) {
      const d = event.data as { turnId: string };
      try {
        onTurnStarted(ctx.session.id, d.turnId);
      } catch (e) {
        console.error('[persist] turn.started failed:', e instanceof Error ? e.message : e);
      }
    },
    async 'message.received'(event, ctx) {
      const d = event.data as { message: string; sequence: number; turnId: string };
      await guard('message.received', onMessageReceived(ctx.session.id, d));
    },
    async 'actions.requested'(event, ctx) {
      const d = event.data as {
        turnId: string;
        sequence: number;
        actions: readonly { kind: string; callId: string; toolName?: string; input?: unknown }[];
      };
      await guard('actions.requested', onActionsRequested(ctx.session.id, d));
    },
    async 'action.result'(event, ctx) {
      const d = event.data as Parameters<typeof onActionResult>[1];
      await guard('action.result', onActionResult(ctx.session.id, d));
    },
    async 'message.completed'(event, ctx) {
      const d = event.data as { turnId: string; sequence: number; message: string | null };
      await guard('message.completed', onMessageCompleted(ctx.session.id, d));
    },
    'step.completed'(event, ctx) {
      const d = event.data as {
        turnId: string;
        usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };
      };
      try {
        onStepCompleted(ctx.session.id, d);
      } catch (e) {
        console.error('[persist] step.completed failed:', e instanceof Error ? e.message : e);
      }
    },
    async 'turn.completed'(event, ctx) {
      const d = event.data as { turnId: string };
      await guard('turn.completed', onTurnEnded(ctx.session.id, d.turnId));
    },
    async 'turn.failed'(event, ctx) {
      const d = event.data as { turnId: string };
      await guard('turn.failed', onTurnEnded(ctx.session.id, d.turnId));
    },
    async 'session.waiting'(_event, ctx) {
      await guard(
        'session.waiting',
        onSessionWaiting(ctx.session.id, apiContinuationToken(ctx.channel)),
      );
    },
    'session.completed'(_event, ctx) {
      onSessionEnded(ctx.session.id);
    },
    'session.failed'(_event, ctx) {
      onSessionEnded(ctx.session.id);
    },
  },
});
