import { getSessionContext, type PositionIdentity } from '../db/session-context';
import { getActiveBrokerCreds, markTokenExpired } from '../db/broker';
import type { DhanCreds } from './client';

/**
 * Per-tool-call credential + position resolution via ctx.session.id →
 * session_context → the owner's ACTIVE Dhan credential. The env credential
 * (DHAN_* vars) applies only to direct eve sends with no proxy in front.
 *
 * Fail-closed: any lookup/decrypt FAILURE resolves to null — never degrade
 * to the env account when the session may belong to a user.
 */

export interface DhanToolContext {
  creds: DhanCreds;
  position: PositionIdentity;
  /** Set when resolved via the proxy (used to flag token expiry on the row). */
  userId?: string;
}

export type ToolContextResult =
  | { status: 'ok'; ctx: DhanToolContext }
  | { status: 'unavailable'; message: string };

/**
 * Shape of the eve tool-execution context we rely on. Subagent (child)
 * sessions carry a `parent` with a direct `rootSessionId` pointer (shape
 * verified live 2026-09-04 via scripts/bench-session-shape.ts) — ownership
 * rows (session_context) exist only for ROOT sessions, so all lookups go
 * through rootSessionId().
 */
export interface EveToolCtx {
  session?: {
    id?: string;
    parent?: { rootSessionId?: string; sessionId?: string };
  };
}

/** The root session id for this tool call (own id when not a subagent). */
export function rootSessionId(toolCtx: EveToolCtx | undefined): string | undefined {
  const s = toolCtx?.session;
  return s?.parent?.rootSessionId ?? s?.parent?.sessionId ?? s?.id;
}

function envContext(): DhanToolContext | null {
  const accessToken = process.env.DHAN_ACCESS_TOKEN;
  const dhanClientId = process.env.DHAN_CLIENT_ID;
  if (!accessToken || !dhanClientId) return null;
  return {
    creds: { accessToken, dhanClientId },
    position: {
      securityId: process.env.DHAN_BENCH_SECURITY_ID || '2885',
      exchangeSegment: process.env.DHAN_BENCH_EXCHANGE_SEGMENT || 'NSE_EQ',
      productType: process.env.DHAN_BENCH_PRODUCT_TYPE || 'INTRADAY',
      symbol: process.env.DHAN_BENCH_SYMBOL || 'RELIANCE',
    },
  };
}

const UNAVAILABLE = {
  lookup_failed:
    'Credential lookup failed — this turn cannot access Dhan. Ask the user to retry shortly.',
  not_connected:
    'No Dhan account is connected. Ask the user to connect their Dhan account from the broker screen.',
  token_expired:
    'The Dhan access token has expired (Dhan tokens last 24h). Ask the user to reconnect Dhan from the broker screen.',
  disconnected:
    'The Dhan account was disconnected. Ask the user to reconnect Dhan from the broker screen.',
} as const;

export async function toolContext(toolCtx: EveToolCtx | undefined): Promise<ToolContextResult> {
  const sessionId = rootSessionId(toolCtx);
  if (!sessionId) {
    const env = envContext();
    return env
      ? { status: 'ok', ctx: env }
      : { status: 'unavailable', message: UNAVAILABLE.not_connected };
  }
  const found = await getSessionContext(sessionId);
  if (found.status === 'error') return { status: 'unavailable', message: UNAVAILABLE.lookup_failed };
  if (found.status === 'none') {
    const env = envContext();
    return env
      ? { status: 'ok', ctx: env }
      : { status: 'unavailable', message: UNAVAILABLE.not_connected };
  }
  const creds = await getActiveBrokerCreds(found.owner.userId);
  if (creds.status === 'error') return { status: 'unavailable', message: UNAVAILABLE.lookup_failed };
  if (creds.status === 'none') return { status: 'unavailable', message: UNAVAILABLE[creds.reason] };
  return {
    status: 'ok',
    ctx: { creds: creds.creds, position: found.owner.position, userId: found.owner.userId },
  };
}

/**
 * A Dhan 401 during a tool call means the 24h token died mid-session: mark the
 * connection token_expired (drives the UI's reconnect banner) — NEVER surface
 * it as a Zap auth failure.
 */
export async function noteDhanAuthFailure(ctx: DhanToolContext): Promise<void> {
  if (!ctx.userId) return;
  try {
    await markTokenExpired(ctx.userId);
  } catch (e) {
    console.error('[dhan] could not mark token expired:', e instanceof Error ? e.message : e);
  }
}
