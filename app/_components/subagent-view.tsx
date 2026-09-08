'use client';

import { useEffect, useState } from 'react';
import { useEveAgent } from 'eve/react';
import { ChevronDownIcon, SparklesIcon } from 'lucide-react';
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
      <p className="px-3 pb-2.5 text-muted-foreground text-xs">
        {attempt < MAX_ATTACH_ATTEMPTS
          ? 'Connecting to the specialist’s session…'
          : 'Couldn’t load the specialist’s working — its final answer above still stands.'}
      </p>
    );
  }

  return (
    <div className="subagent-nest flex flex-col gap-3 border-t border-dashed px-3 py-3">
      {agent.data.messages.length === 0 ? (
        <p className="text-muted-foreground text-xs">Loading the specialist’s working…</p>
      ) : null}
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
