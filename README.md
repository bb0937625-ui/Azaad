# 🪳 Premium Rewards Bot (Telegram)

## Project Overview
- **Name**: Premium Rewards Bot — @COCKROACHCANVA_bot
- **Goal**: Grow Telegram channels via a referral-points system that rewards users with premium product access (Canva Pro, AI Fiesta)
- **Bot**: https://t.me/COCKROACHCANVA_bot
- **Channel**: @COCKROCHES12 (COCKROACH CYBER PARTY 🦗)

## 🛒 Rewards Shop
| Reward | Cost |
|--------|------|
| 🎨 Canva Pro Invite | 3 points |
| 🤖 AI Fiesta — 1 Month | 4 points |
| 🧠 GPT Plus — 12 Months | 6 points |

## How It Works
1. User starts the bot → must join required channel(s) → gets **+1 welcome point**
2. User shares their unique referral link → each friend who joins bot **and** channels = **+1 point**
3. User picks a reward from the shop → sends their Gmail → **admin receives a private message with the email + ✅ Delivered / ❌ Reject buttons**
4. Admin delivers the reward to the email manually, taps ✅ → user gets notified automatically
5. ❌ Reject refunds the full points spent on that request

## Features (Completed)
- ✅ Forced channel-join verification (via `getChatMember`, bot must be channel admin)
- ✅ Referral system with anti-self-referral and once-per-user counting
- ✅ Points economy: +1 welcome, +1 per referral; per-product costs with accurate refunds on reject
- ✅ Multi-product rewards shop (Canva Pro 3 pts, AI Fiesta 4 pts, GPT Plus 12-month 6 pts) — easily extensible catalog
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
  - `redemptions` — reward requests: product, email, points_spent, status (pending/done/rejected)
  - `settings` — key-value config (channels list, cached banner file_id)
- **Migrations**: `migrations/0001_initial_schema.sql`, `0002_email_redemptions.sql`, `0003_products.sql`

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
