'use client';

import { useEffect, useState } from 'react';
import { Client, defaultMessageReducer } from 'eve/client';
import type { EveMessage } from 'eve/react';
import { ChevronDownIcon, Loader2Icon, SparklesIcon } from 'lucide-react';
import { authHeaders } from '@/lib/client/settings';
import { cn } from '@/lib/utils';
import { AgentMessage } from './agent-message';

/**
 * Live/replayed view of a delegated subagent's own session, nested under the
 * delegation card in the parent chat (plan-options-subagent.md P4 D1). Purely
 * read-only: it consumes GET /api/eve/v1/session/<child>/stream (the proxy
 * authorizes child ids via the session_context row the stream tee copies on
 * subagent.called) and renders the child's tool calls, charts and streaming
 * text with the same components as the main chat.
 *
 * Implementation note: this reads the stream DIRECTLY via eve/client's
 * `session.stream()` + `defaultMessageReducer` — NOT via useEveAgent, whose
 * store only reads a stream inside send(); a send-less hook never attaches
 * (found live: the panel sat on its placeholder forever). `stream()` has
 * open-retries (12×250 ms, 404 included) and disconnect reconnects built in,
 * and ends when the child session's stream closes — a completed child replays
 * fully and then settles.
 */
export function SubagentView({
  childSessionId,
  label = 'Options specialist',
}: {
  readonly childSessionId: string;
  readonly label?: string;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="rounded-lg border border-dashed bg-muted/20">
      <button
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-muted-foreground text-xs transition-colors hover:text-foreground"
        onClick={() => setOpen((v) => !v)}
        type="button"
      >
        <SparklesIcon className="size-3.5" />
        <span className="font-medium">{label}</span>
        <span className="opacity-60">— delegated session</span>
        <ChevronDownIcon className={cn('ml-auto size-3.5 transition-transform', open ? '' : '-rotate-90')} />
      </button>
      {open ? <SubagentStream childSessionId={childSessionId} /> : null}
    </div>
  );
}

const MAX_ATTACH_ATTEMPTS = 3;

/** Mounted only while open, so collapsed cards hold no stream. */
function SubagentStream({ childSessionId }: { readonly childSessionId: string }) {
  const [attempt, setAttempt] = useState(0);
  return <SubagentStreamAttempt attempt={attempt} childSessionId={childSessionId} key={attempt} onRetry={setAttempt} />;
}

function SubagentStreamAttempt({
  attempt,
  childSessionId,
  onRetry,
}: {
  readonly attempt: number;
  readonly childSessionId: string;
  readonly onRetry: (next: number) => void;
}) {
  const [messages, setMessages] = useState<readonly EveMessage[]>([]);
  const [live, setLive] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let alive = true;
    void (async () => {
      try {
        const client = new Client({
          host: '/api',
          headers: () => authHeaders(),
          maxReconnectAttempts: 20,
        });
        const session = client.session({ sessionId: childSessionId, streamIndex: 0 });
        const reducer = defaultMessageReducer();
        let data = reducer.initial();
        for await (const event of session.stream({ signal: controller.signal, startIndex: 0 })) {
          if (!alive) return;
          data = reducer.reduce(data, event);
          setMessages((data as { messages: readonly EveMessage[] }).messages);
        }
        if (alive) setLive(false);
      } catch (e) {
        if (alive && !controller.signal.aborted) {
          console.warn('[zap-eve] subagent stream failed:', e);
          setFailed(true);
        }
      }
    })();
    return () => {
      alive = false;
      controller.abort();
    };
  }, [childSessionId]);

  if (failed) {
    return (
      <p className="flex items-center gap-2 px-3 pb-2.5 text-muted-foreground text-xs">
        {attempt < MAX_ATTACH_ATTEMPTS ? (
          <>
            <Loader2Icon className="size-3 animate-spin" />
            <RetryIn onRetry={() => onRetry(attempt + 1)} seconds={2 * (attempt + 1)} />
          </>
        ) : (
          'Couldn’t load the specialist’s working — its final answer above still stands.'
        )}
      </p>
    );
  }

  // Anything the specialist has visibly produced (tool card, streamed text,
  // reasoning pill) — until then, keep a live working indicator.
  const hasVisibleWork = messages.some(
    (m) =>
      m.role === 'assistant' &&
      m.parts.some(
        (p) =>
          (p.type === 'text' && p.text.trim().length > 0) ||
          (p.type === 'reasoning' && (p.state === 'streaming' || Boolean(p.text?.trim()))) ||
          p.type === 'dynamic-tool' ||
          p.type === 'authorization',
      ),
  );

  return (
    <div className="subagent-nest flex flex-col gap-3 border-t border-dashed px-3 py-3">
      {hasVisibleWork ? null : (
        <p className="flex items-center gap-2 text-muted-foreground text-xs">
          {live ? (
            <>
              <Loader2Icon className="size-3 animate-spin" />
              Specialist is working…
            </>
          ) : (
            'No specialist activity was recorded for this delegation.'
          )}
        </p>
      )}
      {messages.map((message, index) =>
        // The delegation `message` the parent packed is internal plumbing —
        // only show what the specialist did with it.
        message.role === 'user' ? null : (
          <AgentMessage
            canRespond={false}
            isStreaming={live && index === messages.length - 1}
            key={message.id}
            message={message}
            onInputResponses={() => {
              /* answered on the root session's card, never here */
            }}
          />
        ),
      )}
    </div>
  );
}

/** Small helper: waits, then triggers the retry (renders while counting). */
function RetryIn({ onRetry, seconds }: { readonly onRetry: () => void; readonly seconds: number }) {
  useEffect(() => {
    const timer = setTimeout(onRetry, seconds * 1000);
    return () => clearTimeout(timer);
  }, [onRetry, seconds]);
  return <span>Reconnecting to the specialist’s session…</span>;
}
