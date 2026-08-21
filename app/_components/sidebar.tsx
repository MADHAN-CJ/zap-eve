'use client';

import { LayoutListIcon, Trash2Icon, ZapIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { ThreadSummary } from '@/lib/client/threads-api';

/**
 * Chat-history sidebar: brand, "Positions" (home), and the user's position
 * chats with per-item delete and active highlight. Chats are never
 * auto-disabled — a chat on a closed position stays here until deleted.
 */
export function Sidebar({
  threads,
  activeId,
  homeActive,
  onHome,
  onSelect,
  onDelete,
}: {
  readonly threads: ThreadSummary[];
  readonly activeId: string;
  readonly homeActive: boolean;
  readonly onHome: () => void;
  readonly onSelect: (id: string) => void;
  readonly onDelete: (id: string) => void;
}) {
  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground">
      <div className="flex items-center gap-2.5 px-4 pt-4 pb-2">
        <span className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <ZapIcon className="size-4" />
        </span>
        <span className="font-semibold">Zap</span>
      </div>

      <div className="px-3 pt-2">
        <Button
          className={cn('w-full justify-start', homeActive && 'bg-accent text-accent-foreground')}
          onClick={onHome}
          size="sm"
          variant="secondary"
        >
          <LayoutListIcon className="size-4" /> Positions
        </Button>
      </div>

      <p className="px-4 pt-5 pb-1 font-medium text-muted-foreground text-xs tracking-wider">
        POSITION CHATS
      </p>

      <nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-3">
        {threads.length === 0 ? (
          <p className="px-2 pt-2 text-muted-foreground text-sm">
            No chats yet — pick a position to start one.
          </p>
        ) : (
          threads.map((t) => {
            const label = t.position?.symbol ?? t.title ?? 'Position chat';
            const sub = t.position ? `${t.position.exchangeSegment} · ${t.position.productType}` : null;
            const active = !homeActive && t.id === activeId;
            return (
              <div
                className={cn(
                  'group flex items-center gap-1 rounded-md',
                  active ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
                )}
                key={t.id}
              >
                <button
                  className="min-w-0 flex-1 px-2 py-1.5 text-left"
                  onClick={() => onSelect(t.id)}
                  title={label}
                  type="button"
                >
                  <span className="block truncate text-sm">{label}</span>
                  {sub ? <span className="block truncate text-muted-foreground text-xs">{sub}</span> : null}
                </button>
                <button
                  aria-label={`Delete ${label}`}
                  className="mr-1 hidden shrink-0 rounded p-1 text-muted-foreground hover:text-destructive group-hover:block"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(t.id);
                  }}
                  title="Delete chat"
                  type="button"
                >
                  <Trash2Icon className="size-3.5" />
                </button>
              </div>
            );
          })
        )}
      </nav>
    </aside>
  );
}
