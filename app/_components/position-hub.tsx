'use client';

import { ChevronLeftIcon, MessageSquarePlusIcon, Trash2Icon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { PositionRef, ThreadSummary } from '@/lib/client/threads-api';
import { EditableTitle } from './editable-title';

const relTime = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

export function timeAgo(iso: string): string {
  const diffS = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diffS < 60) return 'just now';
  if (diffS < 3600) return relTime.format(-Math.round(diffS / 60), 'minute');
  if (diffS < 86400) return relTime.format(-Math.round(diffS / 3600), 'hour');
  if (diffS < 86400 * 14) return relTime.format(-Math.round(diffS / 86400), 'day');
  return new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
}

/**
 * One position's chats: header, "New chat", and its threads newest first.
 * Nothing is created until the user starts a chat.
 */
export function PositionHub({
  position,
  threads,
  subtitle,
  onBack,
  onNewChat,
  onOpen,
  onDelete,
  onRename,
}: {
  readonly position: PositionRef;
  readonly threads: ThreadSummary[];
  /** Live line from the positions/holdings list, when the row is still open. */
  readonly subtitle?: string | null;
  readonly onBack: () => void;
  readonly onNewChat: () => void;
  readonly onOpen: (id: string) => void;
  readonly onDelete: (id: string) => void;
  readonly onRename: (id: string, title: string) => void | Promise<void>;
}) {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 overflow-y-auto px-4 py-6 sm:px-6">
      <button className="flex w-fit items-center gap-1 text-muted-foreground text-xs hover:text-foreground" onClick={onBack} type="button">
        <ChevronLeftIcon className="size-3.5" /> Positions
      </button>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-medium text-2xl tracking-tight">{position.symbol}</h2>
          <p className="text-muted-foreground text-sm">
            {position.exchangeSegment} · {position.productType}
            {subtitle ? ` · ${subtitle}` : ''}
          </p>
        </div>
        <Button onClick={onNewChat}>
          <MessageSquarePlusIcon className="size-4" /> New chat
        </Button>
      </div>

      <p className="pt-2 font-medium text-muted-foreground text-xs tracking-wider">
        CHATS · {threads.length}
      </p>

      {threads.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No chats on this position yet — start one to ask the analyst about it.
        </p>
      ) : (
        threads.map((t) => (
          <div
            className="group flex items-center gap-3 rounded-lg border bg-card px-4 py-3 transition-colors hover:border-ring/40 hover:bg-accent/40"
            key={t.id}
          >
            {/* div, not button: EditableTitle nests its own rename button */}
            <div
              className="min-w-0 flex-1 cursor-pointer text-left"
              onClick={() => onOpen(t.id)}
              onKeyDown={(e) => e.key === 'Enter' && onOpen(t.id)}
              role="button"
              tabIndex={0}
            >
              <EditableTitle
                className="font-medium text-sm"
                onSave={(title) => onRename(t.id, title)}
                placeholder="New chat"
                value={t.title}
              />
              <span className="mt-0.5 block text-muted-foreground text-xs">
                updated {timeAgo(t.updatedAt)} · started {new Date(t.createdAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}
              </span>
            </div>
            <button
              aria-label="Delete chat"
              className="hidden shrink-0 rounded p-1 text-muted-foreground hover:text-destructive group-hover:block"
              onClick={() => onDelete(t.id)}
              title="Delete chat"
              type="button"
            >
              <Trash2Icon className="size-4" />
            </button>
          </div>
        ))
      )}
    </div>
  );
}
