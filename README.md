# zap-eve-agent — Zap on eve

A **read-only chatbot for your Dhan positions**. Log in with email OTP,
connect your Dhan account once, tap a position, and chat with an AI analyst
about it — live P&L, candles, option chains (NIFTY/BANKNIFTY), funds, orders.
The agent has **zero write tools**: it can never place, modify, or cancel an
order.

One repo, trophy-chassis architecture (ported from `forward/trophy`):

- **Next.js 16 app** — login, Dhan connect, positions list, chat UI
  (`useEveAgent` from `eve/react`), chat history. All model traffic goes
  through the app-owned proxy at `app/api/eve/v1/[...path]/route.ts`, which
  owns thread ownership and continuation tokens.
- **eve agent** (`agent/`) — [eve](https://eve.dev) durable agent on
  `claude-sonnet-5`; 11 read-only Dhan tools in `agent/tools/`, specs in
  `agent/lib/dhan/`. Per-session credentials resolve server-side via
  `session_context` — no secret ever enters the model context.
- **Postgres (Drizzle)** — users, OTPs, encrypted Dhan credentials, threads
  (one live chat per position), messages. Mirrored from the eve stream by
  `agent/hooks/persist.ts`; eve's workflow store remains the system of record
  for *continuing* sessions.

## Develop

```bash
nvm use 24                    # eve requires Node >= 24
docker compose up -d          # Postgres on :5438
cp .env.example .env          # fill in secrets (openssl rand -hex 32) + ANTHROPIC_API_KEY
npm install
npm run db:migrate            # drizzle migrations
npm run dev                   # Next + eve on :3000 (withEve)
```

Login with `test@zaptrade.app` / OTP `123456`, or any email (codes print to
the server console until `RESEND_API_KEY` is set). Connect Dhan with your
client ID + a fresh access token (24h life; the app shows a reconnect banner
when it expires).

## Deploy (two Vercel projects, one repo)

- `scripts/deploy-runtime.sh` → **zap-eve-agent-runtime** (`eve build`; needs
  ANTHROPIC_API_KEY, DATABASE_URL, CREDS_*, EVE_PROXY_SECRET)
- `scripts/deploy-web.sh` → **zap-eve-agent** (Next; same env +
  `EVE_UPSTREAM_ORIGIN` pointing at the runtime)

See `docs/plan-v1-zap-eve.md` for decisions, phases, and verification status.
