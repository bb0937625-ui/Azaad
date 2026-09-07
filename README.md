# 🪳 Canva Invite Bot (Telegram)

## Project Overview
- **Name**: Canva Invite Bot — @COCKROACHCANVA_bot
- **Goal**: Grow Telegram channels via a referral-points system that rewards users with Canva Pro team invites
- **Bot**: https://t.me/COCKROACHCANVA_bot
- **Channel**: @COCKROCHES12 (COCKROACH CYBER PARTY 🦗)

## How It Works
1. User starts the bot → must join required channel(s) → gets **+1 welcome point**
2. User shares their unique referral link → each friend who joins bot **and** channels = **+1 point**
3. **3 points = 1 Canva Pro invite**
4. User taps 🎁 Get Canva Invite → sends their Gmail → **admin receives a private message with the email + ✅ Invite Sent / ❌ Reject buttons**
5. Admin invites the email in Canva manually, taps ✅ → user gets notified automatically
6. ❌ Reject refunds the user's 3 points

## Features (Completed)
- ✅ Forced channel-join verification (via `getChatMember`, bot must be channel admin)
- ✅ Referral system with anti-self-referral and once-per-user counting
- ✅ Points economy: +1 welcome, +1 per referral, −3 per invite (refund on reject)
- ✅ Email collection flow with validation, cancel button, one-pending-request limit
- ✅ Admin approval workflow with inline ✅/❌ buttons and in-place message updates
- ✅ Clean-chat UI: menus edit in place (photo caption editing) instead of stacking messages
- ✅ Branded banner image (3D cockroach mascot) on all bot panels + web landing page
- ✅ Admin commands: `/pending`, `/stats`, `/setchannels`, `/addpoints`, `/broadcast`, `/admin`
- ✅ Webhook secret-token validation, always-200 responses to avoid Telegram retry storms

## Functional Entry Points
| Path | Method | Description |
|------|--------|-------------|
| `/` | GET | Branded landing page with bot link + health status |
| `/webhook` | POST | Telegram webhook (requires `X-Telegram-Bot-Api-Secret-Token` header) |
| `/static/banner.jpg` | GET | Branding banner image |

## Data Architecture
- **Storage**: Cloudflare D1 (SQLite)
- **Tables**:
  - `users` — telegram_id, points, referred_by, joined_channels, welcome/referral flags, awaiting_email state
  - `redemptions` — invite requests: email, points_spent, status (pending/done/rejected)
  - `settings` — key-value config (channels list, cached banner file_id)
- **Migrations**: `migrations/0001_initial_schema.sql`, `migrations/0002_email_redemptions.sql`

## Environment Variables (secrets — NOT in repo)
Set via `.dev.vars` locally / Cloudflare secrets in production:
- `BOT_TOKEN` — Telegram bot token from @BotFather
- `WEBHOOK_SECRET` — secret validated on the webhook endpoint
- `ADMIN_IDS` — comma-separated Telegram user IDs of admins

## Local Development
```bash
npm install
npx wrangler d1 migrations apply webapp-production --local
npm run build
pm2 start ecosystem.config.cjs      # wrangler pages dev on port 3000
# Point Telegram webhook at your public URL /webhook with the secret token
```

## Deployment
- **Platform**: Cloudflare Workers/Pages (Genspark-hosted deploy in progress)
- **Tech Stack**: Hono + TypeScript + Cloudflare D1 + Telegram Bot API
- **Status**: ✅ Running (sandbox); production deploy pending approval
- **Last Updated**: 2026-09-01

## Not Yet Implemented / Next Steps
- Point the production webhook at the permanent deployment URL and set production secrets
- Optional: second required channel, anti-fraud rate limits, leaderboard, invite-link fallback mode (`/setlink`)
