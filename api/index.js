/**
 * LinkPost Bot — Hono.js + Vercel Edge + native fetch + Vercel KV
 *
 * Маршруты:
 *   POST /webhook          — приём событий от MAX
 *   GET  /setup-webhook    — регистрация webhook (вызвать вручную 1 раз)
 */

import { Hono } from 'hono'
import { handle } from 'hono/vercel'
import { sendMessage, sendMessageWithLink, sendMessageWithKeyboard, registerWebhook, markAsRead } from '../lib/max-api.js'
import {
  setLink, getLink, delLink, getAllLinks, getLinksByCreator,
  saveUser, getUserCount, reactivateUser
} from '../lib/storage.js'

export const config = { runtime: 'edge' }

const app = new Hono()

// ── Настройки ─────────────────────────────────────────────────────────────────
const ADMIN_IDS = (process.env.ADMIN_USER_IDS ?? '')
  .split(',')
  .map(s => Number(s.trim()))
  .filter(Boolean)

const BOT_NICK = process.env.BOT_NICK ?? 'YourBot'

const LOG_LEVEL = (process.env.LOG_LEVEL ?? 'INFO').toUpperCase()
const LV = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 }

function alog (level, ...args) {
  if ((LV[level] ?? 1) >= (LV[LOG_LEVEL] ?? 1)) {
    console.log(`[API] [${level}]`, ...args)
  }
}

const isAdmin = (userId) => ADMIN_IDS.includes(userId)

// ── Утилиты ───────────────────────────────────────────────────────────────────

/** Парсим аргументы: /command arg1 arg2 ...rest → ['arg1', 'arg2', ...] */
const parseArgs = (text = '') => text.trim().split(/\s+/).slice(1)

const DENY = (chatId) =>
  sendMessage(chatId, '⛔ Эта команда доступна только администратору.')

/** Отформатировать список связок */
function formatLinksList (links, showCreator = false) {
  return links.map((l, i) => {
    let line = `${i + 1}. 🔑 ${l.key}\n   🔗 ${l.url}`
    if (l.message) line += `\n   💬 ${l.message}`
    if (showCreator && l.creator_id != null) line += `\n   👤 Создатель: ID=${l.creator_id}`
    return line
  }).join('\n\n')
}

/** Построить клавиатуру с кнопками удаления для списка связок */
function buildLinksKeyboard (links) {
  const buttons = links.map(l => [
    { type: 'callback', text: `🗑 ${l.key}`, data: `del:${l.key}` }
  ])
  buttons.push([{ type: 'callback', text: '🔙 Назад', data: 'back' }])
  return buttons
}

/** Показать админское главное меню */
async function showAdminMenu (chatId) {
  const count = await getUserCount()
  alog('DEBUG', ' showAdminMenu: показано меню для чата', chatId)
  await sendMessageWithKeyboard(
    chatId,
    `👋 Привет, Админ! В базе ${count} пользователей.`,
    [
      [{ type: 'callback', text: '📋 Связки', data: 'links' },
       { type: 'callback', text: '➕ Создать', data: 'create' }],
      [{ type: 'callback', text: '👥 Пользователи', data: 'users' },
       { type: 'callback', text: '📨 Рассылка', data: 'broadcast' }]
    ]
  )
}

// ── Обработчики событий ───────────────────────────────────────────────────────

async function handleBotStarted (update) {
  const { chat_id, user, payload } = update

  // Помечаем как прочитанное
  markAsRead(chat_id).catch((e) => console.warn('[API] markAsRead failed:', e.message))

  // Сохраняем пользователя
  if (user?.user_id) {
    await saveUser({ user_id: user.user_id, name: user.name, username: user.username })
  }

  // Пришёл диплинк ?start=<key>
  if (payload) {
    const data = await getLink(payload)
    if (data) {
      if (user?.user_id) {
        await saveUser(
          { user_id: user.user_id, name: user.name, username: user.username },
          payload
        )
        await reactivateUser(user.user_id)
      }
      await sendMessageWithLink(
        chat_id,
        data.message,
        { label: '👉 Перейти в канал', url: data.url }
      )
    } else {
      await sendMessage(chat_id, '❌ Ссылка не найдена или устарела.')
    }
    return
  }

  // Обычный /start без payload
  if (isAdmin(user?.user_id)) {
    await showAdminMenu(chat_id)
  } else {
    await sendMessage(chat_id, '👋 Привет! Введи ключ, который тебе выдали, и я пришлю ссылку на канал.')
  }
}

async function handleMessage (update) {
  let { chat_id, message, user } = update
  if (!chat_id) chat_id = message?.recipient?.chat_id
  if (!user) user = message?.sender

  if (!chat_id) {
    console.warn('handleMessage: chat_id отсутствует, пропускаем')
    return
  }

  // Помечаем сообщение как прочитанное
  markAsRead(chat_id).catch((e) => console.warn('[API] markAsRead failed:', e.message))

  const text = (message?.body?.text ?? '').trim()

  if (!text) return

  // Сохраняем пользователя при каждом сообщении
  if (user?.user_id) {
    await saveUser({ user_id: user.user_id, name: user.name, username: user.username })
    await reactivateUser(user.user_id)
  }

  const userId = user?.user_id

  // ── Команды ─────────────────────────────────────────────────────────────────

  if (text.startsWith('/start')) {
    return handleBotStarted({ chat_id, user, payload: null })
  }

  if (text.startsWith('/setlink')) {
    if (!isAdmin(userId)) return DENY(chat_id)
    const [key, url, ...rest] = parseArgs(text)
    if (!key || !url || !rest.length) {
      return sendMessage(chat_id,
        '⚠️ Формат: /setlink <ключ> <url> <сообщение>\n\n' +
        'Пример:\n/setlink vip https://max.ru/channel/xxx Добро пожаловать! 🎉'
      )
    }
    let parsedUrl
    try {
      parsedUrl = new URL(url)
      if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error('bad protocol')
    } catch {
      return sendMessage(chat_id, '⚠️ URL должен быть валидным и начинаться с http:// или https://')
    }
    if (key.length > 50) {
      return sendMessage(chat_id, '⚠️ Ключ слишком длинный (максимум 50 символов).')
    }
    if (url.length > 2048) {
      return sendMessage(chat_id, '⚠️ URL слишком длинный (максимум 2048 символов).')
    }
    const msg = rest.join(' ').slice(0, 4096)
    alog('DEBUG', ' /setlink: key=%s, url=%s, creator=%d', key, url, userId)
    await setLink(key, url, msg, userId)
    alog('DEBUG', ' /setlink: saved successfully')
    return sendMessage(
      chat_id,
      '✅ Связка сохранена!\n\n' +
      `🔑 Ключ: ${key}\n` +
      `🔗 Ссылка: ${url}\n` +
      `💬 Сообщение: ${msg}\n\n` +
      `Диплинк:\nhttps://max.ru/${BOT_NICK}?start=${key}`
    )
  }

  if (text.startsWith('/dellink')) {
    const [key] = parseArgs(text)
    if (!key) return sendMessage(chat_id, '⚠️ Укажи ключ: /dellink <ключ>')
    const existing = await getLink(key)
    if (!existing) return sendMessage(chat_id, `❌ Ключ "${key}" не найден.`)
    const isAdminUser = isAdmin(userId)
    if (!isAdminUser && existing.creator_id !== userId) {
      alog('DEBUG', ' /dellink: denied, key=%s, userId=%d, creator=%d', key, userId, existing.creator_id)
      return sendMessage(chat_id, '⛔ Вы можете удалять только свои ключи.')
    }
    alog('DEBUG', ' /dellink: confirmed for key=%s, userId=%d, creator=%d', key, userId, existing.creator_id)
    return sendMessageWithKeyboard(
      chat_id,
      `🗑 Удалить связку "${key}"?\n\n🔗 ${existing.url}\n\n💬 ${existing.message}`,
      [
        [
          { type: 'callback', text: '✅ Да, удалить', data: `confirm_del:${key}` },
          { type: 'callback', text: '❌ Нет', data: 'back' }
        ]
      ]
    )
  }

  if (text.startsWith('/links')) {
    const isAdminUser = isAdmin(userId)
    const links = isAdminUser ? await getAllLinks() : await getLinksByCreator(userId)
    alog('DEBUG', ' /links: userId=%d, isAdmin=%s, found=%d links', userId, isAdminUser, links.length)
    if (!links.length) {
      return sendMessageWithKeyboard(chat_id, '📭 Нет активных связок. Добавьте первую через /setlink.', [
        [{ type: 'callback', text: '🔙 Назад', data: 'back' }]
      ])
    }
    if (isAdminUser) {
      return sendMessageWithKeyboard(
        chat_id,
        `📋 Активные связки (${links.length}):\n\n${formatLinksList(links, true)}`,
        buildLinksKeyboard(links)
      )
    }
    return sendMessage(
      chat_id,
      `📋 Ваши связки (${links.length}):\n\n${formatLinksList(links, false)}`
    )
  }

  if (text.startsWith('/users')) {
    if (!isAdmin(userId)) return DENY(chat_id)
    const count = await getUserCount()
    return sendMessage(chat_id, `👥 В базе ${count} пользователей.`)
  }

  // Игнорируем неизвестные команды
  if (text.startsWith('/')) return

  // Игнорируем всё, кроме команд, для не-админов
  if (!isAdmin(userId)) return
}

// ── Обработчик callback_query ─────────────────────────────────────────────────

async function handleCallbackQuery (update) {
  const cb = update.callback
  const chatId = update.message?.recipient?.chat_id
  if (!cb?.payload || !chatId || !cb?.user?.user_id) return

  const userId = cb.user.user_id

  if (!isAdmin(userId)) {
    return sendMessage(chatId, '⛔ Эта команда доступна только администратору.')
  }

  if (cb.payload === 'links') {
    const links = await getAllLinks()
    if (!links.length) {
      return sendMessageWithKeyboard(chatId, '📭 Нет активных связок.', [
        [{ type: 'callback', text: '🔙 Назад', data: 'back' }]
      ])
    }
    return sendMessageWithKeyboard(
      chatId,
      `📋 Активные связки (${links.length}):\n\n${formatLinksList(links, true)}`,
      buildLinksKeyboard(links)
    )
  }

  if (cb.payload === 'create') {
    return sendMessageWithKeyboard(chatId,
      '➕ Создание связки:\n\n' +
      '/setlink <ключ> <url> <сообщение>\n\n' +
      'Пример:\n/setlink vip https://max.ru/channel/xxx Добро пожаловать! 🎉',
      [[{ type: 'callback', text: '🔙 Назад', data: 'back' }]]
    )
  }

  if (cb.payload === 'users') {
    const count = await getUserCount()
    return sendMessageWithKeyboard(chatId, `👥 В базе ${count} пользователей.`, [
      [{ type: 'callback', text: '🔙 Назад', data: 'back' }]
    ])
  }

  if (cb.payload === 'broadcast') {
    return sendMessageWithKeyboard(chatId, '📨 Рассылка пока не реализована.', [
      [{ type: 'callback', text: '🔙 Назад', data: 'back' }]
    ])
  }

  if (cb.payload === 'back') {
    alog('DEBUG', ' callback: back → главное меню')
    return showAdminMenu(chatId)
  }

  if (cb.payload.startsWith('del:')) {
    const key = cb.payload.slice(4)
    const existing = await getLink(key)
    if (!existing) return sendMessage(chatId, `❌ Ключ "${key}" не найден.`)
    if (existing.creator_id !== userId) {
      alog('DEBUG', ' del: denied, key=%s, userId=%d, creator=%d', key, userId, existing.creator_id)
      return sendMessage(chatId, '⛔ Вы можете удалять только свои ключи.')
    }
    alog('DEBUG', ' del: confirmation requested for key=%s, userId=%d', key, userId)
    return sendMessageWithKeyboard(
      chatId,
      `🗑 Удалить связку "${key}"?\n\n🔗 ${existing.url}\n\n💬 ${existing.message}`,
      [
        [
          { type: 'callback', text: '✅ Да, удалить', data: `confirm_del:${key}` },
          { type: 'callback', text: '❌ Нет', data: 'links' }
        ]
      ]
    )
  }

  if (cb.payload.startsWith('confirm_del:')) {
    const key = cb.payload.slice('confirm_del:'.length)
    const existing = await getLink(key)
    if (!existing) return sendMessage(chatId, `❌ Ключ "${key}" не найден.`)
    if (existing.creator_id !== userId) {
      alog('DEBUG', ' confirm_del: denied, key=%s, userId=%d, creator=%d', key, userId, existing.creator_id)
      return sendMessage(chatId, '⛔ Вы можете удалять только свои ключи.')
    }
    alog('DEBUG', ' confirm_del: deleted key=%s by userId=%d', key, userId)
    await delLink(key)
    return sendMessageWithKeyboard(chatId, `🗑 Связка "${key}" удалена.`, [
      [{ type: 'callback', text: '🔙 Назад', data: 'back' }]
    ])
  }

  console.warn('[API] handleCallbackQuery: неизвестный payload', cb.payload)
}

// ── Rate Limiter ──────────────────────────────────────────────────────────────

const rateMap = new Map()
const RATE_WINDOW_MS = 10_000
const RATE_MAX = 60

function checkRate (key) {
  const now = Date.now()
  let entry = rateMap.get(key)
  if (!entry || now - entry.start > RATE_WINDOW_MS) {
    entry = { start: now, count: 0 }
    rateMap.set(key, entry)
  }
  entry.count++
  if (entry.count > RATE_MAX) {
    console.warn('[API] rate limit exceeded for', key)
    return false
  }
  return true
}

// ── Маршруты Hono ─────────────────────────────────────────────────────────────

/** Главный webhook — сюда шлёт MAX */
app.post('/webhook', async (c) => {
  const ct = c.req.header('content-type') || ''
  if (!ct.includes('application/json')) {
    return c.json({ error: 'Content-Type must be application/json' }, 400)
  }

  const ip = c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || 'unknown'
  if (!checkRate(ip)) {
    return c.json({ error: 'Too Many Requests' }, 429)
  }
  let update
  try {
    update = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400)
  }

  try {
    if (update.update_type === 'bot_started') {
      await handleBotStarted(update)
    } else if (update.update_type === 'message_created') {
      await handleMessage(update)
    } else if (update.update_type === 'message_callback') {
      await handleCallbackQuery(update)
    }
  } catch (err) {
    console.error('[API] Handler error:', err.message)
    // Возвращаем 200, чтобы MAX не ретраил
  }

  return c.json({ ok: true })
})

/** Регистрация webhook — вызвать вручную один раз после деплоя */
app.get('/setup-webhook', async (c) => {
  const secret = c.req.query('secret')
  if (secret !== process.env.SETUP_SECRET) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const webhookUrl = `https://${c.req.header('host')}/webhook`
  const result = await registerWebhook(webhookUrl)
  return c.json({ webhookUrl, result })
})

app.get('/', (c) => c.json({ status: 'LinkPost Bot is running 🚀' }))

/** Диагностика — проверка ключа в KV (требует SETUP_SECRET) */
app.get('/debug/:key', async (c) => {
  const secret = c.req.query('secret')
  if (secret !== process.env.SETUP_SECRET) {
    return c.json({ error: 'Forbidden' }, 403)
  }
  const key = c.req.param('key')
  const data = await getLink(key)
  const allKeys = await getAllLinks()
  return c.json({
    searchedKey: key,
    found: !!data,
    data: data ?? null,
    allKeys
  })
})

export default handle(app)
export { app, handleBotStarted, handleMessage, handleCallbackQuery }


