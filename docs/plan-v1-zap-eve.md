# Plan v1 — Zap on eve: read-only Dhan position chatbot

> Single repo, trophy-chassis style (Next 16 + `withEve()` + `agent/` + Drizzle
> Postgres). Copied from `forward/trophy` 2026-08-21 and retargeted. The user's
> playbook applies: phase-by-phase with Verify, no commits by Claude, stop on
> ambiguity.

## Product

Login (email OTP → JWT) → connect Dhan (access token) → positions list → tap a
position → chat with a read-only analyst agent about it → history resumes per
position. **Zero write tools** — the agent can never trade. Never auto-disable
chats (D4).

## Decisions (see memory `zap-eve-project.md` for D1–D8)

| # | Decision |
|---|---|
| R1 | Identity = Zap user (email OTP → 7d JWT via `jose`); `threads.user_id` replaces trophy's ownerKeyHash. |
| R2 | Dhan credential v1 = **access_token paste** (24h): encrypted AES-256-GCM in `broker_connections`; Dhan 401 → status `token_expired` → UI reconnect banner. NEVER a Zap 401 (§10 zap rule). TOTP/consent later. |
| R3 | Thread = one per (userId, securityId, exchangeSegment, productType). Proxy accepts `{message, position}` on create, strips `position` upstream, stores it in `session_context`, prepends a kickoff context block to the first message. |
| R4 | Tools resolve creds sessionId → session_context.userId → broker_connections; decrypt-fail = fail closed (trophy tri-state). Env `DHAN_ACCESS_TOKEN`/`DHAN_CLIENT_ID` = local bench fallback only. |
| R5 | 11 eager read-only tools; no approval gating, no toolsearch. Dhan `client-id` header on every call (live-learned). Option-chain throttle 1 req/3s. |
| R6 | Underlying resolution: index options via verified map (NIFTY=13, BANKNIFTY=25 on IDX_I); stock options → graceful tool error in v1 (no instrument master). |
| R7 | No egress/static-IP anything — Dhan setIP is order-placement-only; reads are unrestricted. |
| R8 | Postgres schema `public`, own DB (`zap_eve`), docker :5438 local / Neon prod. |

## Phases

- [x] **P0 Scaffold** *(2026-08-21)* — copy trophy minus artifacts; strip backend/frontend/docs/embed/shape-scripts; git init. Verified: tree clean.
- [x] **P1 Strip Trophy domain** *(2026-08-21)* — trophy lib + 63 generated tools deleted (4 `disableTool` sentinels kept), defer middleware gone with the lib; package renamed `zap-eve-agent`, @trophyso/node + @vercel/connect dropped, jose added.
- [x] **P2 DB layer** *(2026-08-21)* — schema (users, otps, broker_connections, session_context, threads+position, messages), crypto (encryptSecret/otpHash), session-context + broker stores, mirror backfill from session_context, pricing → sonnet-5. **Verified:** migration `0000_bent_blackheart` applied to docker pg :5438; `db:smoke` passes (encrypted round-trip, cascade cleanup).
- [x] **P3 Dhan lib + tools** *(2026-08-21)* — fetch-based read-only client (client-id header, option-chain 3s throttle, column→candle zip), context (fail-closed tri-state, token-expiry marking), underlying (NIFTY=13/BANKNIFTY=25, stock-FNO graceful error), 11 specs + builder + tool files; agent.ts (claude-sonnet-5, 1M); instructions.md. **Verified:** `/eve/v1/info` lists all 11 authored + 4 disabled; typecheck clean.
- [x] **P4 API routes** *(2026-08-21)* — auth, broker (connect validates via REAL Dhan round-trip), threads (+by-position lookup), eve proxy (JWT, x-zap-position header, kickoff injection, token injection, fork detect, CHAT_EXISTS 409). **Verified curl matrix:** bare→401, test-OTP→JWT, wrong OTP→401, status none, positions→409 BROKER_NOT_CONNECTED, junk Dhan token→400 (live api.dhan.co rejection), create-no-position→400, create→session+owned thread (title RELIANCE, kickoff in stream), duplicate→409 CHAT_EXISTS w/ resume payload, stream passthrough OK.
- [x] **P5 Frontend** *(2026-08-21)* — Login (2-step OTP), BrokerModal (connect/renew/disconnect), PositionsList (P&L cards), Workspace (login→broker gate→home/chat views, expiry banner, draft adoption), Sidebar (position chats), ThreadChat (position header + Zap copy), Zap green theme. **Verified:** typecheck + `next build` clean (all 9 routes), `build:eve` clean (Node 24). Browser walkthrough = P7.
- [x] **P6 Docs/env** *(2026-08-21)* — README, .env.example, `.env` seeded w/ fresh secrets (ANTHROPIC_API_KEY left blank), docker-compose (:5438, `zap-eve-copilot`), deploy scripts → projects `zap-eve-agent`/`zap-eve-agent-runtime`. Deploy itself NOT run.
- [ ] **P7 Live smoke** — set ANTHROPIC_API_KEY, real Dhan token: browser walkthrough + one position chat end-to-end (first agent turn, tool calls against live Dhan, history resume). **Needs user** (key + Dhan token).

## Env vars

`DATABASE_URL`, `ANTHROPIC_API_KEY`, `AUTH_JWT_SECRET`, `CREDS_ENCRYPTION_KEY`,
`CREDS_HASH_PEPPER` (OTP hashing), `EVE_PROXY_SECRET`, `EVE_UPSTREAM_ORIGIN`
(prod web→runtime), `RESEND_API_KEY` (+`OTP_FROM_EMAIL`; unset → OTP logged to
server console, dev only), `DHAN_ACCESS_TOKEN`/`DHAN_CLIENT_ID` (bench only).
Test login: `test@zaptrade.app` / OTP `123456` (matches zap-api convention).

## Decision log

- 2026-08-21 — repo created from forward/trophy copy; plan written.
