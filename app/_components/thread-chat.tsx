'use client';

import type { UserContent } from 'ai';
import { useEffect, useRef } from 'react';
import { useEveAgent } from 'eve/react';
import { AlertCircleIcon } from 'lucide-react';
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation';
import {
  PromptInput,
  type PromptInputMessage,
  PromptInputSubmit,
  PromptInputTextarea,
} from '@/components/ai-elements/prompt-input';
import { cn } from '@/lib/utils';
import { formatCost, formatUsageLine, totalCostUsd, usageByTurn } from '@/lib/usage';
import { authHeaders } from '@/lib/client/settings';
import type { ApiMessage } from '@/lib/client/threads-api';
import { AgentMessage } from './agent-message';
import { HistoryMessage } from './history-message';

/**
 * One conversation: persisted history (rendered from our DB) followed by the
 * live eve session. Mount keyed by thread — a resumed thread passes `session`
 * (eve session id + stream cursor), so the hook attaches AFTER the history it
 * already shows and nothing replays twice. All eve traffic goes through the
 * app proxy (`host: "/api/eve"`), which owns credentials and continuation
 * tokens; the placeholder token below is never used upstream.
 */
export function ThreadChat({
  history,
  session,
  position,
  starters,
  onSessionCreated,
  onTurnSettled,
}: {
  readonly history: ApiMessage[];
  readonly session?: { sessionId: string; streamIndex: number };
  /** The position this chat is about (shown in the empty state; sent to the
   * proxy as a header so a draft's first send creates a position-scoped
   * session). Required for drafts; informational for resumed threads. */
  readonly position: { securityId: string; exchangeSegment: string; productType: string; symbol: string };
  /** Starter prompts shown on the empty state; clicking one sends it. */
  readonly starters?: readonly string[];
  /** A draft's first send created an eve session (fired once). */
  readonly onSessionCreated?: (eveSessionId: string) => void;
  /** A turn finished (or failed) — refresh sidebar titles/order. */
  readonly onTurnSettled?: () => void;
}) {
  const agent = useEveAgent({
    // The client appends /eve/v1/... itself → requests hit /api/eve/v1/*.
    host: '/api',
    headers: () => ({ ...authHeaders(), 'x-zap-position': JSON.stringify(position) }),
    initialSession: session
      ? {
          sessionId: session.sessionId,
          continuationToken: 'proxy-managed',
          streamIndex: session.streamIndex,
        }
      : undefined,
  });

  const isBusy = agent.status === 'submitted' || agent.status === 'streaming';
  const isEmpty = history.length === 0 && agent.data.messages.length === 0;
  const turnUsage = usageByTurn(agent.events);

  // Conversation total = persisted turn costs + live turns estimated from usage.
  const storedCost = history.reduce((sum, m) => sum + (m.cost?.total ?? 0), 0);
  const conversationCost = storedCost + totalCostUsd(turnUsage);

  // Notify the workspace exactly once when a draft becomes a real session.
  const announcedSession = useRef(false);
  const liveSessionId = agent.session?.sessionId;
  useEffect(() => {
    if (!session && liveSessionId && !announcedSession.current) {
      announcedSession.current = true;
      onSessionCreated?.(liveSessionId);
    }
  }, [session, liveSessionId, onSessionCreated]);

  // Sidebar refresh on turn boundaries (streaming → ready/error).
  const wasBusy = useRef(false);
  useEffect(() => {
    if (wasBusy.current && !isBusy) onTurnSettled?.();
    wasBusy.current = isBusy;
  }, [isBusy, onTurnSettled]);

  const handleSubmit = async (message: PromptInputMessage) => {
    const text = message.text.trim();
    if ((text.length === 0 && message.files.length === 0) || isBusy) return;

    if (message.files.length === 0) {
      await agent.send({ message: text });
      return;
    }
    const parts: UserContent = [];
    if (text.length > 0) parts.push({ text, type: 'text' });
    for (const file of message.files) {
      parts.push({
        data: file.url,
        filename: file.filename,
        mediaType: file.mediaType,
        type: 'file',
      });
    }
    await agent.send({ message: parts });
  };

  const composer = (
    <PromptInput onSubmit={handleSubmit}>
      <PromptInputTextarea placeholder={`Ask about your ${position.symbol} position…`} />
      <PromptInputSubmit onStop={agent.stop} status={agent.status} />
    </PromptInput>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {agent.error ? (
        <div className="mx-auto w-full max-w-3xl shrink-0 px-4 pt-2 sm:px-6">
          <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm">
            <AlertCircleIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
            <div>
              <p className="font-medium">Request failed</p>
              <p className="mt-0.5 text-muted-foreground">{agent.error.message}</p>
            </div>
          </div>
        </div>
      ) : null}

      {isEmpty ? null : (
        <Conversation className="min-h-0 flex-1">
          <ConversationContent className="mx-auto w-full max-w-3xl gap-6 px-4 py-6 sm:px-6">
            {history.map((message) => (
              <HistoryMessage key={message.id} message={message} />
            ))}
            {agent.data.messages.map((message, index) => {
              const usage =
                message.role === 'assistant' &&
                message.metadata?.status === 'complete' &&
                message.metadata.turnId
                  ? turnUsage.get(message.metadata.turnId)
                  : undefined;
              return (
                <div className="flex flex-col gap-1.5" key={message.id}>
                  <AgentMessage
                    canRespond={!isBusy}
                    isStreaming={
                      agent.status === 'streaming' && index === agent.data.messages.length - 1
                    }
                    message={message}
                    onInputResponses={(inputResponses) => agent.send({ inputResponses })}
                  />
                  {usage ? (
                    <p className="text-muted-foreground/70 text-xs">{formatUsageLine(usage)}</p>
                  ) : null}
                </div>
              );
            })}
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>
      )}

      {conversationCost > 0 && !isEmpty ? (
        <p className="mx-auto w-full max-w-3xl shrink-0 px-4 pb-1 text-right text-muted-foreground/70 text-xs sm:px-6">
          Conversation total: {formatCost(conversationCost)}
        </p>
      ) : null}

      <div
        className={cn(
          'mx-auto w-full px-4 sm:px-6',
          isEmpty
            ? 'flex max-w-xl flex-1 flex-col items-center justify-center gap-8 pb-[10vh]'
            : 'max-w-3xl shrink-0 pb-6',
        )}
      >
        {isEmpty ? (
          <div className="flex flex-col items-center gap-2 text-center">
            <h1 className="font-medium text-4xl tracking-tighter">{position.symbol}</h1>
            <p className="text-muted-foreground text-sm">
              {position.exchangeSegment} · {position.productType} — ask the analyst anything about
              this position. Read-only: it can never trade.
            </p>
          </div>
        ) : null}
        <div className="w-full">
          {isEmpty && starters && starters.length > 0 ? (
            <div className="mb-3 flex w-full gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {starters.map((starter) => (
                <button
                  className="shrink-0 whitespace-nowrap rounded-full border bg-background px-3.5 py-1.5 text-muted-foreground text-sm transition-colors hover:border-ring/40 hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
                  disabled={isBusy}
                  key={starter}
                  onClick={() => void handleSubmit({ text: starter, files: [] })}
                  type="button"
                >
                  {starter}
                </button>
              ))}
            </div>
          ) : null}
          {composer}
        </div>
      </div>
    </div>
  );
}
