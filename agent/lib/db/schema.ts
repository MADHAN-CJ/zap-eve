import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import type { Cost, MessagePart, Role, Usage } from './types';
import type {
  WatchCondition,
  WatchKind,
  WatchLatched,
  WatchMode,
  WatchStatus,
  WatchValues,
  WatchVerdict,
} from '../watch/types';

/**
 * Zap-on-eve schema. threads/messages are written by the persist hook + the
 * eve proxy — they are the system of record for DISPLAYING conversations;
 * eve's workflow store remains the system of record for CONTINUING them.
 */

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const otps = pgTable(
  'otps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    /** HMAC-SHA256(code:email, CREDS_HASH_PEPPER) — raw codes are never stored. */
    codeHash: text('code_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('otps_email_idx').on(t.email)],
);

/**
 * The user's Dhan connection. v1 credential = pasted access token (24h life):
 * `credentialEnc` is AES-256-GCM ciphertext of a JSON blob
 * `{ type: 'access_token', accessToken }`. A Dhan 401 marks the row
 * `token_expired` (NEVER surfaced as a Zap 401 — the app's 401 means "log in
 * again"); reconnecting overwrites the credential and restores `active`.
 */
export const brokerConnections = pgTable('broker_connections', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: 'cascade' }),
  dhanClientId: text('dhan_client_id').notNull(),
  credentialEnc: text('credential_enc').notNull(),
  status: text('status').$type<'active' | 'token_expired' | 'disconnected'>().notNull().default('active'),
  connectedAt: timestamp('connected_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Which user (and which position) an eve session belongs to. WRITTEN only by
 * the eve proxy (before forwarding each send); READ by the per-tool context
 * (`sessionContext` in agent/lib/dhan/context.ts) and the persist hook's
 * owner backfill. This is how tools resolve Dhan credentials WITHOUT any
 * secret ever entering the model context.
 */
export const sessionContext = pgTable('session_context', {
  eveSessionId: text('eve_session_id').primaryKey(),
  userId: uuid('user_id').notNull(),
  /** The position this chat is about (Dhan identity). */
  securityId: text('security_id').notNull(),
  exchangeSegment: text('exchange_segment').notNull(),
  productType: text('product_type').notNull(),
  symbol: text('symbol').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const threads = pgTable(
  'threads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eveSessionId: text('eve_session_id').notNull().unique(),
    /**
     * Owning user. Nullable ONLY during the first turn: the persist hook may
     * create the thread before the proxy has stored the session context; the
     * hook backfills it from session_context as soon as the row exists.
     * Rows with a null owner are never listed.
     */
    userId: uuid('user_id'),
    /** Position identity — every thread belongs to one position. */
    securityId: text('security_id'),
    exchangeSegment: text('exchange_segment'),
    productType: text('product_type'),
    symbol: text('symbol'),
    /** Latest eve resume handle; rotates every turn (stored on session.waiting). */
    continuationToken: text('continuation_token'),
    /**
     * Set on turn.started, cleared when the turn/session ends — "a turn is in
     * flight". The watch fire path defers rather than sending into an active
     * turn (eve 0.22 has no turn queue: concurrent sends interleave
     * nondeterministically). Treat a stale value (>10 min) as idle.
     */
    busySince: timestamp('busy_since', { withTimezone: true }),
    /** Resume cursor for useEveAgent (count of mirrored stream events). */
    streamIndex: integer('stream_index').notNull().default(0),
    /** First user message (kickoff stripped, 40 chars) until the user renames it. */
    title: text('title'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /** Soft delete — the list and the proxy treat these rows as gone. */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    index('threads_user_idx').on(t.userId),
    /** Threads are listed grouped by position; many threads per position. */
    index('threads_user_position_idx').on(t.userId, t.securityId, t.exchangeSegment, t.productType),
  ],
);

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    threadId: uuid('thread_id')
      .notNull()
      .references(() => threads.id, { onDelete: 'cascade' }),
    turnSequence: integer('turn_sequence').notNull(),
    role: text('role').$type<Role>().notNull(),
    /** Final text (assistant: concatenated text blocks of the turn). */
    content: text('content').notNull().default(''),
    /** Ordered tool activity for the turn; mirrors the UI's MessagePart shape. */
    parts: jsonb('parts').$type<MessagePart[]>().notNull().default([]),
    usage: jsonb('usage').$type<Usage>(),
    /** Computed server-side from usage × price table; null when model unpriced. */
    cost: jsonb('cost').$type<Cost>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('messages_thread_created_idx').on(t.threadId, t.createdAt),
    /**
     * One assistant row per turn — upserted as the turn's fragments stream in,
     * so a crash mid-turn loses at most the unflushed fragment. User rows are
     * exempt: eve may fold multiple queued deliveries into one turn.
     */
    uniqueIndex('messages_assistant_turn_uidx')
      .on(t.threadId, t.turnSequence)
      .where(sql`${t.role} = 'assistant'`),
  ],
);

/**
 * Market watches (docs/plan-watcher.md). Owned by the sweeper: chat never
 * implicitly mutates a row (W10) — only the create/cancel/pause tools, the
 * dashboard actions, and the sweep itself write here. A `levels` watch fires
 * when its numeric conditions trip (edge-triggered via `latched`); an
 * `ai_check` watch fires on its cadence clock. Firing continues the watch's
 * thread; email goes out only when the AI confirms the ask is met.
 */
export const watches = pgTable(
  'watches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    threadId: uuid('thread_id')
      .notNull()
      .references(() => threads.id, { onDelete: 'cascade' }),
    eveSessionId: text('eve_session_id').notNull(),
    /** Instrument identity — always the thread's position (W12). */
    securityId: text('security_id').notNull(),
    exchangeSegment: text('exchange_segment').notNull(),
    symbol: text('symbol').notNull(),
    /** Candle interval the conditions are evaluated on ('1min'…'1day'). */
    interval: text('interval').notNull(),
    /** The user's original ask, verbatim — replayed to the AI on every fire. */
    instruction: text('instruction').notNull(),
    kind: text('kind').$type<WatchKind>().notNull().default('levels'),
    /** Numeric conditions (levels watches); null for ai_check. */
    conditions: jsonb('conditions').$type<WatchCondition[]>(),
    mode: text('mode').$type<WatchMode>().notNull().default('any'),
    /** ai_check only: minutes between AI evaluations (15–120). */
    checkIntervalMinutes: integer('check_interval_minutes'),
    /** ai_check repeat-alert latch — email only on not_met → met. */
    lastVerdict: text('last_verdict').$type<WatchVerdict>(),
    status: text('status').$type<WatchStatus>().notNull().default('ARMED'),
    /** Metric values at the last sweep (crossing baseline). */
    lastValues: jsonb('last_values').$type<WatchValues>(),
    /** Edge-trigger state — see WatchLatched. */
    latched: jsonb('latched').$type<WatchLatched>(),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    lastFiredAt: timestamp('last_fired_at', { withTimezone: true }),
    lastAlertAt: timestamp('last_alert_at', { withTimezone: true }),
    /** Atomic fire claim — set while a triggered run is in flight (R4-style). */
    firingAt: timestamp('firing_at', { withTimezone: true }),
    errorMessage: text('error_message'),
    /** Hard stop (W8): created + 10 days → EXPIRED, no email. */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('watches_status_idx').on(t.status),
    index('watches_thread_idx').on(t.threadId),
    /** Cap check (W8): count ARMED per user cheaply. */
    index('watches_user_armed_idx').on(t.userId).where(sql`${t.status} = 'ARMED'`),
  ],
);

export type UserRow = typeof users.$inferSelect;
export type BrokerConnectionRow = typeof brokerConnections.$inferSelect;
export type SessionContextRow = typeof sessionContext.$inferSelect;
export type ThreadRow = typeof threads.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type WatchRow = typeof watches.$inferSelect;
