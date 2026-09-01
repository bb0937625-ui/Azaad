import { Hono } from 'hono'

type Bindings = {
  DB: D1Database
  BOT_TOKEN: string
  WEBHOOK_SECRET: string
  ADMIN_IDS: string // comma-separated telegram ids
}

const app = new Hono<{ Bindings: Bindings }>()

// ============ Telegram API helpers ============
const tg = async (token: string, method: string, payload: any) => {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
  return res.json() as Promise<any>
}

const sendMessage = (token: string, chat_id: number | string, text: string, extra: any = {}) =>
  tg(token, 'sendMessage', { chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra })

const answerCallback = (token: string, id: string, text = '', show_alert = false) =>
  tg(token, 'answerCallbackQuery', { callback_query_id: id, text, show_alert })

// ============ DB helpers ============
const getSetting = async (db: D1Database, key: string): Promise<string> => {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<{ value: string }>()
  return row?.value ?? ''
}

const setSetting = (db: D1Database, key: string, value: string) =>
  db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP')
    .bind(key, value).run()

const getChannels = async (db: D1Database): Promise<string[]> => {
  try {
    const v = JSON.parse(await getSetting(db, 'channels'))
    return Array.isArray(v) ? v : []
  } catch { return [] }
}

const getUser = (db: D1Database, id: number) =>
  db.prepare('SELECT * FROM users WHERE telegram_id = ?').bind(id).first<any>()

const upsertUser = async (db: D1Database, from: any, referredBy: number | null) => {
  const existing = await getUser(db, from.id)
  if (existing) {
    await db.prepare('UPDATE users SET username = ?, first_name = ?, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = ?')
      .bind(from.username ?? null, from.first_name ?? null, from.id).run()
    return existing
  }
  await db.prepare('INSERT INTO users (telegram_id, username, first_name, referred_by) VALUES (?, ?, ?, ?)')
    .bind(from.id, from.username ?? null, from.first_name ?? null, referredBy).run()
  return getUser(db, from.id)
}

const isAdmin = (env: Bindings, id: number) =>
  (env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean).includes(String(id))

// ============ Channel membership check ============
const checkJoinedAll = async (token: string, channels: string[], userId: number): Promise<{ ok: boolean; missing: string[] }> => {
  const missing: string[] = []
  for (const ch of channels) {
    try {
      const res = await tg(token, 'getChatMember', { chat_id: ch, user_id: userId })
      const status = res?.result?.status
      if (!res.ok || !['creator', 'administrator', 'member'].includes(status)) missing.push(ch)
    } catch {
      missing.push(ch)
    }
  }
  return { ok: missing.length === 0, missing }
}

// ============ UI builders ============
const joinKeyboard = (channels: string[]) => ({
  inline_keyboard: [
    ...channels.map((ch, i) => [{ text: `📢 Join Channel ${i + 1}`, url: `https://t.me/${ch.replace('@', '')}` }]),
    [{ text: '✅ I Joined — Check', callback_data: 'check_join' }]
  ]
})

const mainMenuKeyboard = {
  inline_keyboard: [
    [{ text: '💰 My Points', callback_data: 'my_points' }, { text: '🔗 My Referral Link', callback_data: 'ref_link' }],
    [{ text: '🎁 Redeem Canva Invite (1 point)', callback_data: 'redeem' }],
    [{ text: 'ℹ️ How It Works', callback_data: 'help' }]
  ]
}

const mainMenuText = (u: any) =>
  `🎨 <b>Canva Invite Bot</b>\n\n` +
  `👋 Hi <b>${u.first_name ?? 'there'}</b>!\n\n` +
  `💰 Your points: <b>${u.points}</b>\n` +
  `👥 Your referrals: <b>${u.total_referrals}</b>\n` +
  `🎁 Invites redeemed: <b>${u.total_redeemed}</b>\n\n` +
  `<b>1 point = 1 Canva invite</b>\n` +
  `Invite friends with your referral link to earn more points!`

// ============ Core flows ============
const sendJoinPrompt = async (env: Bindings, chatId: number, channels: string[]) => {
  await sendMessage(env.BOT_TOKEN, chatId,
    `🎨 <b>Welcome to Canva Invite Bot!</b>\n\n` +
    `To use this bot you must join our channel${channels.length > 1 ? 's' : ''}:\n\n` +
    channels.map((ch, i) => `${i + 1}. ${ch}`).join('\n') +
    `\n\nAfter joining, tap <b>✅ I Joined — Check</b>`,
    { reply_markup: joinKeyboard(channels) })
}

const notifyAdmins = async (env: Bindings, text: string) => {
  const ids = (env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean)
  for (const id of ids) {
    try { await sendMessage(env.BOT_TOKEN, id, text) } catch {}
  }
}

// Award welcome bonus + referral point after verified join
const handleVerified = async (env: Bindings, user: any, botUsername: string, chatId: number) => {
  const db = env.DB
  let bonusMsg = ''

  if (!user.joined_channels) {
    await db.prepare('UPDATE users SET joined_channels = 1, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = ?')
      .bind(user.telegram_id).run()
  }

  // Welcome bonus: +1 point once
  if (!user.welcome_bonus_given) {
    await db.prepare('UPDATE users SET points = points + 1, welcome_bonus_given = 1 WHERE telegram_id = ?')
      .bind(user.telegram_id).run()
    bonusMsg += `🎉 You received <b>+1 welcome point</b>!\n`
  }

  // Referral point: +1 to referrer once
  if (user.referred_by && !user.referral_counted) {
    await db.prepare('UPDATE users SET referral_counted = 1 WHERE telegram_id = ?').bind(user.telegram_id).run()
    await db.prepare('UPDATE users SET points = points + 1, total_referrals = total_referrals + 1 WHERE telegram_id = ?')
      .bind(user.referred_by).run()
    try {
      await sendMessage(env.BOT_TOKEN, user.referred_by,
        `🎉 <b>+1 point!</b>\nYour friend <b>${user.first_name ?? 'someone'}</b> joined via your referral link.\n\nTap /start to see your points.`)
    } catch {}
  }

  const fresh = await getUser(db, user.telegram_id)
  await sendMessage(env.BOT_TOKEN, chatId,
    `✅ <b>Verified! You joined all channels.</b>\n\n${bonusMsg}\n` + mainMenuText(fresh) +
    `\n\n🔗 Your referral link:\n<code>https://t.me/${botUsername}?start=ref_${user.telegram_id}</code>`,
    { reply_markup: mainMenuKeyboard })
}

const handleRedeem = async (env: Bindings, user: any, chatId: number, cbId: string) => {
  const db = env.DB
  const canvaLink = await getSetting(db, 'canva_link')

  if (!canvaLink) {
    await answerCallback(env.BOT_TOKEN, cbId, '⚠️ Invite link is not configured yet. Try again later.', true)
    return
  }
  if (user.points < 1) {
    await answerCallback(env.BOT_TOKEN, cbId, '❌ Not enough points! You need 1 point. Invite friends to earn points.', true)
    return
  }

  await db.prepare('UPDATE users SET points = points - 1, total_redeemed = total_redeemed + 1 WHERE telegram_id = ?')
    .bind(user.telegram_id).run()
  await db.prepare('INSERT INTO redemptions (telegram_id, points_spent, invite_link) VALUES (?, 1, ?)')
    .bind(user.telegram_id, canvaLink).run()

  await answerCallback(env.BOT_TOKEN, cbId, '🎉 Invite unlocked!')
  await sendMessage(env.BOT_TOKEN, chatId,
    `🎁 <b>Your Canva Invite</b>\n\n` +
    `Click the link below and sign in with <b>your own email</b> to join the Canva Pro team:\n\n` +
    `🔗 ${canvaLink}\n\n` +
    `✅ 1 point has been deducted.\n` +
    `💡 Invite more friends to earn more points!`)

  await notifyAdmins(env,
    `🎁 <b>Invite redeemed</b>\nUser: ${user.first_name ?? ''} (@${user.username ?? 'no_username'})\nID: <code>${user.telegram_id}</code>`)
}

// ============ Admin commands ============
const handleAdminCommand = async (env: Bindings, msg: any): Promise<boolean> => {
  const db = env.DB
  const text: string = msg.text || ''
  const chatId = msg.chat.id

  if (text.startsWith('/setlink')) {
    const link = text.replace('/setlink', '').trim()
    if (!link.startsWith('http')) {
      await sendMessage(env.BOT_TOKEN, chatId, '⚠️ Usage: <code>/setlink https://www.canva.com/brand/join?token=...</code>')
      return true
    }
    await setSetting(db, 'canva_link', link)
    await sendMessage(env.BOT_TOKEN, chatId, '✅ Canva invite link updated!')
    return true
  }

  if (text.startsWith('/setchannels')) {
    const chans = text.replace('/setchannels', '').trim().split(/\s+/).filter(s => s.startsWith('@'))
    if (!chans.length) {
      await sendMessage(env.BOT_TOKEN, chatId, '⚠️ Usage: <code>/setchannels @channel1 @channel2</code>\n\n⚠️ Bot must be admin in each channel!')
      return true
    }
    // Verify bot is admin in each channel
    const me = await tg(env.BOT_TOKEN, 'getMe', {})
    const problems: string[] = []
    for (const ch of chans) {
      const res = await tg(env.BOT_TOKEN, 'getChatMember', { chat_id: ch, user_id: me.result.id })
      if (!res.ok) problems.push(`${ch} — bot can't access (add bot as admin)`)
      else if (!['administrator', 'creator'].includes(res.result.status)) problems.push(`${ch} — bot is not admin`)
    }
    if (problems.length) {
      await sendMessage(env.BOT_TOKEN, chatId, `❌ <b>Problems found:</b>\n${problems.join('\n')}\n\nFix these and try again.`)
      return true
    }
    await setSetting(db, 'channels', JSON.stringify(chans))
    await sendMessage(env.BOT_TOKEN, chatId, `✅ Required channels updated:\n${chans.join('\n')}`)
    return true
  }

  if (text.startsWith('/stats')) {
    const s = await db.prepare(`SELECT
      (SELECT COUNT(*) FROM users) AS total_users,
      (SELECT COUNT(*) FROM users WHERE joined_channels = 1) AS verified_users,
      (SELECT COALESCE(SUM(points),0) FROM users) AS points_outstanding,
      (SELECT COUNT(*) FROM redemptions) AS total_redemptions,
      (SELECT COALESCE(SUM(total_referrals),0) FROM users) AS total_referrals`).first<any>()
    const link = await getSetting(db, 'canva_link')
    const chans = await getChannels(db)
    await sendMessage(env.BOT_TOKEN, chatId,
      `📊 <b>Bot Stats</b>\n\n` +
      `👥 Total users: <b>${s.total_users}</b>\n` +
      `✅ Verified (joined channels): <b>${s.verified_users}</b>\n` +
      `💰 Points outstanding: <b>${s.points_outstanding}</b>\n` +
      `🎁 Invites redeemed: <b>${s.total_redemptions}</b>\n` +
      `🔗 Referrals counted: <b>${s.total_referrals}</b>\n\n` +
      `📢 Channels: ${chans.length ? chans.join(', ') : '⚠️ not set'}\n` +
      `🎨 Canva link: ${link ? '✅ set' : '⚠️ not set'}`)
    return true
  }

  if (text.startsWith('/addpoints')) {
    const parts = text.trim().split(/\s+/)
    const targetId = parseInt(parts[1]), n = parseInt(parts[2])
    if (!targetId || isNaN(n)) {
      await sendMessage(env.BOT_TOKEN, chatId, '⚠️ Usage: <code>/addpoints TELEGRAM_ID AMOUNT</code>')
      return true
    }
    const r = await db.prepare('UPDATE users SET points = points + ? WHERE telegram_id = ?').bind(n, targetId).run()
    await sendMessage(env.BOT_TOKEN, chatId, r.meta.changes ? `✅ Added ${n} point(s) to <code>${targetId}</code>` : '❌ User not found')
    return true
  }

  if (text.startsWith('/broadcast')) {
    const message = text.replace('/broadcast', '').trim()
    if (!message) {
      await sendMessage(env.BOT_TOKEN, chatId, '⚠️ Usage: <code>/broadcast Your message here</code>')
      return true
    }
    const users = await db.prepare('SELECT telegram_id FROM users WHERE is_banned = 0').all<any>()
    let sent = 0, failed = 0
    for (const u of users.results ?? []) {
      try {
        const r = await sendMessage(env.BOT_TOKEN, u.telegram_id, `📢 <b>Announcement</b>\n\n${message}`)
        r.ok ? sent++ : failed++
      } catch { failed++ }
    }
    await sendMessage(env.BOT_TOKEN, chatId, `📣 Broadcast done. Sent: ${sent}, failed: ${failed}`)
    return true
  }

  if (text.startsWith('/admin')) {
    await sendMessage(env.BOT_TOKEN, chatId,
      `🛠 <b>Admin Commands</b>\n\n` +
      `<code>/setlink URL</code> — set Canva invite link\n` +
      `<code>/setchannels @ch1 @ch2</code> — set required channels\n` +
      `<code>/stats</code> — bot statistics\n` +
      `<code>/addpoints ID N</code> — add/remove points\n` +
      `<code>/broadcast MSG</code> — message all users`)
    return true
  }

  return false
}

// ============ Update handler ============
const handleUpdate = async (env: Bindings, update: any) => {
  const db = env.DB
  const token = env.BOT_TOKEN

  // --- Callback queries (button taps) ---
  if (update.callback_query) {
    const cb = update.callback_query
    const from = cb.from
    const chatId = cb.message?.chat?.id ?? from.id
    const user = await upsertUser(db, from, null)
    if (user.is_banned) { await answerCallback(token, cb.id, '🚫 You are banned.', true); return }

    const channels = await getChannels(db)
    const me = await tg(token, 'getMe', {})
    const botUsername = me.result.username

    if (cb.data === 'check_join') {
      if (!channels.length) { await answerCallback(token, cb.id, '⚠️ Bot not configured yet.', true); return }
      const check = await checkJoinedAll(token, channels, from.id)
      if (!check.ok) {
        await answerCallback(token, cb.id, `❌ You haven't joined: ${check.missing.join(', ')}`, true)
        return
      }
      await answerCallback(token, cb.id, '✅ Verified!')
      await handleVerified(env, user, botUsername, chatId)
      return
    }

    // All other actions require verified membership (re-check to catch leavers)
    if (channels.length) {
      const check = await checkJoinedAll(token, channels, from.id)
      if (!check.ok) {
        await answerCallback(token, cb.id, '❌ You left a required channel! Join again to continue.', true)
        await sendJoinPrompt(env, chatId, channels)
        return
      }
    }

    if (cb.data === 'my_points' || cb.data === 'back_menu') {
      await answerCallback(token, cb.id)
      const fresh = await getUser(db, from.id)
      await sendMessage(token, chatId, mainMenuText(fresh), { reply_markup: mainMenuKeyboard })
    } else if (cb.data === 'ref_link') {
      await answerCallback(token, cb.id)
      await sendMessage(token, chatId,
        `🔗 <b>Your Referral Link</b>\n\n` +
        `<code>https://t.me/${botUsername}?start=ref_${from.id}</code>\n\n` +
        `Share it with friends!\n` +
        `💰 When a friend joins the bot <b>and</b> all channels via your link → you get <b>+1 point</b> = 1 Canva invite! 🎨`)
    } else if (cb.data === 'redeem') {
      const fresh = await getUser(db, from.id)
      await handleRedeem(env, fresh, chatId, cb.id)
    } else if (cb.data === 'help') {
      await answerCallback(token, cb.id)
      await sendMessage(token, chatId,
        `ℹ️ <b>How It Works</b>\n\n` +
        `1️⃣ Join our channel(s) → get <b>+1 free point</b>\n` +
        `2️⃣ <b>1 point = 1 Canva Pro invite</b>\n` +
        `3️⃣ Share your referral link — each friend who joins bot + channels = <b>+1 point</b>\n` +
        `4️⃣ Tap 🎁 Redeem to get your Canva invite link\n\n` +
        `♾️ No limits — keep inviting, keep earning!`,
        { reply_markup: { inline_keyboard: [[{ text: '⬅️ Back to Menu', callback_data: 'back_menu' }]] } })
    }
    return
  }

  // --- Messages ---
  const msg = update.message
  if (!msg || !msg.text || msg.chat.type !== 'private') return
  const from = msg.from
  const chatId = msg.chat.id
  const text: string = msg.text.trim()

  // Admin commands
  if (isAdmin(env, from.id) && text.startsWith('/') && !text.startsWith('/start')) {
    const handled = await handleAdminCommand(env, msg)
    if (handled) return
  }

  // /start with optional referral payload
  if (text.startsWith('/start')) {
    let referredBy: number | null = null
    const m = text.match(/\/start\s+ref_(\d+)/)
    if (m) {
      const refId = parseInt(m[1])
      if (refId !== from.id) {
        const refUser = await getUser(db, refId)
        if (refUser) referredBy = refId
      }
    }

    const user = await upsertUser(db, from, referredBy)
    if (user.is_banned) return

    const channels = await getChannels(db)
    if (!channels.length) {
      await sendMessage(token, chatId,
        isAdmin(env, from.id)
          ? '⚠️ <b>Setup needed:</b> set required channels with <code>/setchannels @ch1 @ch2</code> and invite link with <code>/setlink URL</code>. See /admin for all commands.'
          : '⚠️ Bot is being set up. Please try again later.')
      return
    }

    const check = await checkJoinedAll(token, channels, from.id)
    if (!check.ok) {
      await sendJoinPrompt(env, chatId, channels)
      return
    }

    const me = await tg(token, 'getMe', {})
    await handleVerified(env, user, me.result.username, chatId)
    return
  }

  // Fallback for any other text
  await sendMessage(token, chatId, `Tap /start to open the menu. 🎨`)
}

// ============ Routes ============
app.post('/webhook', async (c) => {
  // Verify Telegram secret token
  const secret = c.req.header('X-Telegram-Bot-Api-Secret-Token')
  if (c.env.WEBHOOK_SECRET && secret !== c.env.WEBHOOK_SECRET) {
    return c.text('Unauthorized', 401)
  }
  const update = await c.req.json()
  try {
    await handleUpdate(c.env, update)
  } catch (e: any) {
    console.log('Error handling update:', e?.message)
  }
  return c.text('OK') // Always 200 so Telegram doesn't retry forever
})

app.get('/', async (c) => {
  return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Canva Invite Bot</title>
<script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gradient-to-br from-purple-600 to-blue-500 min-h-screen flex items-center justify-center">
<main class="bg-white rounded-2xl shadow-2xl p-10 max-w-md text-center" id="status-card">
  <h1 class="text-3xl font-bold text-gray-800 mb-4">🎨 Canva Invite Bot</h1>
  <p class="text-gray-600 mb-6">Telegram referral bot — earn points, redeem Canva Pro invites.</p>
  <a href="https://t.me/COCKROACHCANVA_bot" class="inline-block bg-blue-500 hover:bg-blue-600 text-white font-semibold px-6 py-3 rounded-xl transition" id="open-bot-link">Open Bot on Telegram →</a>
  <p class="text-green-600 mt-6 font-medium">✅ Webhook service is running</p>
</main>
</body>
</html>`)
})

export default app
