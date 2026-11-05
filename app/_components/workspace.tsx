'use client';

import { useCallback, useEffect, useState } from 'react';
import { CheckIcon, CopyIcon, DownloadIcon, FileTextIcon, LogOutIcon, PlugZapIcon } from 'lucide-react';
import { Wordmark } from '@/components/brand';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
/* CHAT DISABLED (2026-11-05): the dashboard is a connector for Claude only —
 * like zap-kite-mcp's. The in-app eve chat (position hub, chat history,
 * "New chat", the chart-chat screen) is commented out, not deleted; the
 * proxy, thread API and agent are untouched. Uncomment the blocks marked
 * CHAT to bring it back.
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
*/
import { BrokerModal } from './broker-modal';
import { Login } from './login';
// CHAT: import { PositionHub } from './position-hub';
import { PositionsList } from './positions-list';
import { Sidebar } from './sidebar';
import { WatchersPage } from './watchers-page';
// CHAT: import { MarketChat } from './market-chat';

/**
 * The workspace shell: login gate → (broker gate) → sidebar + main pane.
 * Main pane is the positions list (home) or the watchers page. The user
 * talks to the agent from Claude through the /markets connector, never here.
 */

/** Where to add the connector in Claude (bare host; see mcp/dhan_mcp_oauth.py). */
const MCP_URL = (process.env.NEXT_PUBLIC_MCP_URL ?? 'https://dhan-mcp-test2.slash.markets').replace(/\/$/, '');
/** Served by the OAuth MCP (mcp/dhan_mcp_oauth.py): the SKILL.md beside it, raw and zipped. */
const SKILL_ZIP_URL = `${MCP_URL}/slash-markets-dhan-account.zip`;
const SKILL_MD_URL = `${MCP_URL}/SKILL.md`;

type View =
  | { kind: 'home' }
  | { kind: 'watchers' };
/* CHAT:
  | { kind: 'hub'; position: PositionRef }
  | { kind: 'draft'; position: PositionRef }
  | { kind: 'thread'; id: string };

const STARTERS = [
  'How is this position doing right now?',
  "What's the recent trend on this instrument?",
  'What are the biggest risks to this position?',
] as const;
*/

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

  const openBrokerModal = useCallback(() => setBrokerModalOpen(true), []);

  /* CHAT: threads, thread detail, draft lifecycle, hub helpers.
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

  // Tap a row: open that position's hub (its chats + "New chat").
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

  // Holdings have no exchangeSegment/productType — map exchange → *_EQ, CNC.
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

  */

  const brokerConnected = broker?.status === 'active';
  const brokerExpired = broker?.status === 'token_expired';

  return (
    <main className="flex h-dvh overflow-hidden bg-background text-foreground">
      <Sidebar
        homeActive={view.kind === 'home'}
        onWatchers={() => setView({ kind: 'watchers' })}
        watchersActive={view.kind === 'watchers'}
        onHome={() => {
          // CHAT: setDraftSessionId(null);
          setView({ kind: 'home' });
          if (brokerConnected) void refreshPositions();
        }}
        /* CHAT:
        activeId={sidebarActiveId}
        activePositionKey={activePositionKey}
        onDelete={(id) => void removeThread(id)}
        onRename={renameThread}
        onSelect={selectThread}
        onSelectPosition={openHub}
        threads={threads}
        */
      />

      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b px-4">
          <span className="flex items-center gap-2 truncate font-medium text-sm">
            <Wordmark /> for Dhan
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
              {brokerConnected ? 'Dhan connected · auto-renews' : brokerExpired ? 'Reconnect Dhan' : 'Connect Dhan'}
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
            <span>Your Dhan connection stopped renewing — your AI assistant can’t read your account until you reconnect Dhan once.</span>
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
            <div className="flex min-h-0 flex-1 flex-col">
              <SetupCard />
              <PositionsList
                error={positionsError}
                holdings={holdings}
                loading={positionsLoading}
                // CHAT: onChat={(p) => void openPositionChat(p)}
                // CHAT: onChatHolding={(h) => void openHoldingChat(h)}
                onRefresh={() => void refreshPositions()}
                positions={positions}
              />
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-10">
              <div className="flex flex-col items-center gap-3 px-4 pt-16 pb-6 text-center">
                <h1 className="font-medium text-2xl tracking-tighter">Connect your Dhan account</h1>
                <p className="max-w-sm text-muted-foreground text-sm">
                  <Wordmark /> reads your positions from Dhan so your AI assistant can analyse
                  them. Read-only: it can never place an order.
                </p>
                <Button onClick={() => setBrokerModalOpen(true)}>Connect Dhan</Button>
              </div>
              {/* Step two is visible before step one: the skill and connector URL don't need Dhan. */}
              <SetupCard step="Next, " />
            </div>
          )
        ) : view.kind === 'watchers' ? (
          <WatchersPage /* CHAT: onOpenThread={selectThread} */ />
        ) : null}
        {/* CHAT: position hub, draft chat and resumed thread panes.
        view.kind === 'hub' ? (
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
            brokerActive={brokerConnected}
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
            onOpenBroker={openBrokerModal}
            position={view.position}
          />
        ) : detail ? (
          <MarketChat
            brokerActive={brokerConnected}
            chat={{
              history: detail.messages,
              session: { sessionId: detail.eveSessionId, streamIndex: detail.streamIndex },
              starters: STARTERS,
              onTurnSettled: () => void refreshThreads(),
            }}
            key={`thread:${detail.id}`}
            onOpenBroker={openBrokerModal}
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
        )
        */}
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
              Sign out of <Wordmark />{getUser()?.email ? ` (${getUser()?.email})` : ''}? Your Dhan
              connection and watchers stay on the server — logging back in with the same email
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

/**
 * "Connect your AI assistant": connector URL + copy, skill download, and the
 * three steps. Mirrors the setup card on slash-dhan-mcp's watchers page; this
 * connector uses OAuth, so step 2 is a sign-in rather than "auth: none".
 */
function SetupCard({ step = '' }: { readonly step?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(MCP_URL);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable — the field is selectable
    }
  };
  return (
    <section className="mx-auto w-full max-w-3xl px-4 pt-6 sm:px-6">
      <h2 className="font-medium text-lg tracking-tight">
        {step}
        {step ? 'connect' : 'Connect'} your AI assistant
      </h2>
      <p className="text-muted-foreground text-sm">
        Read-only: it can analyse your Dhan positions and set watchers, but can never trade.
      </p>
      <div className="mt-3 flex flex-col gap-4 rounded-lg border bg-card p-4">
        <div>
          <p className="mb-2 font-medium text-sm">Connector URL</p>
          <div className="flex gap-2">
            <Input className="font-mono text-[13px]" onFocus={(e) => e.currentTarget.select()} readOnly value={MCP_URL} />
            <Button onClick={() => void copy()} type="button" variant="secondary">
              {copied ? <CheckIcon className="size-4" /> : <CopyIcon className="size-4" />}
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
        </div>
        <div>
          <p className="mb-2 font-medium text-sm">Skill for the assistant</p>
          <div className="flex flex-wrap gap-2">
            <Button asChild type="button">
              <a href={SKILL_ZIP_URL}>
                <DownloadIcon className="size-4" /> Download skill (.zip)
              </a>
            </Button>
            <Button asChild type="button" variant="outline">
              <a href={SKILL_MD_URL} rel="noreferrer" target="_blank">
                <FileTextIcon className="size-4" /> View SKILL.md
              </a>
            </Button>
          </div>
        </div>
      </div>
      <ol className="mt-3 list-decimal space-y-1 pl-5 text-muted-foreground text-sm">
        <li>
          In claude.ai open Settings → Connectors → Add custom connector and paste the connector URL.
          Claude Code:{' '}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-[12px] text-foreground">
            claude mcp add --transport http markets-dhan {MCP_URL}
          </code>
        </li>
        <li>Click Connect and sign in with the same email login as this app, then approve read-only access.</li>
        <li>
          Give the assistant the skill: upload the zip in claude.ai (Settings → Capabilities → Skills), or
          unzip it into <code className="font-mono text-[12px]">.claude/skills/</code> for Claude Code.
        </li>
      </ol>
    </section>
  );
}
