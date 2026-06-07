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
  setLink, getLink, delLink, getAllLinks,
  saveUser, getUserCount, reactivateUser
} from '../lib/storage.js'

export const config = { runtime: 'edge' }

const app = new Hono()

// ── Подгружаем .env.local для локального запуска (Vercel Edge подставляет сам) ─
try {
  const { config: dotenvConfig } = await import('dotenv')
  dotenvConfig({ path: '.env.local' })
} catch {}

// ── Настройки ─────────────────────────────────────────────────────────────────
const ADMIN_IDS = (process.env.ADMIN_USER_IDS ?? '')
  .split(',')
  .map(s => Number(s.trim()))
  .filter(Boolean)

const BOT_NICK = process.env.BOT_NICK ?? 'YourBot'

const isAdmin = (userId) => ADMIN_IDS.includes(userId)

// ── Утилиты ───────────────────────────────────────────────────────────────────

/** Парсим аргументы: /command arg1 arg2 ...rest → ['arg1', 'arg2', ...] */
const parseArgs = (text = '') => text.trim().split(/\s+/).slice(1)

const DENY = (chatId) =>
  sendMessage(chatId, '⛔ Эта команда доступна только администратору.')

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
    const count = await getUserCount()
    await sendMessageWithKeyboard(
      chat_id,
      `👋 Привет, Админ! В базе ${count} пользователей.`,
      [
        [{ type: 'callback', text: '📋 Связки', data: 'links' },
         { type: 'callback', text: '➕ Создать', data: 'create' }],
        [{ type: 'callback', text: '👥 Пользователи', data: 'users' },
         { type: 'callback', text: '📨 Рассылка', data: 'broadcast' }]
      ]
    )
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
    if (!/^https?:\/\/.+/.test(url)) {
      return sendMessage(chat_id, '⚠️ URL должен начинаться с http:// или https://')
    }
    if (key.length > 50) {
      return sendMessage(chat_id, '⚠️ Ключ слишком длинный (максимум 50 символов).')
    }
    if (url.length > 2048) {
      return sendMessage(chat_id, '⚠️ URL слишком длинный (максимум 2048 символов).')
    }
    const msg = rest.join(' ').slice(0, 4096)
    await setLink(key, url, msg)
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
    if (!isAdmin(userId)) return DENY(chat_id)
    const [key] = parseArgs(text)
    if (!key) return sendMessage(chat_id, '⚠️ Укажи ключ: /dellink <ключ>')
    const existing = await getLink(key)
    if (!existing) return sendMessage(chat_id, `❌ Ключ "${key}" не найден.`)
    await delLink(key)
    return sendMessage(chat_id, `🗑 Связка "${key}" удалена.`)
  }

  if (text.startsWith('/links')) {
    if (!isAdmin(userId)) return DENY(chat_id)
    const links = await getAllLinks()
    if (!links.length) {
      return sendMessage(chat_id, '📭 Нет активных связок. Добавьте первую через /setlink.')
    }
    const list = links.map((l, i) =>
      `${i + 1}. 🔑 ${l.key}\n   🔗 ${l.url}\n   💬 ${l.message}`
    ).join('\n\n')
    const buttons = links.map(l => [
      { type: 'callback', text: `🗑 ${l.key}`, data: `del:${l.key}` }
    ])
    return sendMessageWithKeyboard(
      chat_id,
      `📋 Активные связки (${links.length}):\n\n${list}`,
      buttons
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
      return sendMessage(chatId, '📭 Нет активных связок.')
    }
    const list = links.map((l, i) =>
      `${i + 1}. 🔑 ${l.key}\n   🔗 ${l.url}`
    ).join('\n\n')
    return sendMessage(chatId, `📋 Активные связки (${links.length}):\n\n${list}`)
  }

  if (cb.payload === 'create') {
    return sendMessage(chatId,
      '➕ Создание связки:\n\n' +
      '/setlink <ключ> <url> <сообщение>\n\n' +
      'Пример:\n/setlink vip https://max.ru/channel/xxx Добро пожаловать! 🎉'
    )
  }

  if (cb.payload === 'users') {
    const count = await getUserCount()
    return sendMessage(chatId, `👥 В базе ${count} пользователей.`)
  }

  if (cb.payload === 'broadcast') {
    return sendMessage(chatId, '📨 Рассылка пока не реализована.')
  }

  if (cb.payload === 'cancel_del') {
    return sendMessage(chatId, '❌ Удаление отменено.')
  }

  if (cb.payload.startsWith('del:')) {
    const key = cb.payload.slice(4)
    const existing = await getLink(key)
    if (!existing) return sendMessage(chatId, `❌ Ключ "${key}" не найден.`)
    await delLink(key)
    return sendMessage(chatId, `🗑 Связка "${key}" удалена.`)
  }

  if (cb.payload.startsWith('confirm_del:')) {
    const key = cb.payload.slice(11)
    return handleCallbackQuery({
      message: update.message,
      callback: { ...cb, payload: `del:${key}` }
    })
  }
}

// ── Маршруты Hono ─────────────────────────────────────────────────────────────

/** Главный webhook — сюда шлёт MAX */
app.post('/webhook', async (c) => {
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
    console.error('Handler error:', err)
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

export default handle(app)
export { app, handleBotStarted, handleMessage, handleCallbackQuery }
