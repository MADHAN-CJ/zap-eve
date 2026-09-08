'use client';

import { useEffect, useState } from 'react';
import { useEveAgent, type EveMessagePart } from 'eve/react';
import { ChevronDownIcon, Loader2Icon, SparklesIcon } from 'lucide-react';
import { authHeaders } from '@/lib/client/settings';
import { cn } from '@/lib/utils';
import { AgentMessage } from './agent-message';

/**
 * Live/replayed view of a delegated subagent's own session, nested under the
 * delegation card in the parent chat (plan-options-subagent.md P4 D1). Purely
 * read-only: it attaches to GET /api/eve/v1/session/<child>/stream (the proxy
 * authorizes child ids via the session_context row copied on subagent.called)
 * and renders the child's tool calls, charts and text with the same components
 * as the main chat. Child streams are durable — history replays from index 0.
 * Never sends: the child's own questions/approvals are proxied by eve to the
 * ROOT stream and answered there.
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

const MAX_ATTACH_ATTEMPTS = 5;

/** Mounted only while open, so collapsed cards hold no stream. */
function SubagentStream({ childSessionId }: { readonly childSessionId: string }) {
  // The child's ownership row can lag its `subagent.called` event by a moment
  // (hook write vs browser attach race) — remount the hook a few times with
  // backoff instead of dying on the first 404.
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
  const agent = useEveAgent({
    host: '/api',
    headers: () => authHeaders(),
    initialSession: {
      sessionId: childSessionId,
      continuationToken: 'proxy-managed', // read-only: nothing is ever sent
      streamIndex: 0,
    },
  });

  const failed = Boolean(agent.error);
  useEffect(() => {
    if (!failed || attempt >= MAX_ATTACH_ATTEMPTS) return;
    const timer = setTimeout(() => onRetry(attempt + 1), 1500 * (attempt + 1));
    return () => clearTimeout(timer);
  }, [failed, attempt, onRetry]);

  if (agent.error) {
    return (
      <p className="flex items-center gap-2 px-3 pb-2.5 text-muted-foreground text-xs">
        {attempt < MAX_ATTACH_ATTEMPTS ? (
          <>
            <Loader2Icon className="size-3 animate-spin" />
            Connecting to the specialist’s session…
          </>
        ) : (
          'Couldn’t load the specialist’s working — its final answer above still stands.'
        )}
      </p>
    );
  }

  // Anything the specialist has visibly produced (tool card, streamed text,
  // reasoning pill) — until then, keep a live working indicator. The child's
  // answer text streams here token-by-token once it starts.
  const visiblePart = (p: EveMessagePart) =>
    (p.type === 'text' && p.text.trim().length > 0) ||
    (p.type === 'reasoning' && (p.state === 'streaming' || Boolean(p.text?.trim()))) ||
    p.type === 'dynamic-tool' ||
    p.type === 'authorization';
  const hasVisibleWork = agent.data.messages.some(
    (m) => m.role === 'assistant' && m.parts.some(visiblePart),
  );

  return (
    <div className="subagent-nest flex flex-col gap-3 border-t border-dashed px-3 py-3">
      {hasVisibleWork ? null : (
        <p className="flex items-center gap-2 text-muted-foreground text-xs">
          <Loader2Icon className="size-3 animate-spin" />
          Specialist is working…
        </p>
      )}
      {agent.data.messages.map((message, index) =>
        // The delegation `message` the parent packed is internal plumbing —
        // only show what the specialist did with it.
        message.role === 'user' ? null : (
          <AgentMessage
            canRespond={false}
            isStreaming={agent.status === 'streaming' && index === agent.data.messages.length - 1}
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
