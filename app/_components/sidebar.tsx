'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  ChevronDownIcon,
  ChevronRightIcon,
  LayoutListIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  RadarIcon,
  Trash2Icon,
  ZapIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { positionKey, type PositionRef, type ThreadSummary } from '@/lib/client/threads-api';
import { EditableTitle } from './editable-title';

const RAIL_COLLAPSED_KEY = 'zap-eve:sidebar-collapsed';

interface PositionGroup {
  key: string;
  position: PositionRef;
  threads: ThreadSummary[];
  latest: string;
}

/**
 * Chat history grouped by position: a collapsible header per position (tap →
 * that position's hub) with its threads nested, newest first. Closed
 * positions keep their group — chats are never auto-removed.
 */
export function Sidebar({
  threads,
  activeId,
  activePositionKey,
  homeActive,
  watchersActive,
  onHome,
  onWatchers,
  onSelect,
  onSelectPosition,
  onDelete,
  onRename,
}: {
  readonly threads: ThreadSummary[];
  readonly activeId: string;
  readonly activePositionKey: string | null;
  readonly homeActive: boolean;
  readonly watchersActive: boolean;
  readonly onHome: () => void;
  readonly onWatchers: () => void;
  readonly onSelect: (id: string) => void;
  readonly onSelectPosition: (position: PositionRef) => void;
  readonly onDelete: (id: string) => void;
  readonly onRename: (id: string, title: string) => void | Promise<void>;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [railCollapsed, setRailCollapsed] = useState(false);

  useEffect(() => {
    try {
      if (localStorage.getItem(RAIL_COLLAPSED_KEY) === '1') setRailCollapsed(true);
    } catch {
      // storage unavailable — start expanded
    }
  }, []);

  const toggleRail = () =>
    setRailCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(RAIL_COLLAPSED_KEY, next ? '1' : '0');
      } catch {
        // storage unavailable — state still toggles for this session
      }
      return next;
    });

  const groups = useMemo<PositionGroup[]>(() => {
    const byKey = new Map<string, PositionGroup>();
    for (const t of threads) {
      if (!t.position) continue;
      const key = positionKey(t.position);
      const g = byKey.get(key) ?? { key, position: t.position, threads: [], latest: t.updatedAt };
      g.threads.push(t);
      if (t.updatedAt > g.latest) g.latest = t.updatedAt;
      byKey.set(key, g);
    }
    return [...byKey.values()].sort((a, b) => (a.latest < b.latest ? 1 : -1));
  }, [threads]);

  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <aside
      className={cn(
        'relative h-full shrink-0 overflow-hidden border-r bg-sidebar text-sidebar-foreground',
        'transition-[width] duration-300 ease-in-out motion-reduce:transition-none',
        railCollapsed ? 'w-14' : 'w-64',
      )}
    >
      {/* Collapsed rail — cross-fades while the aside width slides. */}
      <div
        className={cn(
          'absolute inset-y-0 left-0 flex w-14 flex-col items-center transition-opacity duration-200 motion-reduce:transition-none',
          railCollapsed ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
        inert={!railCollapsed}
      >
        <span className="mt-4 flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <ZapIcon className="size-4" />
        </span>
        <button
          aria-label="Expand sidebar"
          className="mt-3 rounded-md p-1.5 text-muted-foreground hover:bg-accent/50 hover:text-foreground"
          onClick={toggleRail}
          title="Expand sidebar"
          type="button"
        >
          <PanelLeftOpenIcon className="size-4" />
        </button>
        <Button
          aria-label="Positions"
          className={cn('mt-2', homeActive && 'bg-accent text-accent-foreground')}
          onClick={onHome}
          size="icon-sm"
          title="Positions"
          variant="secondary"
        >
          <LayoutListIcon className="size-4" />
        </Button>
        <Button
          aria-label="Watchers"
          className={cn('mt-2', watchersActive && 'bg-accent text-accent-foreground')}
          onClick={onWatchers}
          size="icon-sm"
          title="Watchers"
          variant="secondary"
        >
          <RadarIcon className="size-4" />
        </Button>
      </div>

      {/* Expanded content — fixed w-64 inner width so text clips instead of reflowing mid-slide. */}
      <div
        className={cn(
          'absolute inset-y-0 left-0 flex w-64 flex-col transition-opacity duration-200 motion-reduce:transition-none',
          railCollapsed ? 'pointer-events-none opacity-0' : 'opacity-100',
        )}
        inert={railCollapsed}
      >
      <div className="flex items-center gap-2.5 px-4 pt-4 pb-2">
        <span className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <ZapIcon className="size-4" />
        </span>
        <span className="flex-1 font-semibold">Zap</span>
        <button
          aria-label="Collapse sidebar"
          className="rounded-md p-1.5 text-muted-foreground hover:bg-accent/50 hover:text-foreground"
          onClick={toggleRail}
          title="Collapse sidebar"
          type="button"
        >
          <PanelLeftCloseIcon className="size-4" />
        </button>
      </div>

      <div className="flex flex-col gap-1.5 px-3 pt-2">
        <Button
          className={cn('w-full justify-start', homeActive && 'bg-accent text-accent-foreground')}
          onClick={onHome}
          size="sm"
          variant="secondary"
        >
          <LayoutListIcon className="size-4" /> Positions
        </Button>
        <Button
          className={cn('w-full justify-start', watchersActive && 'bg-accent text-accent-foreground')}
          onClick={onWatchers}
          size="sm"
          variant="secondary"
        >
          <RadarIcon className="size-4" /> Watchers
        </Button>
      </div>

      <p className="px-4 pt-5 pb-1 font-medium text-muted-foreground text-xs tracking-wider">CHATS</p>

      <nav className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-3">
        {groups.length === 0 ? (
          <p className="px-2 pt-2 text-muted-foreground text-sm">No chats yet — pick a position to start one.</p>
        ) : (
          groups.map((g) => {
            const isCollapsed = collapsed.has(g.key);
            const groupActive = !homeActive && activePositionKey === g.key;
            return (
              <div key={g.key}>
                <div
                  className={cn(
                    'flex items-center gap-1 rounded-md',
                    groupActive && activeId === '' ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
                  )}
                >
                  <button
                    aria-label={isCollapsed ? 'Expand' : 'Collapse'}
                    className="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground"
                    onClick={() => toggle(g.key)}
                    type="button"
                  >
                    {isCollapsed ? <ChevronRightIcon className="size-3.5" /> : <ChevronDownIcon className="size-3.5" />}
                  </button>
                  <button
                    className="min-w-0 flex-1 py-1.5 pr-2 text-left"
                    onClick={() => onSelectPosition(g.position)}
                    title={`${g.position.symbol} · ${g.threads.length} chat${g.threads.length === 1 ? '' : 's'}`}
                    type="button"
                  >
                    <span className="block truncate font-medium text-sm">{g.position.symbol}</span>
                    <span className="block truncate text-muted-foreground text-xs">
                      {g.position.exchangeSegment} · {g.position.productType} · {g.threads.length}
                    </span>
                  </button>
                </div>

                {isCollapsed
                  ? null
                  : g.threads.map((t) => {
                      const active = !homeActive && t.id === activeId;
                      return (
                        <div
                          className={cn(
                            'group ml-4 flex items-center gap-1 rounded-md border-l pl-2',
                            active ? 'border-primary bg-accent text-accent-foreground' : 'border-border hover:bg-accent/50',
                          )}
                          key={t.id}
                        >
                          {/* div, not button: EditableTitle nests its own rename button */}
                          <div
                            className="min-w-0 flex-1 cursor-pointer py-1.5 text-left text-sm"
                            onClick={() => onSelect(t.id)}
                            onKeyDown={(e) => e.key === 'Enter' && onSelect(t.id)}
                            role="button"
                            tabIndex={0}
                          >
                            <EditableTitle
                              onSave={(title) => onRename(t.id, title)}
                              placeholder="New chat"
                              value={t.title}
                            />
                          </div>
                          <button
                            aria-label="Delete chat"
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
                    })}
              </div>
            );
          })
        )}
      </nav>
      </div>
    </aside>
  );
}
