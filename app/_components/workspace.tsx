'use client';

import { useCallback, useEffect, useState } from 'react';
import { LogOutIcon, PlugZapIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  getBrokerStatus,
  getHoldings,
  getPositions,
  SessionExpiredError,
  type BrokerStatus,
  type DhanHolding,
  type DhanPosition,
} from '@/lib/client/broker';
import { clearSession, getUser, isLoggedIn } from '@/lib/client/settings';
import {
  deleteThread as apiDeleteThread,
  renameThread as apiRenameThread,
  getThread,
  listThreads,
  positionKey,
  type PositionRef,
  type ThreadDetail,
  type ThreadSummary,
} from '@/lib/client/threads-api';
import { BrokerModal } from './broker-modal';
import { Login } from './login';
import { PositionHub } from './position-hub';
import { PositionsList } from './positions-list';
import { Sidebar } from './sidebar';
import { MarketChat } from './market-chat';

/**
 * The workspace shell: login gate → (broker gate) → sidebar + main pane.
 * Main pane is the positions list (home), a position hub (that position's
 * chats + "New chat"), a draft chat (no eve session yet; first send creates
 * it), or a resumed thread (history + eve session cursor). Any number of
 * threads per position.
 */

type View =
  | { kind: 'home' }
  | { kind: 'hub'; position: PositionRef }
  | { kind: 'draft'; position: PositionRef }
  | { kind: 'thread'; id: string };

const STARTERS = [
  'How is this position doing right now?',
  "What's the recent trend on this instrument?",
  'What are the biggest risks to this position?',
] as const;

export function Workspace() {
  // Session epoch: bumped on login/logout; keys the whole workspace.
  const [authEpoch, setAuthEpoch] = useState(0);
  const [loggedIn, setLoggedIn] = useState(false);
  useEffect(() => {
    setLoggedIn(isLoggedIn());
  }, [authEpoch]);

  const logout = useCallback(() => {
    clearSession();
    setAuthEpoch((n) => n + 1);
  }, []);

  if (!loggedIn) {
    return <Login onLoggedIn={() => setAuthEpoch((n) => n + 1)} />;
  }
  return <LoggedInWorkspace key={authEpoch} onLogout={logout} />;
}

function LoggedInWorkspace({ onLogout }: { readonly onLogout: () => void }) {
  const [view, setView] = useState<View>({ kind: 'home' });

  // --- Broker state ---
  const [broker, setBroker] = useState<BrokerStatus | null>(null);
  const [brokerModalOpen, setBrokerModalOpen] = useState(false);
  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false);
  useEffect(() => {
    getBrokerStatus()
      .then(setBroker)
      .catch((e) => {
        if (e instanceof SessionExpiredError) onLogout();
      });
  }, [onLogout]);

  // --- Positions + holdings (Dhan splits them: /positions = today's trading,
  // /holdings = delivery stock — both are chattable rows on the home list) ---
  const [positions, setPositions] = useState<DhanPosition[]>([]);
  const [holdings, setHoldings] = useState<DhanHolding[]>([]);
  const [positionsLoading, setPositionsLoading] = useState(false);
  const [positionsError, setPositionsError] = useState<string | null>(null);
  const refreshPositions = useCallback(async () => {
    setPositionsLoading(true);
    setPositionsError(null);
    try {
      const [pos, hold] = await Promise.all([getPositions(), getHoldings()]);
      setPositions(pos.ok ? pos.positions : []);
      setHoldings(hold.ok ? hold.holdings : []);
      const failed = !pos.ok ? pos : !hold.ok ? hold : null;
      if (failed && failed.code === 'BROKER_TOKEN_EXPIRED') {
        setBroker((b) => (b ? { ...b, connected: false, status: 'token_expired' } : b));
        setPositionsError('Your Dhan token expired — reconnect to see positions.');
      }
    } catch (e) {
      if (e instanceof SessionExpiredError) return onLogout();
      setPositionsError(e instanceof Error ? e.message : 'Could not load positions.');
    } finally {
      setPositionsLoading(false);
    }
  }, [onLogout]);
  useEffect(() => {
    if (broker?.status === 'active') void refreshPositions();
  }, [broker?.status, refreshPositions]);

  // --- Threads (chat history) ---
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const refreshThreads = useCallback(async (): Promise<ThreadSummary[]> => {
    try {
      const list = await listThreads();
      setThreads(list);
      return list;
    } catch {
      return [];
    }
  }, []);
  useEffect(() => {
    void refreshThreads();
  }, [refreshThreads]);

  const removeThread = useCallback(
    async (id: string) => {
      const gone = threads.find((t) => t.id === id);
      setThreads((prev) => prev.filter((t) => t.id !== id));
      setView((v) =>
        v.kind === 'thread' && v.id === id
          ? gone?.position
            ? { kind: 'hub', position: gone.position }
            : { kind: 'home' }
          : v,
      );
      try {
        await apiDeleteThread(id);
      } finally {
        void refreshThreads();
      }
    },
    [threads, refreshThreads],
  );

  const renameThread = useCallback(
    async (id: string, title: string) => {
      setThreads((prev) => prev.map((t) => (t.id === id ? { ...t, title } : t)));
      setDetail((d) => (d && d.id === id ? { ...d, title } : d));
      try {
        await apiRenameThread(id, title);
      } catch {
        void refreshThreads(); // revert to the server's truth
      }
    },
    [refreshThreads],
  );

  // --- Selected thread detail (history + resume cursor) ---
  const [detail, setDetail] = useState<ThreadDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const activeThreadId = view.kind === 'thread' ? view.id : null;
  useEffect(() => {
    if (!activeThreadId) {
      setDetail(null);
      setDetailError(null);
      return;
    }
    let cancelled = false;
    setDetail(null);
    setDetailError(null);
    getThread(activeThreadId)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch(() => {
        if (!cancelled) setDetailError("Couldn't load that chat.");
      });
    return () => {
      cancelled = true;
    };
  }, [activeThreadId]);

  // Draft lifecycle: remembers the eve session its first send created so the
  // sidebar can highlight the adopted row without remounting mid-stream.
  const [draftSessionId, setDraftSessionId] = useState<string | null>(null);
  const [draftEpoch, setDraftEpoch] = useState(0);
  const adoptedThreadId = draftSessionId
    ? (threads.find((t) => t.eveSessionId === draftSessionId)?.id ?? null)
    : null;

  /** Tap a row: open that position's hub (its chats + "New chat"). */
  const openHub = useCallback((position: PositionRef) => {
    setDraftSessionId(null);
    setView({ kind: 'hub', position });
  }, []);

  const startNewChat = useCallback((position: PositionRef) => {
    setDraftSessionId(null);
    setDraftEpoch((n) => n + 1);
    setView({ kind: 'draft', position });
  }, []);

  const openPositionChat = useCallback(
    (p: DhanPosition) =>
      openHub({
        securityId: String(p.securityId),
        exchangeSegment: String(p.exchangeSegment),
        productType: String(p.productType),
        symbol: String(p.tradingSymbol),
      }),
    [openHub],
  );

  /** Holdings have no exchangeSegment/productType — map exchange → *_EQ, CNC. */
  const openHoldingChat = useCallback(
    (h: DhanHolding) =>
      openHub({
        securityId: String(h.securityId),
        exchangeSegment: String(h.exchange).toUpperCase() === 'BSE' ? 'BSE_EQ' : 'NSE_EQ',
        productType: 'CNC',
        symbol: String(h.tradingSymbol),
      }),
    [openHub],
  );

  const selectThread = useCallback(
    (id: string) => {
      // The adopted row IS the live draft — don't remount it onto DB history.
      if (view.kind === 'draft' && id === adoptedThreadId) return;
      setDraftSessionId(null);
      setView({ kind: 'thread', id });
    },
    [view.kind, adoptedThreadId],
  );

  const sidebarActiveId = view.kind === 'thread' ? view.id : (adoptedThreadId ?? '');
  const viewPosition: PositionRef | null =
    view.kind === 'hub' || view.kind === 'draft'
      ? view.position
      : view.kind === 'thread'
        ? (detail?.position ?? threads.find((t) => t.id === view.id)?.position ?? null)
        : null;
  const activePositionKey = viewPosition ? positionKey(viewPosition) : null;
  const hubThreads = view.kind === 'hub' ? threads.filter((t) => t.position && positionKey(t.position) === activePositionKey) : [];
  const hubSubtitle = (() => {
    if (view.kind !== 'hub') return null;
    const p = positions.find((row) => positionKey({ securityId: String(row.securityId), exchangeSegment: String(row.exchangeSegment), productType: String(row.productType) }) === activePositionKey);
    if (p) return `qty ${p.netQty} · ${p.positionType}`;
    const h = holdings.find((row) => String(row.securityId) === view.position.securityId && view.position.productType === 'CNC');
    if (h) return `holding · qty ${h.totalQty} @ ₹${h.avgCostPrice}`;
    return null;
  })();

  const brokerConnected = broker?.status === 'active';
  const brokerExpired = broker?.status === 'token_expired';

  return (
    <main className="flex h-dvh overflow-hidden bg-background text-foreground">
      <Sidebar
        activeId={sidebarActiveId}
        activePositionKey={activePositionKey}
        homeActive={view.kind === 'home'}
        onDelete={(id) => void removeThread(id)}
        onHome={() => {
          setDraftSessionId(null);
          setView({ kind: 'home' });
          if (brokerConnected) void refreshPositions();
        }}
        onRename={renameThread}
        onSelect={selectThread}
        onSelectPosition={openHub}
        threads={threads}
      />

      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b px-4">
          <span className="flex items-center gap-2 truncate font-medium text-sm">
            Zap position analyst
            <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground text-xs">
              read-only
            </span>
          </span>
          <span className="flex items-center gap-1">
            <Button onClick={() => setBrokerModalOpen(true)} size="sm" variant="ghost">
              <span
                className={
                  brokerConnected
                    ? 'size-2 rounded-full bg-[#17be5f]'
                    : 'size-2 rounded-full bg-destructive'
                }
              />
              {brokerConnected ? 'Dhan connected' : brokerExpired ? 'Token expired' : 'Connect Dhan'}
              <PlugZapIcon className="size-4" />
            </Button>
            <Button
              aria-label="Sign out"
              onClick={() => setLogoutConfirmOpen(true)}
              size="sm"
              title={getUser()?.email ?? 'Sign out'}
              variant="ghost"
            >
              <LogOutIcon className="size-4" />
            </Button>
          </span>
        </header>

        {brokerExpired ? (
          <div className="flex items-center justify-between gap-3 border-b bg-destructive/5 px-4 py-2 text-sm">
            <span>Your Dhan token expired (tokens last 24h) — the analyst can’t read your account until you reconnect.</span>
            <Button onClick={() => setBrokerModalOpen(true)} size="sm" variant="outline">
              Reconnect
            </Button>
          </div>
        ) : null}

        {view.kind === 'home' ? (
          broker === null ? (
            <div className="flex flex-1 items-center justify-center text-muted-foreground text-sm">
              Loading…
            </div>
          ) : brokerConnected || brokerExpired ? (
            <PositionsList
              error={positionsError}
              holdings={holdings}
              loading={positionsLoading}
              onChat={(p) => void openPositionChat(p)}
              onChatHolding={(h) => void openHoldingChat(h)}
              onRefresh={() => void refreshPositions()}
              positions={positions}
            />
          ) : (
            <div className="flex flex-1 items-center justify-center">
              <div className="flex flex-col items-center gap-3 text-center">
                <h1 className="font-medium text-2xl tracking-tighter">Connect your Dhan account</h1>
                <p className="max-w-sm text-muted-foreground text-sm">
                  Zap reads your positions from Dhan so you can chat about them. Read-only — it can
                  never place an order.
                </p>
                <Button onClick={() => setBrokerModalOpen(true)}>Connect Dhan</Button>
              </div>
            </div>
          )
        ) : view.kind === 'hub' ? (
          <PositionHub
            onBack={() => setView({ kind: 'home' })}
            onDelete={(id) => void removeThread(id)}
            onNewChat={() => startNewChat(view.position)}
            onOpen={selectThread}
            onRename={renameThread}
            position={view.position}
            subtitle={hubSubtitle}
            threads={hubThreads}
          />
        ) : view.kind === 'draft' ? (
          <MarketChat
            chat={{
              history: [],
              starters: STARTERS,
              onSessionCreated: (sid) => {
                setDraftSessionId(sid);
                void refreshThreads();
              },
              onTurnSettled: () => void refreshThreads(),
            }}
            key={`draft:${view.position.exchangeSegment}:${view.position.securityId}:${view.position.productType}:${draftEpoch}`}
            onOpenBroker={() => setBrokerModalOpen(true)}
            position={view.position}
          />
        ) : detail ? (
          <MarketChat
            chat={{
              history: detail.messages,
              session: { sessionId: detail.eveSessionId, streamIndex: detail.streamIndex },
              starters: STARTERS,
              onTurnSettled: () => void refreshThreads(),
            }}
            key={`thread:${detail.id}`}
            onOpenBroker={() => setBrokerModalOpen(true)}
            position={
              detail.position ?? {
                securityId: '',
                exchangeSegment: '',
                productType: '',
                symbol: detail.title ?? 'position',
              }
            }
          />
        ) : (
          <div className="flex flex-1 items-center justify-center text-muted-foreground text-sm">
            {detailError ?? 'Loading chat…'}
          </div>
        )}
      </section>

      <BrokerModal
        dismissable={brokerConnected || brokerExpired || view.kind !== 'home'}
        key={`${broker?.status ?? 'none'}:${brokerModalOpen}`}
        onChanged={(next) => {
          setBroker(next);
          if (next.status === 'active') void refreshPositions();
        }}
        onOpenChange={setBrokerModalOpen}
        open={brokerModalOpen}
        status={broker}
      />

      <Dialog onOpenChange={setLogoutConfirmOpen} open={logoutConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Sign out</DialogTitle>
            <DialogDescription>
              Sign out of Zap{getUser()?.email ? ` (${getUser()?.email})` : ''}? Your Dhan
              connection and chats stay on the server — logging back in with the same email
              brings everything back.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button onClick={() => setLogoutConfirmOpen(false)} type="button" variant="ghost">
              Cancel
            </Button>
            <Button
              className="text-destructive hover:text-destructive"
              onClick={() => {
                setLogoutConfirmOpen(false);
                onLogout();
              }}
              type="button"
              variant="ghost"
            >
              <LogOutIcon className="size-4" /> Sign out
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </main>
  );
}
