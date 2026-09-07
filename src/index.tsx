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

const INVITE_COST = 3 // points required for 1 Canva invite

// ============ Products catalog ============
type Product = { id: string; name: string; emoji: string; cost: number; deliverText: string }
const PRODUCTS: Record<string, Product> = {
  canva: {
    id: 'canva', name: 'Canva Pro Invite', emoji: '🎨', cost: 3,
    deliverText: 'Check the inbox — open the email from Canva and accept the team invite.'
  },
  aifiesta: {
    id: 'aifiesta', name: 'AI Fiesta — 1 Month', emoji: '🤖', cost: 4,
    deliverText: 'Check the inbox — your AI Fiesta 1-month access details have been sent to your email.'
  }
}

const sendMessage = (token: string, chat_id: number | string, text: string, extra: any = {}) =>
  tg(token, 'sendMessage', { chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra })

// Edit a message in place (clean chat). Handles both text messages and photo captions.
const editOrSend = async (token: string, chat_id: number | string, message_id: number | undefined, text: string, extra: any = {}, isPhoto = false) => {
  if (message_id) {
    const method = isPhoto ? 'editMessageCaption' : 'editMessageText'
    const payload: any = isPhoto
      ? { chat_id, message_id, caption: text, parse_mode: 'HTML', ...extra }
      : { chat_id, message_id, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra }
    const res = await tg(token, method, payload)
    if (res.ok || (res.description || '').includes('message is not modified')) return res
  }
  return sendMessage(token, chat_id, text, extra)
}

// Send the branded banner photo with caption + keyboard. Caches Telegram file_id after first upload.
const sendBannerMsg = async (env: Bindings, chatId: number | string, caption: string, reply_markup: any, origin: string) => {
  const cached = await getSetting(env.DB, 'banner_file_id')
  const photo = cached || `${origin}/static/banner.jpg`
  const res = await tg(env.BOT_TOKEN, 'sendPhoto', { chat_id: chatId, photo, caption, parse_mode: 'HTML', reply_markup })
  if (res.ok) {
    if (!cached) {
      const sizes = res.result?.photo
      const fileId = sizes?.[sizes.length - 1]?.file_id
      if (fileId) await setSetting(env.DB, 'banner_file_id', fileId)
    }
    return res
  }
  // Fallback to plain text if photo fails
  return sendMessage(env.BOT_TOKEN, chatId, caption, { reply_markup })
}

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
    [{ text: '🔄 Refresh', callback_data: 'my_points' }, { text: '🔗 My Referral Link', callback_data: 'ref_link' }],
    [{ text: `🎨 Canva Pro (${PRODUCTS.canva.cost} pts)`, callback_data: 'redeem_canva' }],
    [{ text: `🤖 AI Fiesta 1 Month (${PRODUCTS.aifiesta.cost} pts)`, callback_data: 'redeem_aifiesta' }],
    [{ text: 'ℹ️ How It Works', callback_data: 'help' }]
  ]
}

const EMAIL_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/

const mainMenuText = (u: any) =>
  `🎨 <b>Premium Rewards Bot</b>\n\n` +
  `👋 Hi <b>${u.first_name ?? 'there'}</b>!\n\n` +
  `💰 Your points: <b>${u.points}</b>\n` +
  `👥 Your referrals: <b>${u.total_referrals}</b>\n` +
  `🎁 Rewards claimed: <b>${u.total_redeemed}</b>\n\n` +
  `🛒 <b>Rewards Shop:</b>\n` +
  `🎨 Canva Pro Invite — <b>${PRODUCTS.canva.cost} points</b>\n` +
  `🤖 AI Fiesta 1 Month — <b>${PRODUCTS.aifiesta.cost} points</b>\n\n` +
  `Each friend who joins via your link = <b>+1 point</b>!`

const joinPromptText = (channels: string[]) =>
  `🎨 <b>Welcome to Canva Invite Bot!</b>\n\n` +
  `🆓 Get <b>Canva PRO</b> access for FREE!\n\n` +
  `To start, join our channel${channels.length > 1 ? 's' : ''}:\n\n` +
  channels.map((ch, i) => `${i + 1}️⃣ ${ch}`).join('\n') +
  `\n\nThen tap <b>✅ I Joined — Check</b>`

// ============ Core flows ============
const sendJoinPrompt = async (env: Bindings, chatId: number, channels: string[], origin: string) => {
  await sendBannerMsg(env, chatId, joinPromptText(channels), joinKeyboard(channels), origin)
}

const notifyAdmins = async (env: Bindings, text: string) => {
  const ids = (env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean)
  for (const id of ids) {
    try { await sendMessage(env.BOT_TOKEN, id, text) } catch {}
  }
}

// Award welcome bonus + referral point after verified join
const handleVerified = async (env: Bindings, user: any, botUsername: string, chatId: number, origin: string, editMsgId?: number, isPhoto = false) => {
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
      const refFresh = await getUser(db, user.referred_by)
      await sendMessage(env.BOT_TOKEN, user.referred_by,
        `🎉 <b>+1 point!</b> Your friend <b>${user.first_name ?? 'someone'}</b> joined via your link.\n💰 You now have <b>${refFresh?.points ?? '?'}</b>/${INVITE_COST} points.`)
    } catch {}
  }

  const fresh = await getUser(db, user.telegram_id)
  const text = `✅ <b>Verified!</b> ${bonusMsg}\n` + mainMenuText(fresh) +
    `\n\n🔗 Your referral link:\n<code>https://t.me/${botUsername}?start=ref_${user.telegram_id}</code>`
  if (editMsgId) {
    await editOrSend(env.BOT_TOKEN, chatId, editMsgId, text, { reply_markup: mainMenuKeyboard }, isPhoto)
  } else {
    await sendBannerMsg(env, chatId, text, mainMenuKeyboard, origin)
  }
}

// Step 1 of redeem: check points and ask for the user's email
const handleRedeem = async (env: Bindings, user: any, chatId: number, cbId: string, product: Product, editMsgId?: number, isPhoto = false) => {
  const db = env.DB

  if (user.points < product.cost) {
    await answerCallback(env.BOT_TOKEN, cbId, `❌ ${product.name} costs ${product.cost} points (you have ${user.points}). Invite ${product.cost - user.points} more friend(s)!`, true)
    return
  }

  // Prevent stacking multiple pending requests
  const pending = await db.prepare("SELECT id FROM redemptions WHERE telegram_id = ? AND status = 'pending'").bind(user.telegram_id).first<any>()
  if (pending) {
    await answerCallback(env.BOT_TOKEN, cbId, '⏳ You already have a pending request. Please wait for approval.', true)
    return
  }

  await db.prepare('UPDATE users SET awaiting_email = 1, awaiting_product = ? WHERE telegram_id = ?').bind(product.id, user.telegram_id).run()
  await answerCallback(env.BOT_TOKEN, cbId)
  await editOrSend(env.BOT_TOKEN, chatId, editMsgId,
    `${product.emoji} <b>${product.name}</b>\n\n` +
    `📧 Send me the <b>Gmail address</b> where you want to receive it.\n\n` +
    `Example: <code>yourname@gmail.com</code>\n\n` +
    `💰 Cost: <b>${product.cost} points</b> • The admin will deliver it to your email. ✅`,
    { reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'cancel_email' }]] } }, isPhoto)
}

// Step 2 of redeem: user submitted an email
const handleEmailSubmission = async (env: Bindings, user: any, chatId: number, email: string) => {
  const db = env.DB
  const product = PRODUCTS[user.awaiting_product] ?? PRODUCTS.canva

  if (user.points < product.cost) {
    await db.prepare('UPDATE users SET awaiting_email = 0, awaiting_product = NULL WHERE telegram_id = ?').bind(user.telegram_id).run()
    await sendMessage(env.BOT_TOKEN, chatId, `❌ Not enough points — ${product.name} needs ${product.cost}. Invite friends to earn more!`, { reply_markup: mainMenuKeyboard })
    return
  }

  // Deduct points + create pending redemption
  await db.prepare('UPDATE users SET points = points - ?, total_redeemed = total_redeemed + 1, awaiting_email = 0, awaiting_product = NULL WHERE telegram_id = ?')
    .bind(product.cost, user.telegram_id).run()
  const r = await db.prepare("INSERT INTO redemptions (telegram_id, points_spent, email, status, product) VALUES (?, ?, ?, 'pending', ?)")
    .bind(user.telegram_id, product.cost, email, product.id).run()
  const redemptionId = r.meta.last_row_id

  await sendMessage(env.BOT_TOKEN, chatId,
    `✅ <b>Request submitted!</b>\n\n` +
    `${product.emoji} Reward: <b>${product.name}</b>\n` +
    `📧 Email: <code>${email}</code>\n` +
    `💰 ${product.cost} points deducted.\n\n` +
    `⏳ The admin will deliver it soon. You'll get a message here when it's done!`)

  // Notify all admins with action buttons
  const ids = (env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean)
  for (const adminId of ids) {
    try {
      await sendMessage(env.BOT_TOKEN, adminId,
        `${product.emoji} <b>New ${product.name} Request #${redemptionId}</b>\n\n` +
        `👤 User: ${user.first_name ?? ''} (@${user.username ?? 'no_username'})\n` +
        `🆔 ID: <code>${user.telegram_id}</code>\n` +
        `📧 Email: <code>${email}</code>\n` +
        `💰 Cost: ${product.cost} points\n\n` +
        `👉 Deliver <b>${product.name}</b> to this email, then tap a button:`,
        { reply_markup: { inline_keyboard: [[
          { text: '✅ Delivered', callback_data: `adm_done_${redemptionId}` },
          { text: '❌ Reject (refund)', callback_data: `adm_rej_${redemptionId}` }
        ]] } })
    } catch {}
  }
}

// Admin taps ✅/❌ on a redemption request
const handleAdminDecision = async (env: Bindings, cb: any, action: 'done' | 'rej', redemptionId: number) => {
  const db = env.DB
  const token = env.BOT_TOKEN

  const red = await db.prepare('SELECT * FROM redemptions WHERE id = ?').bind(redemptionId).first<any>()
  if (!red) { await answerCallback(token, cb.id, '❌ Request not found.', true); return }
  if (red.status !== 'pending') { await answerCallback(token, cb.id, `⚠️ Already handled (${red.status}).`, true); return }

  const redProduct = PRODUCTS[red.product] ?? PRODUCTS.canva

  if (action === 'done') {
    await db.prepare("UPDATE redemptions SET status = 'done', handled_at = CURRENT_TIMESTAMP WHERE id = ?").bind(redemptionId).run()
    await answerCallback(token, cb.id, '✅ Marked as delivered!')
    try {
      await sendMessage(token, red.telegram_id,
        `🎉 <b>Your ${redProduct.name} has been delivered!</b> ${redProduct.emoji}\n\n` +
        `📧 <code>${red.email}</code> (also check Spam folder).\n` +
        `${redProduct.deliverText}\n\n` +
        `💡 Invite more friends to earn more points!`)
    } catch {}
  } else {
    // Refund the points actually spent on this request
    const refund = red.points_spent ?? redProduct.cost
    await db.prepare("UPDATE redemptions SET status = 'rejected', handled_at = CURRENT_TIMESTAMP WHERE id = ?").bind(redemptionId).run()
    await db.prepare('UPDATE users SET points = points + ?, total_redeemed = total_redeemed - 1 WHERE telegram_id = ?').bind(refund, red.telegram_id).run()
    await answerCallback(token, cb.id, `❌ Rejected, ${refund} point(s) refunded.`)
    try {
      await sendMessage(token, red.telegram_id,
        `⚠️ Your ${redProduct.name} request for <code>${red.email}</code> was rejected.\n` +
        `💰 Your <b>${refund} points</b> have been <b>refunded</b>.\n\n` +
        `Please check the email is correct and try again, or contact the admin.`)
    } catch {}
  }

  // Update the admin message to reflect the decision
  try {
    await tg(token, 'editMessageText', {
      chat_id: cb.message.chat.id,
      message_id: cb.message.message_id,
      parse_mode: 'HTML',
      text: cb.message.text.replace(/👉[^]*$/, '') +
        (action === 'done' ? `\n✅ <b>DONE</b> — ${redProduct.name} delivered to ${red.email}` : `\n❌ <b>REJECTED</b> — points refunded`)
    })
  } catch {}
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
      `🎁 Rewards redeemed: <b>${s.total_redemptions}</b>\n` +
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

  if (text.startsWith('/pending')) {
    const rows = await db.prepare("SELECT r.id, r.email, r.created_at, r.product, u.username, u.first_name, u.telegram_id FROM redemptions r JOIN users u ON u.telegram_id = r.telegram_id WHERE r.status = 'pending' ORDER BY r.id").all<any>()
    const list = rows.results ?? []
    if (!list.length) {
      await sendMessage(env.BOT_TOKEN, chatId, '✅ No pending requests!')
      return true
    }
    for (const r of list) {
      const p = PRODUCTS[r.product] ?? PRODUCTS.canva
      await sendMessage(env.BOT_TOKEN, chatId,
        `${p.emoji} <b>Request #${r.id} — ${p.name}</b>\n👤 ${r.first_name ?? ''} (@${r.username ?? 'no_username'})\n📧 <code>${r.email}</code>\n🕐 ${r.created_at}`,
        { reply_markup: { inline_keyboard: [[
          { text: '✅ Delivered', callback_data: `adm_done_${r.id}` },
          { text: '❌ Reject (refund)', callback_data: `adm_rej_${r.id}` }
        ]] } })
    }
    return true
  }

  if (text.startsWith('/admin')) {
    await sendMessage(env.BOT_TOKEN, chatId,
      `🛠 <b>Admin Commands</b>\n\n` +
      `<code>/pending</code> — list pending invite requests\n` +
      `<code>/setchannels @ch1 @ch2</code> — set required channels\n` +
      `<code>/stats</code> — bot statistics\n` +
      `<code>/addpoints ID N</code> — add/remove points\n` +
      `<code>/broadcast MSG</code> — message all users\n` +
      `<code>/setlink URL</code> — (optional) auto invite link mode`)
    return true
  }

  return false
}

// ============ Update handler ============
const handleUpdate = async (env: Bindings, update: any, origin: string) => {
  const db = env.DB
  const token = env.BOT_TOKEN

  // --- Callback queries (button taps) ---
  if (update.callback_query) {
    const cb = update.callback_query
    const from = cb.from
    const chatId = cb.message?.chat?.id ?? from.id
    const user = await upsertUser(db, from, null)
    if (user.is_banned) { await answerCallback(token, cb.id, '🚫 You are banned.', true); return }

    // Admin decision buttons (✅ done / ❌ reject)
    const admMatch = (cb.data || '').match(/^adm_(done|rej)_(\d+)$/)
    if (admMatch) {
      if (!isAdmin(env, from.id)) { await answerCallback(token, cb.id, '🚫 Admins only.', true); return }
      await handleAdminDecision(env, cb, admMatch[1] as 'done' | 'rej', parseInt(admMatch[2]))
      return
    }

    const channels = await getChannels(db)
    const me = await tg(token, 'getMe', {})
    const botUsername = me.result.username
    const msgId: number | undefined = cb.message?.message_id
    const isPhoto = Array.isArray(cb.message?.photo) && cb.message.photo.length > 0

    if (cb.data === 'check_join') {
      if (!channels.length) { await answerCallback(token, cb.id, '⚠️ Bot not configured yet.', true); return }
      const check = await checkJoinedAll(token, channels, from.id)
      if (!check.ok) {
        await answerCallback(token, cb.id, `❌ You haven't joined: ${check.missing.join(', ')}`, true)
        return
      }
      await answerCallback(token, cb.id, '✅ Verified!')
      await handleVerified(env, user, botUsername, chatId, origin, msgId, isPhoto)
      return
    }

    if (cb.data === 'cancel_email') {
      await db.prepare('UPDATE users SET awaiting_email = 0 WHERE telegram_id = ?').bind(from.id).run()
      await answerCallback(token, cb.id, '❌ Cancelled. No points used.')
      await db.prepare('UPDATE users SET awaiting_product = NULL WHERE telegram_id = ?').bind(from.id).run()
      const fresh = await getUser(db, from.id)
      await editOrSend(token, chatId, msgId, mainMenuText(fresh), { reply_markup: mainMenuKeyboard }, isPhoto)
      return
    }

    // All other actions require verified membership (re-check to catch leavers)
    if (channels.length) {
      const check = await checkJoinedAll(token, channels, from.id)
      if (!check.ok) {
        await answerCallback(token, cb.id, '❌ You left a required channel! Join again to continue.', true)
        await editOrSend(token, chatId, msgId, joinPromptText(channels), { reply_markup: joinKeyboard(channels) }, isPhoto)
        return
      }
    }

    if (cb.data === 'my_points' || cb.data === 'back_menu') {
      await answerCallback(token, cb.id, '🔄 Updated!')
      const fresh = await getUser(db, from.id)
      await editOrSend(token, chatId, msgId, mainMenuText(fresh), { reply_markup: mainMenuKeyboard }, isPhoto)
    } else if (cb.data === 'ref_link') {
      await answerCallback(token, cb.id)
      await editOrSend(token, chatId, msgId,
        `🔗 <b>Your Referral Link</b>\n\n` +
        `<code>https://t.me/${botUsername}?start=ref_${from.id}</code>\n\n` +
        `👆 Tap the link to copy it, then share with friends!\n\n` +
        `💰 Each friend who joins the bot <b>and</b> all channels = <b>+1 point</b>\n` +
        `🎨 ${PRODUCTS.canva.cost} pts = Canva Pro • 🤖 ${PRODUCTS.aifiesta.cost} pts = AI Fiesta 1 Month!`,
        { reply_markup: { inline_keyboard: [[{ text: '⬅️ Back to Menu', callback_data: 'back_menu' }]] } }, isPhoto)
    } else if (cb.data === 'redeem_canva' || cb.data === 'redeem_aifiesta' || cb.data === 'redeem') {
      const product = cb.data === 'redeem_aifiesta' ? PRODUCTS.aifiesta : PRODUCTS.canva
      const fresh = await getUser(db, from.id)
      await handleRedeem(env, fresh, chatId, cb.id, product, msgId, isPhoto)
    } else if (cb.data === 'help') {
      await answerCallback(token, cb.id)
      await editOrSend(token, chatId, msgId,
        `ℹ️ <b>How It Works</b>\n\n` +
        `1️⃣ Join our channel(s) → get <b>+1 free point</b>\n` +
        `2️⃣ Share your referral link — each friend who joins bot + channels = <b>+1 point</b>\n` +
        `3️⃣ Spend points in the 🛒 Rewards Shop:\n` +
        `   🎨 Canva Pro Invite — ${PRODUCTS.canva.cost} pts\n` +
        `   🤖 AI Fiesta 1 Month — ${PRODUCTS.aifiesta.cost} pts\n` +
        `4️⃣ Send your Gmail → reward arrives in your email 📧\n\n` +
        `♾️ No limits — keep inviting, keep earning!`,
        { reply_markup: { inline_keyboard: [[{ text: '⬅️ Back to Menu', callback_data: 'back_menu' }]] } }, isPhoto)
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
  if (isAdmin(env, from.id) && text.startsWith('/') && !text.startsWith('/start') && !text.startsWith('/cancel')) {
    const handled = await handleAdminCommand(env, msg)
    if (handled) return
  }

  // User is in "send me your email" state
  const existingUser = await getUser(db, from.id)
  if (existingUser?.awaiting_email) {
    if (text.startsWith('/cancel')) {
      await db.prepare('UPDATE users SET awaiting_email = 0 WHERE telegram_id = ?').bind(from.id).run()
      await sendMessage(token, chatId, '❌ Cancelled. No points used.\n\n' + mainMenuText(existingUser), { reply_markup: mainMenuKeyboard })
      return
    }
    if (!text.startsWith('/')) {
      const email = text.toLowerCase()
      if (!EMAIL_RE.test(email)) {
        await sendMessage(token, chatId, '⚠️ That doesn\'t look like a valid email. Please send a valid address like <code>yourname@gmail.com</code>, or /cancel.')
        return
      }
      await handleEmailSubmission(env, existingUser, chatId, email)
      return
    }
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
      await sendJoinPrompt(env, chatId, channels, origin)
      return
    }

    const me = await tg(token, 'getMe', {})
    await handleVerified(env, user, me.result.username, chatId, origin)
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
  const origin = new URL(c.req.url).origin
  try {
    await handleUpdate(c.env, update, origin)
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
<body class="bg-gradient-to-br from-purple-900 via-purple-700 to-amber-500 min-h-screen flex items-center justify-center p-4">
<main class="bg-white/95 backdrop-blur rounded-3xl shadow-2xl overflow-hidden max-w-lg text-center" id="status-card">
  <img src="/static/banner.jpg" alt="Canva PRO Free Access — Cockroach mascot banner" class="w-full" id="brand-banner">
  <section class="p-8" id="hero-section">
    <h1 class="text-3xl font-extrabold text-gray-800 mb-3">🎨 Canva Invite Bot</h1>
    <p class="text-gray-600 mb-6">Earn points by inviting friends → redeem <span class="font-bold text-purple-700">Canva PRO</span> invites!</p>
    <a href="https://t.me/COCKROACHCANVA_bot" class="inline-block bg-gradient-to-r from-purple-600 to-amber-500 hover:from-purple-700 hover:to-amber-600 text-white font-bold px-8 py-3 rounded-xl transition shadow-lg" id="open-bot-link">Open Bot on Telegram →</a>
    <p class="text-green-600 mt-6 font-medium">✅ Webhook service is running</p>
  </section>
</main>
</body>
</html>`)
})

export default app
