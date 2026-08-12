/**
 * LinkPost Bot — Hono.js + Vercel Edge + native fetch + Vercel KV
 *
 * Маршруты:
 *   POST /webhook          — приём событий от MAX
 *   GET  /setup-webhook    — регистрация webhook (вызвать вручную 1 раз)
 */

import { Hono } from 'hono'
import { handle } from 'hono/vercel'
import { sendMessage, sendMessageWithLink, sendMessageWithKeyboard, registerWebhook, markAsRead, sendBroadcastMessage, editMessage } from '../lib/max-api.js'
import {
  setLink, getLink, delLink, getAllLinks, getLinksByCreator,
  saveUser, getUserCount, getAllUsers, reactivateUser, markInactive, removeUser,
  getLinkSubCount, getLinkAge, getDailyStat, getDailyTotal, getStatRange, getTotalRange, getLinkCount,
  getLinksRankedBySubs,
  daysAgo
} from '../lib/storage.js'
import {
  createBroadcast, getBroadcast, updateBroadcast, deleteBroadcast,
  getAllBroadcasts, getScheduledBroadcasts,
  markSent, markDelivered, markOpened, markUnsubbed, markFailed,
  getBroadcastStats, getCursor, setCursor, isSent, resetBroadcastStats,
  setProgressMessageId, getProgressMessageId
} from '../lib/broadcast.js'

const app = new Hono()

// ── Настройки ─────────────────────────────────────────────────────────────────
const ADMIN_IDS = (process.env.ADMIN_USER_IDS ?? '')
  .split(',')
  .map(s => Number(s.trim()))
  .filter(Boolean)

const BOT_NICK = process.env.BOT_NICK ?? 'YourBot'
const LINK_BUTTON_LABEL = '👉 Перейти в канал'

const LOG_LEVEL = (process.env.LOG_LEVEL ?? 'INFO').toUpperCase()
const LV = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 }

function alog (level, ...args) {
  if ((LV[level] ?? 1) >= (LV[LOG_LEVEL] ?? 1)) {
    console.log(`[API] [${level}]`, ...args)
  }
}

const isAdmin = (userId) => ADMIN_IDS.includes(userId)

// Callback-колбэки, доступные не-админам (с внутренней проверкой прав)
const ALLOWED_NON_ADMIN_PAYLOADS = ['links', 'back']
const ALLOWED_NON_ADMIN_PREFIXES = ['links_page:', 'link_preview:', 'del:', 'confirm_del:']

const canManage = (userId, link) => isAdmin(userId) || link?.creator_id === userId

const LINKS_PAGE_SIZE = 20

// ── Утилиты ───────────────────────────────────────────────────────────────────

/** Парсим аргументы: /command arg1 arg2 ...rest → ['arg1', 'arg2', ...] */
const parseArgs = (text = '') => text.trim().split(/\s+/).slice(1)

const delay = (ms) => new Promise(r => setTimeout(r, ms))
const BATCH_DELAY = 50

const APP_BASE_URL = process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : (process.env.BASE_URL || 'http://localhost:3000')

function formatBroadcastPreview (b) {
  let out = '📨 Предпросмотр:\n\n' + (b.text || '(нет текста)')
  if (b.images?.length) out += `\n\n📷 Изображений: ${b.images.length}`
  if (b.buttons?.length) out += `\n\n🔘 Кнопок: ${b.buttons.length}`
  return out
}

function statusEmoji (s) {
  return { draft: '📝', scheduled: '⏳', sending: '📤', sent: '✅', cancelled: '⏸' }[s] || '❓'
}
function statusLabel (s) {
  return { draft: 'Черновик', scheduled: 'Запланирована', sending: 'Отправляется', sent: 'Отправлена', cancelled: 'Остановлена' }[s] || s
}
function formatBroadcastDetail (b) {
  let out = `📨 Рассылка #${b.id}\n`
  out += `📅 Статус: ${statusLabel(b.status)}\n`
  out += `📝 Текст: ${(b.text || '(нет)').slice(0, 150)}${(b.text?.length || 0) > 150 ? '...' : ''}\n`
  out += `📷 Изображений: ${b.images?.length || 0}\n`
  out += `🔘 Кнопок: ${b.buttons?.length || 0}\n`
  if (b.scheduled_at) out += `🕐 Запланирована: ${new Date(b.scheduled_at).toLocaleString('ru')}\n`
  return out
}

const DENY = (chatId) =>
  sendMessage(chatId, '⛔ Эта команда доступна только администратору.')

/** Показать список связок с пагинацией (админ — все, создатель — свои) */
async function showLinksList (chatId, userId, page = 1) {
  const isAdminUser = isAdmin(userId)
  const all = isAdminUser ? await getAllLinks() : await getLinksByCreator(userId)

  if (!all.length) {
    const text = isAdminUser
      ? '📭 Нет активных связок. Добавьте первую через /setlink.'
      : '📭 У вас пока нет связок.'
    if (isAdminUser) {
      return sendMessageWithKeyboard(chatId, text, [
        [{ type: 'callback', text: '🔙 Назад', data: 'back' }]
      ])
    }
    return sendMessage(chatId, text)
  }

  const sorted = [...all].sort((a, b) => a.key.localeCompare(b.key))
  const totalPages = Math.max(1, Math.ceil(sorted.length / LINKS_PAGE_SIZE))
  const safePage = Math.min(Math.max(1, page), totalPages)
  const start = (safePage - 1) * LINKS_PAGE_SIZE
  const slice = sorted.slice(start, start + LINKS_PAGE_SIZE)

  let out = (isAdminUser ? '📋 Связки' : '📋 Ваши связки')
  out += ` (${sorted.length}, стр. ${safePage} из ${totalPages})\n\n`
  out += slice.map((l, i) => `${start + i + 1}. 🔑 ${l.key} — /link ${l.key}`).join('\n')

  const rows = []
  const navRow = []
  if (safePage > 1) navRow.push({ type: 'callback', text: '⬅️', data: `links_page:${safePage - 1}` })
  if (safePage < totalPages) navRow.push({ type: 'callback', text: '➡️', data: `links_page:${safePage + 1}` })
  if (navRow.length) rows.push(navRow)
  if (isAdminUser) rows.push([{ type: 'callback', text: '🔙 Назад', data: 'back' }])

  // У создателя на единственной странице клавиатуры нет — пустую inline_keyboard не отправляем
  if (!rows.length) return sendMessage(chatId, out)

  alog('DEBUG', ' showLinksList: userId=%d, page=%d, total=%d, totalPages=%d', userId, safePage, sorted.length, totalPages)
  return sendMessageWithKeyboard(chatId, out, rows)
}

/** Показать админское главное меню */
async function showAdminMenu (chatId, userId) {
  if (!isAdmin(userId)) return
  const count = await getUserCount()
  alog('DEBUG', ' showAdminMenu: показано меню для чата', chatId)
  await sendMessageWithKeyboard(
    chatId,
    `👋 Привет, Админ! В базе ${count} пользователей.`,
    [
      [{ type: 'callback', text: '📋 Связки', data: 'links' },
       { type: 'callback', text: '➕ Создать', data: 'create' }],
      [{ type: 'callback', text: '👥 Пользователи', data: 'users' },
       { type: 'callback', text: '📊 Статистика', data: 'stats' }],
      [{ type: 'callback', text: '📨 Рассылка', data: 'broadcast_menu' }]
    ]
  )
}

// ── Обработчики событий ───────────────────────────────────────────────────────

async function getActiveDraft (userId) {
  try {
    const all = await getAllBroadcasts()
    return all.find(b => b.status === 'draft' && b.created_by === userId) || null
  } catch {
    return null
  }
}

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
        { label: LINK_BUTTON_LABEL, url: data.url }
      )
    } else {
      await sendMessage(chat_id, '❌ Ссылка не найдена или устарела.')
    }
    return
  }

  // Обычный /start без payload
  if (isAdmin(user?.user_id)) {
    await showAdminMenu(chat_id, user?.user_id)
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

  // Track broadcast opens
  if (user?.user_id) {
    try {
      const recentBroadcasts = await getAllBroadcasts()
      const window72h = Date.now() - 72 * 3600000
      for (const rb of recentBroadcasts) {
        if (rb.created_at > window72h && (rb.status === 'sending' || rb.status === 'sent')) {
          const wasSent = await isSent(rb.id, user.user_id)
          if (wasSent) {
            await markOpened(rb.id, user.user_id)
          }
        }
      }
    } catch (e) {
      // Silently ignore tracking failures — don't block user interaction
    }
  }

  const userId = user?.user_id

  // ── Команды ─────────────────────────────────────────────────────────────────

  if (text.startsWith('/start')) {
    return handleBotStarted({ chat_id, user, payload: null })
  }

  // Не-админам разрешены только /links и /link — остальные команды молча игнорируем
  if (!isAdmin(userId) && text.startsWith('/')) {
    const isAllowedLinkCmd = text === '/links' || text.startsWith('/links ') ||
      text === '/link' || text.startsWith('/link ')
    if (!isAllowedLinkCmd) return
  }

  if (text.startsWith('/setlink')) {
    const [key, url, ...rest] = parseArgs(text)
    if (!key || !url || !rest.length) {
      return sendMessage(chat_id,
        '⚠️ Формат: /setlink <ключ> <url> <сообщение>\n\n' +
        'Пример:\n/setlink vip https://max.ru/channel/xxx Добро пожаловать! 🎉'
      )
    }
    try {
      const u = new URL(url)
      if (!['http:', 'https:'].includes(u.protocol)) throw new Error()
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
    if (!canManage(userId, existing)) {
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

  if (text === '/links' || text.startsWith('/links ')) {
    const [pageArg] = parseArgs(text)
    const page = pageArg ? Math.max(1, parseInt(pageArg, 10) || 1) : 1
    return showLinksList(chat_id, userId, page)
  }

  if (text.startsWith('/users')) {
    const count = await getUserCount()
    return sendMessage(chat_id, `👥 В базе ${count} пользователей.`)
  }

  if (text.startsWith('/stats')) {
    const [key] = parseArgs(text)
    if (!key) {
      return sendMessage(chat_id,
        '⚠️ Формат: /stats <ключ>\n\n' +
        'Пример:\n/stats vip'
      )
    }
    const link = await getLink(key)
    if (!link) return sendMessage(chat_id, `❌ Ключ "${key}" не найден.`)

    const total = await getLinkSubCount(key)
    const today = await getDailyStat(key, daysAgo(0))
    const yesterday = await getDailyStat(key, daysAgo(1))
    const weekRange = await getStatRange(key, daysAgo(6), daysAgo(0))
    const weekTotal = weekRange.reduce((s, d) => s + d.count, 0)
    const age = await getLinkAge(key)

    console.log('[API] /stats: key=%s, total=%d, today=%d, week=%d', key, total, today, weekTotal)

    let msg = `📊 Статистика ключа «${key}»\n\n`
    msg += `👥 Всего: ${total}\n`
    msg += `📅 Сегодня: +${today}\n`
    msg += `📆 Вчера: +${yesterday}\n`
    msg += `📈 За неделю: +${weekTotal}\n`
    if (age != null) msg += `🕐 Возраст ключа: ${age} дн.\n`
    msg += `\n🔗 ${link.url}`

    return sendMessage(chat_id, msg)
  }

  // Broadcast draft flow (admin only)
  if (isAdmin(userId)) {
    const draft = await getActiveDraft(userId)
    if (draft) {
      // Step 1: collecting text
      if (!draft.text) {
        await updateBroadcast(draft.id, { text })
        return sendMessageWithKeyboard(chat_id,
          '✅ Текст сохранён!\n\n' +
          'Теперь отправьте изображения (по одному) или нажмите «Готово» чтобы пропустить.\n\n' +
          `ID: ${draft.id}`,
          [
            [{ type: 'callback', text: '✅ Готово', data: `broadcast_images_done:${draft.id}` }],
            [{ type: 'callback', text: '🔙 Назад', data: 'broadcast_menu' }]
          ]
        )
      }

      // Step 2: collecting images
      if (draft.text && !draft._images_done) {
        const photoAttachment = message?.attachments?.find(a => a.type === 'image')
        if (photoAttachment) {
          const fileId = photoAttachment.payload?.file_id || photoAttachment.payload?.id
          if (fileId) {
            const images = (draft.images || []).concat([fileId])
            await updateBroadcast(draft.id, { images })
            return sendMessage(chat_id, `📷 Изображение добавлено (${images.length}). Отправьте ещё или нажмите «Готово».`)
          }
        }
        // If text but no image, ignore
        return
      }

      // Step 3: collecting buttons
      if (draft._images_done && !draft._buttons_done) {
        const lines = text.split('\n').filter(l => l.trim())
        const buttons = []
        for (const line of lines) {
          const parts = line.split('|')
          if (parts.length >= 2) {
            const btnText = parts[0].trim()
            const btnUrl = parts.slice(1).join('|').trim()
            if (btnText && btnUrl) {
              try {
                const u = new URL(btnUrl)
                if (['http:', 'https:'].includes(u.protocol)) {
                  buttons.push({ text: btnText, url: btnUrl })
                }
              } catch { /* skip invalid URLs */ }
            }
          }
        }
        if (buttons.length) {
          await updateBroadcast(draft.id, { buttons, _buttons_done: true })
        } else {
          await updateBroadcast(draft.id, { _buttons_done: true })
        }
        // Proceed to confirmation
        const updated = await getBroadcast(draft.id)
        return sendMessageWithKeyboard(chat_id,
          formatBroadcastPreview(updated) + '\n\nОтправить сейчас?',
          [
            [{ type: 'callback', text: '✅ Отправить', data: `broadcast_confirm_now:${draft.id}` }],
            [{ type: 'callback', text: '🔍 Тест', data: `broadcast_test:${draft.id}` }],
            [{ type: 'callback', text: '🔙 Назад', data: 'broadcast_menu' }]
          ]
        )
      }

      return
    }
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

  const isAllowedPayload = ALLOWED_NON_ADMIN_PAYLOADS.includes(cb.payload) ||
    ALLOWED_NON_ADMIN_PREFIXES.some(p => cb.payload.startsWith(p))
  if (!isAdmin(userId) && !isAllowedPayload) return

  // Track broadcast opens
  if (cb.user?.user_id) {
    try {
      const recentBroadcasts = await getAllBroadcasts()
      const window72h = Date.now() - 72 * 3600000
      for (const rb of recentBroadcasts) {
        if (rb.created_at > window72h && (rb.status === 'sending' || rb.status === 'sent')) {
          const wasSent = await isSent(rb.id, cb.user.user_id)
          if (wasSent) {
            await markOpened(rb.id, cb.user.user_id)
          }
        }
      }
    } catch (e) {
      // Silently ignore tracking failures — don't block user interaction
    }
  }

  if (cb.payload === 'links') {
    return showLinksList(chatId, userId, 1)
  }

  if (cb.payload.startsWith('links_page:')) {
    const page = parseInt(cb.payload.slice('links_page:'.length), 10) || 1
    return showLinksList(chatId, userId, page)
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

  if (cb.payload === 'broadcast_menu') {
    let stats = { draft: 0, scheduled: 0, sending: 0, sent: 0, cancelled: 0 }
    try {
      const all = await getAllBroadcasts()
      for (const b of all) {
        if (stats[b.status] !== undefined) stats[b.status]++
      }
    } catch (e) {
      alog('WARN', 'broadcast_menu: failed to load broadcasts', e.message)
    }
    return sendMessageWithKeyboard(chatId,
      '📨 Рассылки\n\n' +
      `📝 Черновики: ${stats.draft}\n` +
      `⏳ Запланировано: ${stats.scheduled}\n` +
      `📤 Отправляется: ${stats.sending}\n` +
      `✅ Отправлено: ${stats.sent}\n` +
      `⏸ Отменено: ${stats.cancelled}`,
      [
        [{ type: 'callback', text: '📝 Новая рассылка', data: 'broadcast_create' }],
        [{ type: 'callback', text: '📋 Список рассылок', data: 'broadcast_list' }],
        [{ type: 'callback', text: '🧹 Очистить неактивных', data: 'broadcast_clear_stale' }],
        [{ type: 'callback', text: '🔙 Назад', data: 'back' }]
      ]
    )
  }

  if (cb.payload === 'broadcast_create') {
    // Cancel any existing draft for this admin
    const oldDraft = await getActiveDraft(userId)
    if (oldDraft) {
      await updateBroadcast(oldDraft.id, { status: 'cancelled' })
      alog('DEBUG', 'broadcast_create: cancelled old draft %s', oldDraft.id)
    }
    const draft = await createBroadcast({
      text: '',
      created_by: userId
    })
    alog('DEBUG', 'broadcast_create: new draft %s for userId=%d', draft.id, userId)
    return sendMessageWithKeyboard(chatId,
      '📝 Новая рассылка (шаг 1/4)\n\n' +
      'Введите текст сообщения (поддерживается Markdown):\n\n' +
      `ID черновика: ${draft.id}`,
      [[{ type: 'callback', text: '🔙 Назад', data: 'broadcast_menu' }]]
    )
  }

  if (cb.payload === 'stats') {
    alog('DEBUG', ' callback: stats → подменю')
    return sendMessageWithKeyboard(chatId, '📊 Статистика\n\nВыберите раздел:', [
      [{ type: 'callback', text: '📈 Общая', data: 'stats_general' }],
      [{ type: 'callback', text: '🔑 По ключу', data: 'stats_by_key' }],
      [{ type: 'callback', text: '🏆 Топ ключей', data: 'stats_top' }],
      [{ type: 'callback', text: '📨 Рассылки', data: 'stats_broadcasts_overall' }],
      [{ type: 'callback', text: '🔙 Назад', data: 'back' }]
    ])
  }

  if (cb.payload === 'stats_general') {
    alog('DEBUG', ' callback: stats_general → общая статистика')
    const totalUsers = await getUserCount()
    const totalLinks = await getLinkCount()
    const todayTotal = await getDailyTotal(daysAgo(0))
    const yesterdayTotal = await getDailyTotal(daysAgo(1))
    const weekRange = await getTotalRange(daysAgo(6), daysAgo(0))
    const weekTotal = weekRange.reduce((s, d) => s + d.count, 0)

    let msg = '📊 Общая статистика\n\n'
    msg += `👥 Всего пользователей: ${totalUsers}\n`
    msg += `📅 Новых сегодня: +${todayTotal}\n`
    msg += `📆 Новых вчера: +${yesterdayTotal}\n`
    msg += `📈 Новых за неделю: +${weekTotal}\n`
    msg += `🔑 Активных связок: ${totalLinks}`

    return sendMessageWithKeyboard(chatId, msg, [
      [{ type: 'callback', text: '🔙 Назад', data: 'back' }]
    ])
  }

  if (cb.payload === 'stats_by_key') {
    alog('DEBUG', ' callback: stats_by_key → список ключей')
    const links = await getAllLinks()
    if (!links.length) {
      return sendMessageWithKeyboard(chatId, '📭 Нет активных связок.', [
        [{ type: 'callback', text: '🔙 Назад', data: 'back' }]
      ])
    }
    const buttons = []
    for (let i = 0; i < links.length; i += 2) {
      const row = [{ type: 'callback', text: `🔑 ${links[i].key}`, data: `stats_key:${links[i].key}` }]
      if (links[i + 1]) {
        row.push({ type: 'callback', text: `🔑 ${links[i + 1].key}`, data: `stats_key:${links[i + 1].key}` })
      }
      buttons.push(row)
    }
    buttons.push([{ type: 'callback', text: '🔙 Назад', data: 'back' }])
    return sendMessageWithKeyboard(chatId, `🔑 Выберите ключ (${links.length}):`, buttons)
  }

  if (cb.payload.startsWith('stats_key:')) {
    const key = cb.payload.slice('stats_key:'.length)
    alog('DEBUG', ' callback: stats_key → key=%s', key)
    const link = await getLink(key)
    if (!link) {
      return sendMessageWithKeyboard(chatId, `❌ Ключ "${key}" не найден.`, [
        [{ type: 'callback', text: '🔙 К списку', data: 'stats_by_key' }]
      ])
    }
    const total = await getLinkSubCount(key)
    const today = await getDailyStat(key, daysAgo(0))
    const yesterday = await getDailyStat(key, daysAgo(1))
    const weekRange = await getStatRange(key, daysAgo(6), daysAgo(0))
    const weekTotal = weekRange.reduce((s, d) => s + d.count, 0)
    const age = await getLinkAge(key)

    let msg = `📊 Статистика ключа «${key}»\n\n`
    msg += `👥 Всего: ${total}\n`
    msg += `📅 Сегодня: +${today}\n`
    msg += `📆 Вчера: +${yesterday}\n`
    msg += `📈 За неделю: +${weekTotal}\n`
    if (age != null) msg += `🕐 Возраст ключа: ${age} дн.\n`
    msg += `\n🔗 ${link.url}`

    return sendMessageWithKeyboard(chatId, msg, [
      [
        { type: 'callback', text: '🗑 Удалить', data: `del:${key}` },
        { type: 'callback', text: '🔙 К списку', data: 'stats_by_key' }
      ]
    ])
  }

  if (cb.payload === 'stats_top') {
    alog('DEBUG', ' callback: stats_top → рейтинг ключей')
    const ranked = await getLinksRankedBySubs()
    if (!ranked.length) {
      return sendMessageWithKeyboard(chatId, '📭 Нет активных связок.', [
        [{ type: 'callback', text: '🔙 Назад', data: 'back' }]
      ])
    }
    const top10 = ranked.slice(0, 10)
    let msg = '🏆 Топ ключей по подписчикам\n\n'
    top10.forEach((l, i) => {
      msg += `${i + 1}. 🔑 ${l.key} → 👥 ${l.subCount}\n`
    })
    return sendMessageWithKeyboard(chatId, msg, [
      [{ type: 'callback', text: '🔙 Назад', data: 'back' }]
    ])
  }

  if (cb.payload === 'stats_broadcasts_overall') {
    alog('DEBUG', ' callback: stats_broadcasts_overall → агрегация')
    const all = await getAllBroadcasts()
    let totalSent = 0; let totalOpened = 0; let totalUnsubbed = 0; let totalFailed = 0; let count = 0
    for (const br of all) {
      const s = await getBroadcastStats(br.id)
      totalSent += s.sent
      totalOpened += s.opened
      totalUnsubbed += s.unsubbed
      totalFailed += s.failed
      if (s.sent > 0) count++
    }
    const avgOpenPct = totalSent ? Math.round(totalOpened / totalSent * 100) : 0
    let msg = '📊 Общая статистика рассылок\n\n'
    msg += `📨 Всего рассылок с отправкой: ${count}\n`
    msg += `📤 Всего отправлено сообщений: ${totalSent}\n`
    msg += `👁 Всего открытий: ${totalOpened} (в среднем ${avgOpenPct}%)\n`
    msg += `🚫 Всего отписок: ${totalUnsubbed}\n`
    msg += `❌ Всего ошибок: ${totalFailed}`
    alog('DEBUG', 'stats_broadcasts_overall: all=%d, withSent=%d, totalSent=%d', all.length, count, totalSent)
    return sendMessageWithKeyboard(chatId, msg, [
      [{ type: 'callback', text: '🔙 Назад', data: 'back' }]
    ])
  }

  if (cb.payload.startsWith('broadcast_images_done:')) {
    const bid = cb.payload.slice('broadcast_images_done:'.length)
    await updateBroadcast(bid, { _images_done: true })
    return sendMessageWithKeyboard(chatId,
      '🔘 Шаг 3/4: Кнопки\n\n' +
      'Отправьте кнопки в формате:\n' +
      'Текст кнопки | https://ссылка\n\n' +
      'По одной кнопке на строку. До 5 кнопок.\n' +
      'Нажмите «Готово» чтобы пропустить.',
      [
        [{ type: 'callback', text: '✅ Готово', data: `broadcast_buttons_done:${bid}` }],
        [{ type: 'callback', text: '🔙 Назад', data: 'broadcast_menu' }]
      ]
    )
  }

  if (cb.payload.startsWith('broadcast_buttons_done:')) {
    const bid = cb.payload.slice('broadcast_buttons_done:'.length)
    const b = await getBroadcast(bid)
    if (!b) return sendMessage(chatId, '❌ Рассылка не найдена.')
    await updateBroadcast(bid, { _buttons_done: true })
    return sendMessageWithKeyboard(chatId,
      formatBroadcastPreview(b) + '\n\nОтправить сейчас?',
      [
        [{ type: 'callback', text: '✅ Отправить', data: `broadcast_confirm_now:${bid}` }],
        [{ type: 'callback', text: '🔍 Тест', data: `broadcast_test:${bid}` }],
        [{ type: 'callback', text: '🔙 Назад', data: 'broadcast_menu' }]
      ]
    )
  }

  if (cb.payload.startsWith('broadcast_test:')) {
    const bid = cb.payload.slice('broadcast_test:'.length)
    const b = await getBroadcast(bid)
    if (!b) return sendMessage(chatId, '❌ Рассылка не найдена.')

    try {
      await sendBroadcastMessage(userId, b)
      alog('INFO', 'broadcast %s: test sent to admin userId=%d', bid, userId)
      return sendMessageWithKeyboard(chatId,
        '✅ Тестовая отправка выполнена!\n\n' + formatBroadcastPreview(b),
        [[{ type: 'callback', text: '🔙 Назад', data: 'broadcast_menu' }]]
      )
    } catch (err) {
      console.error(`[broadcast] ${bid}: test send error: ${err.message}`)
      return sendMessage(chatId, `❌ Ошибка тестовой отправки: ${err.message}`)
    }
  }

  if (cb.payload.startsWith('broadcast_restart:')) {
    const bid = cb.payload.slice('broadcast_restart:'.length)
    const b = await getBroadcast(bid)
    if (!b) return sendMessage(chatId, '❌ Рассылка не найдена.')

    let msg
    await updateBroadcast(bid, { status: 'draft', scheduled_at: null })
    if (b.status === 'scheduled' || b.status === 'sending') {
      alog('INFO', 'broadcast %s: status → draft, stats preserved', bid)
      msg = formatBroadcastPreview(b) + '\n\n📊 Статистика сохранена. При отправке пропустит уже доставленных.'
    } else {
      await resetBroadcastStats(bid)
      alog('INFO', 'broadcast %s: stats reset, status → draft', bid)
      msg = formatBroadcastPreview(b) + '\n\n📊 Статистика сброшена. Отправить сейчас?'
    }

    return sendMessageWithKeyboard(chatId, msg,
      [
        [{ type: 'callback', text: '✅ Отправить', data: `broadcast_confirm_now:${bid}` }],
        [{ type: 'callback', text: '✏️ Редактировать', data: `broadcast_edit:${bid}` }],
        [{ type: 'callback', text: '🔍 Тест', data: `broadcast_test:${bid}` }],
        [{ type: 'callback', text: '🔙 Назад', data: 'broadcast_menu' }]
      ]
    )
  }

  if (cb.payload.startsWith('broadcast_confirm_now:')) {
    const bid = cb.payload.slice('broadcast_confirm_now:'.length)
    const b = await getBroadcast(bid)
    if (!b) return sendMessage(chatId, '❌ Рассылка не найдена.')

    await updateBroadcast(bid, { status: 'scheduled', scheduled_at: Date.now(), created_by_chat_id: chatId })
    alog('DEBUG', 'broadcast_confirm_now: starting broadcast %s', bid)

    // Send first batch inline
    const users = await getAllUsers()
    let cursor = await getCursor(bid)
    const batchSize = 20
    const end = Math.min(cursor + batchSize, users.length)
    let sent = 0
    let failed = 0
    let totalAttempted = cursor
    let i = cursor

    // Progress reporting config
    const PROGRESS_INTERVAL = 15
    let nextProgressAt = cursor + PROGRESS_INTERVAL

    for (; i < end; i++) {
      const user = users[i]
      try {
        const alreadySent = await isSent(bid, user.user_id)
        if (alreadySent) { cursor++; continue }
        await sendBroadcastMessage(user.user_id, b)
        await markSent(bid, user.user_id)
        await markDelivered(bid, user.user_id)
        sent++
        cursor++
        await delay(BATCH_DELAY)
      } catch (err) {
        console.error(`[broadcast] ${bid}: ERROR for userId=${user.user_id}: ${err.message}`)
        await markFailed(bid, user.user_id).catch(() => {})
        if (err.message.includes('404') && (err.message.includes('chat.not.found') || err.message.includes('dialog.not.found'))) {
          await markInactive(user.user_id).catch(() => {})
          alog('INFO', 'broadcast %s: marked inactive userId=%d', bid, user.user_id)
        }
        alog('INFO', 'broadcast %s: markFailed userId=%d, advancing', bid, user.user_id)
        failed++
        cursor++
        await delay(BATCH_DELAY)
      }

      totalAttempted = i + 1

      // Progress update to admin every PROGRESS_INTERVAL users (edit in place)
      if (totalAttempted >= nextProgressAt && totalAttempted < users.length) {
        nextProgressAt = totalAttempted + PROGRESS_INTERVAL
        const statsSoFar = await getBroadcastStats(bid)
        const progressPct = Math.round((totalAttempted / users.length) * 100)
        const progressMsg = `📤 Рассылка #${bid}: ${progressPct}%\n` +
          `✅ Отправлено: ${statsSoFar.sent} / ${users.length}\n` +
          `❌ Ошибок: ${statsSoFar.failed}\n` +
          `📈 Прогресс: ${totalAttempted}/${users.length}`

        // Use admin's real chat_id (not user_id) — MAX API needs chat_id for sendMessage
        const adminChatId = chatId
        const existingMsgId = await getProgressMessageId(bid)
        if (existingMsgId) {
          editMessage(adminChatId, existingMsgId, progressMsg).catch(e =>
            console.warn('[broadcast] progress edit failed:', e.message)
          )
        } else {
          sendMessage(adminChatId, progressMsg).then(resp => {
            if (resp?.message_id) {
              setProgressMessageId(bid, resp.message_id).catch(() => {})
            }
          }).catch(e =>
            console.warn('[broadcast] progress send failed:', e.message)
          )
        }
        alog('INFO', 'broadcast %s: progress %d/%d (%d%%)', bid, totalAttempted, users.length, progressPct)
      }
    }

    if (failed) {
      alog('WARN', 'broadcast %s: %d users failed in this batch, skipped', bid, failed)
    }
    cursor = i
    await setCursor(bid, cursor)

    if (cursor >= users.length) {
      await updateBroadcast(bid, { status: 'sent' })
      console.log(`[broadcast] ${bid}: completed (${users.length} users)`)
      const finalStats = await getBroadcastStats(bid)
      const totalUs = await getUserCount()
      const openPct = finalStats.sent ? Math.round(finalStats.opened / finalStats.sent * 100) : 0
      const unsubPct = finalStats.sent ? Math.round(finalStats.unsubbed / finalStats.sent * 100) : 0
      const summaryMsg = `✅ Рассылка #${bid} завершена!\n\n` +
        `📤 Отправлено: ${finalStats.sent} / ${totalUs}\n` +
        `👁 Открыто: ${finalStats.opened} (${openPct}%)\n` +
        `🚫 Отписалось: ${finalStats.unsubbed} (${unsubPct}%)\n` +
        `❌ Ошибок: ${finalStats.failed}`
      await sendMessage(chatId, summaryMsg).catch(e => console.warn('[broadcast] failed to send summary to creator:', e.message))
      alog('INFO', 'broadcast %s: sent summary, stats=%j', bid, finalStats)
      return sendMessageWithKeyboard(chatId,
        `✅ Рассылка #${bid} завершена! Отправлено ${cursor} сообщений.`,
        [[{ type: 'callback', text: '🔙 Назад', data: 'broadcast_menu' }]]
      )
    }

    // Continue with next batch (parallel — both the admin message and the chain call happen at once)
    const secret = process.env.SETUP_SECRET
    const chainPromise = secret
      ? fetch(`${APP_BASE_URL}/process-broadcasts?secret=${encodeURIComponent(secret)}`)
          .then(r => r.json()).then(r => alog('INFO', 'broadcast %s: chain call result: %j', bid, r))
          .catch(e => console.warn('[broadcast] chain call failed:', e.message))
      : Promise.resolve()

    await Promise.all([
      sendMessageWithKeyboard(chatId,
        `📤 Рассылка #${bid} запущена! Отправлено ${sent} из ${users.length}. Продолжаю...` +
        `\nℹ️ Прогресс будет приходить каждые ${PROGRESS_INTERVAL} сообщений.`,
        [[{ type: 'callback', text: '🔙 Назад', data: 'broadcast_menu' }]]
      ),
      chainPromise
    ])
  }

  if (cb.payload === 'broadcast_list') {
    const broadcasts = await getAllBroadcasts()
    if (!broadcasts.length) {
      return sendMessageWithKeyboard(chatId, '📭 Нет рассылок.', [
        [{ type: 'callback', text: '🔙 Назад', data: 'broadcast_menu' }]
      ])
    }
    const buttons = broadcasts.slice(0, 10).map(b => [
      { type: 'callback', text: `${statusEmoji(b.status)} ${b.id}`, data: `broadcast_view:${b.id}` }
    ])
    buttons.push([{ type: 'callback', text: '🔙 Назад', data: 'broadcast_menu' }])
    return sendMessageWithKeyboard(chatId, '📋 Рассылки:', buttons)
  }

  if (cb.payload.startsWith('broadcast_view:')) {
    const bid = cb.payload.slice('broadcast_view:'.length)
    const b = await getBroadcast(bid)
    if (!b) return sendMessage(chatId, '❌ Рассылка не найдена.')

    let detail = formatBroadcastDetail(b)
    if (b.status === 'scheduled' || b.status === 'sending') {
      const cursor = await getCursor(bid)
      const totalUsers = await getUserCount()
      const stats = await getBroadcastStats(bid)
      const pct = totalUsers > 0 ? Math.round((cursor / totalUsers) * 100) : 0
      detail += `📤 Прогресс: ${cursor} / ${totalUsers} (${pct}%)\n`
      detail += `✅ Отправлено: ${stats.sent} | ❌ Ошибок: ${stats.failed}\n`
      if (stats.opened > 0) {
        detail += `👁 Открыто: ${stats.opened}\n`
      }
    }

    const btnRows = []
    if (b.status === 'draft') {
      btnRows.push([{ type: 'callback', text: '✏️ Редактировать', data: `broadcast_edit:${bid}` }])
      btnRows.push([{ type: 'callback', text: '▶️ Запустить', data: `broadcast_confirm_now:${bid}` }])
    }
    if (b.status === 'scheduled' || b.status === 'sending') {
      btnRows.push([{ type: 'callback', text: '⏸ Остановить', data: `broadcast_stop:${bid}` }])
      btnRows.push([{ type: 'callback', text: '🔄 Перезапустить', data: `broadcast_restart:${bid}` }])
    }
    if (b.status === 'sent' || b.status === 'cancelled') {
      btnRows.push([{ type: 'callback', text: '🔄 Перезапустить', data: `broadcast_restart:${bid}` }])
    }
    if (b.status === 'cancelled') {
      btnRows.push([{ type: 'callback', text: '▶️ Возобновить', data: `broadcast_resume:${bid}` }])
    }
    btnRows.push([{ type: 'callback', text: '📊 Статистика', data: `broadcast_stats:${bid}` }])
    btnRows.push([{ type: 'callback', text: '❌ Удалить', data: `broadcast_delete:${bid}` }])
    btnRows.push([{ type: 'callback', text: '🔙 К списку', data: 'broadcast_list' }])

    return sendMessageWithKeyboard(chatId, detail, btnRows)
  }

  if (cb.payload.startsWith('broadcast_stats:')) {
    const bid = cb.payload.slice('broadcast_stats:'.length)
    const b = await getBroadcast(bid)
    if (!b) return sendMessage(chatId, '❌ Рассылка не найдена.')
    const stats = await getBroadcastStats(bid)
    const totalUsers = await getUserCount()
    const openPct = stats.sent ? Math.round(stats.opened / stats.sent * 100) : 0
    const unsubPct = stats.sent ? Math.round(stats.unsubbed / stats.sent * 100) : 0

    let msg = `📊 Статистика рассылки #${bid}\n\n`
    msg += `📝 Текст: ${(b.text || '').slice(0, 100)}${(b.text?.length || 0) > 100 ? '...' : ''}\n`
    msg += `📅 Статус: ${statusLabel(b.status)}\n`
    if (b.scheduled_at) msg += `🕐 Запланирована: ${new Date(b.scheduled_at).toLocaleString('ru')}\n`
    msg += '\n'
    msg += `✅ Отправлено:   ${stats.sent} / ${totalUsers}\n`
    msg += `👁 Открыто:       ${stats.opened} (${openPct}%)\n`
    msg += `🚫 Отписалось:    ${stats.unsubbed} (${unsubPct}%)\n`

    return sendMessageWithKeyboard(chatId, msg, [
      [{ type: 'callback', text: '🔙 Назад', data: `broadcast_view:${bid}` }]
    ])
  }

  if (cb.payload.startsWith('broadcast_delete:')) {
    const bid = cb.payload.slice('broadcast_delete:'.length)
    return sendMessageWithKeyboard(chatId,
      `🗑 Удалить рассылку #${bid}?`,
      [
        [
          { type: 'callback', text: '✅ Да', data: `broadcast_delete_confirm:${bid}` },
          { type: 'callback', text: '❌ Нет', data: `broadcast_view:${bid}` }
        ]
      ]
    )
  }

  if (cb.payload.startsWith('broadcast_delete_confirm:')) {
    const bid = cb.payload.slice('broadcast_delete_confirm:'.length)
    await deleteBroadcast(bid)
    alog('DEBUG', 'broadcast_delete_confirm: deleted %s', bid)
    return sendMessageWithKeyboard(chatId, `🗑 Рассылка #${bid} удалена.`, [
      [{ type: 'callback', text: '🔙 К списку', data: 'broadcast_list' }]
    ])
  }

  if (cb.payload.startsWith('broadcast_stop:')) {
    const bid = cb.payload.slice('broadcast_stop:'.length)
    await updateBroadcast(bid, { status: 'cancelled', scheduled_at: null })
    alog('DEBUG', 'broadcast_stop: stopped %s', bid)
    return sendMessageWithKeyboard(chatId, `⏸ Рассылка #${bid} остановлена.`, [
      [{ type: 'callback', text: '🔙 Назад', data: `broadcast_view:${bid}` }]
    ])
  }

  if (cb.payload.startsWith('broadcast_resume:')) {
    const bid = cb.payload.slice('broadcast_resume:'.length)
    await updateBroadcast(bid, { status: 'scheduled', scheduled_at: Date.now() })
    alog('DEBUG', 'broadcast_resume: resumed %s', bid)
    return sendMessageWithKeyboard(chatId, `▶️ Рассылка #${bid} возобновлена.`, [
      [{ type: 'callback', text: '🔙 Назад', data: `broadcast_view:${bid}` }]
    ])
  }

  if (cb.payload.startsWith('broadcast_edit:')) {
    const bid = cb.payload.slice('broadcast_edit:'.length)
    const b = await getBroadcast(bid)
    if (!b) return sendMessage(chatId, '❌ Рассылка не найдена.')
    if (b.status !== 'draft') {
      return sendMessage(chatId, '⚠️ Редактировать можно только черновики.')
    }
    await updateBroadcast(bid, { text: '', _images_done: false, _buttons_done: false, images: [], buttons: [] })
    return sendMessageWithKeyboard(chatId,
      '📝 Редактирование (шаг 1/4)\n\n' +
      'Введите новый текст сообщения:\n\n' +
      `ID: ${bid}`,
      [[{ type: 'callback', text: '🔙 Назад', data: `broadcast_view:${bid}` }]]
    )
  }

  if (cb.payload === 'broadcast_clear_stale') {
    const all = await getAllUsers()
    const stale = all.filter(u => u.inactive)
    if (!stale.length) {
      return sendMessageWithKeyboard(chatId, '✅ Нет неактивных пользователей для очистки.', [
        [{ type: 'callback', text: '🔙 Назад', data: 'broadcast_menu' }]
      ])
    }
    const count = stale.length
    for (const u of stale) {
      await removeUser(u.user_id).catch(() => {})
    }
    alog('INFO', 'broadcast_clear_stale: removed %d inactive users', count)
    return sendMessageWithKeyboard(chatId,
      `🧹 Удалено ${count} неактивных пользователей из базы.`,
      [[{ type: 'callback', text: '🔙 Назад', data: 'broadcast_menu' }]]
    )
  }

  if (cb.payload === 'back') {
    alog('DEBUG', ' callback: back → главное меню')
    if (!isAdmin(userId)) {
      return sendMessage(chatId, 'Используйте /links для просмотра ваших связок.')
    }
    return showAdminMenu(chatId, userId)
  }

  if (cb.payload.startsWith('del:')) {
    const key = cb.payload.slice(4)
    const existing = await getLink(key)
    if (!isAdmin(userId) && (!existing || !canManage(userId, existing))) {
      return sendMessage(chatId, `⛔ Ключ "${key}" не найден или у вас нет прав.`)
    }
    if (!existing) return sendMessage(chatId, `❌ Ключ "${key}" не найден.`)
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
    if (!isAdmin(userId) && (!existing || !canManage(userId, existing))) {
      return sendMessage(chatId, `⛔ Ключ "${key}" не найден или у вас нет прав.`)
    }
    if (!existing) return sendMessage(chatId, `❌ Ключ "${key}" не найден.`)
    alog('DEBUG', ' confirm_del: deleted key=%s by userId=%d', key, userId)
    await delLink(key)
    return sendMessageWithKeyboard(chatId, `✅ Связка "${key}" удалена.`, [
      [{ type: 'callback', text: '🔙 К списку', data: 'links' }]
    ])
  }

  console.warn('[API] handleCallbackQuery: неизвестный payload', cb.payload)
}

// ── Маршруты Hono ─────────────────────────────────────────────────────────────

/** Главный webhook — сюда шлёт MAX */
app.post('/webhook', async (c) => {
  const ct = c.req.header('content-type') || ''
  if (!ct.includes('application/json')) {
    return c.json({ error: 'Content-Type must be application/json' }, 400)
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
    if (update.update_type === 'bot_stopped') {
      const userId = update.user?.user_id
      if (userId) {
        await markInactive(userId)
        try {
          const recentBroadcasts = await getAllBroadcasts()
          const sevenDaysAgo = Date.now() - 7 * 86400000
          for (const rb of recentBroadcasts) {
            if (rb.created_at > sevenDaysAgo) {
              const wasSent = await isSent(rb.id, userId)
              if (wasSent) {
                await markUnsubbed(rb.id, userId)
                console.log(`[broadcast] ${rb.id}: user ${userId} unsubscribed after broadcast`)
              }
            }
          }
        } catch (e) {
          console.warn('[API] bot_stopped: broadcast unsub tracking failed:', e.message)
        }
      }
    }
  } catch (err) {
    console.error('[API] Handler error:', err?.message ?? err)
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

app.get('/process-broadcasts', async (c) => {
  const secret = c.req.query('secret')
  if (secret !== process.env.SETUP_SECRET) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const broadcasts = await getScheduledBroadcasts()
  if (!broadcasts.length) {
    return c.json({ message: 'No broadcasts to process' })
  }

  const results = []

  const PROGRESS_INTERVAL = 15

  for (const b of broadcasts) {
    try {
      await updateBroadcast(b.id, { status: 'sending' })
      console.log(`[broadcast] ${b.id}: started`)

      const users = await getAllUsers()
      let cursor = await getCursor(b.id)
      const batchSize = 20
      const end = Math.min(cursor + batchSize, users.length)

      let sentInBatch = 0
      let failedInBatch = 0
      let i = cursor
      for (; i < end; i++) {
        const user = users[i]
        try {
          const alreadySent = await isSent(b.id, user.user_id)
          if (alreadySent) {
            cursor++
            continue
          }

          await sendBroadcastMessage(user.user_id, b)
          await markSent(b.id, user.user_id)
          await markDelivered(b.id, user.user_id)
          sentInBatch++
          cursor++
          await delay(BATCH_DELAY)
        } catch (err) {
          console.error(`[broadcast] ${b.id}: ERROR for userId=${user.user_id}: ${err.message}`)
          await markFailed(b.id, user.user_id).catch(() => {})
          if (err.message.includes('404') && (err.message.includes('chat.not.found') || err.message.includes('dialog.not.found'))) {
            await markInactive(user.user_id).catch(() => {})
            alog('INFO', 'broadcast %s: marked inactive userId=%d', b.id, user.user_id)
          }
          alog('INFO', 'broadcast %s: markFailed userId=%d, advancing', b.id, user.user_id)
          failedInBatch++
          cursor++
          await delay(BATCH_DELAY)
        }
      }

      if (failedInBatch) {
        alog('WARN', 'broadcast %s: %d users failed in this batch, skipped', b.id, failedInBatch)
      }
      const newCursor = i
      await setCursor(b.id, newCursor)

      // Send progress report to admin periodically (edit existing, don't spam)
      const totalAttempted = newCursor
      if (totalAttempted > 0 && totalAttempted < users.length && totalAttempted % PROGRESS_INTERVAL < batchSize) {
        const chainStats = await getBroadcastStats(b.id)
        const progressPct = Math.round((totalAttempted / users.length) * 100)
        const progressMsg = `📤 Рассылка #${b.id}: ${progressPct}%\n` +
          `✅ Отправлено: ${chainStats.sent} / ${users.length}\n` +
          `❌ Ошибок: ${chainStats.failed}\n` +
          `📈 Прогресс: ${totalAttempted}/${users.length}`

        // Use admin's chat_id (stored at broadcast start) — user_id != chat_id in MAX API
        const adminChatId = b.created_by_chat_id
        if (!adminChatId) {
          alog('WARN', 'broadcast %s: no created_by_chat_id, skipping progress', b.id)
        } else {
          const existingMsgId = await getProgressMessageId(b.id)
          if (existingMsgId) {
            editMessage(adminChatId, existingMsgId, progressMsg).catch(e =>
              console.warn('[broadcast] progress edit failed:', e.message)
            )
          } else {
            sendMessage(adminChatId, progressMsg).then(resp => {
              if (resp?.message_id) {
                setProgressMessageId(b.id, resp.message_id).catch(() => {})
              }
            }).catch(e =>
              console.warn('[broadcast] progress send failed:', e.message)
            )
          }
          alog('INFO', 'broadcast %s: progress %d/%d (%d%%)', b.id, totalAttempted, users.length, progressPct)
        }
      }

      if (newCursor >= users.length) {
        await updateBroadcast(b.id, { status: 'sent' })
        console.log(`[broadcast] ${b.id}: completed (${users.length} users)`)
        const chainStats = await getBroadcastStats(b.id)
        const chainTotalUs = await getUserCount()
        const chainOpenPct = chainStats.sent ? Math.round(chainStats.opened / chainStats.sent * 100) : 0
        const chainUnsubPct = chainStats.sent ? Math.round(chainStats.unsubbed / chainStats.sent * 100) : 0
        const chainSummary = `✅ Рассылка #${b.id} завершена!\n\n` +
          `📤 Отправлено: ${chainStats.sent} / ${chainTotalUs}\n` +
          `👁 Открыто: ${chainStats.opened} (${chainOpenPct}%)\n` +
          `🚫 Отписалось: ${chainStats.unsubbed} (${chainUnsubPct}%)\n` +
          `❌ Ошибок: ${chainStats.failed}`
        const summaryChatId = b.created_by_chat_id
        if (summaryChatId) {
          await sendMessage(summaryChatId, chainSummary).catch(e => console.warn('[broadcast] failed to send chain summary to creator:', e.message))
        }
        alog('INFO', 'broadcast %s: completed, stats=%j', b.id, chainStats)
      } else {
        console.log(`[broadcast] ${b.id}: progress ${newCursor}/${users.length}`)
        // Если админ остановил рассылку, пока шёл батч — не возобновляем
        const fresh = await getBroadcast(b.id)
        if (fresh && fresh.status === 'cancelled') {
          alog('INFO', 'broadcast %s: stopped during batch, not rescheduling', b.id)
        } else {
          // Set back to scheduled so next invocation picks it up
          await updateBroadcast(b.id, { status: 'scheduled', scheduled_at: Date.now() + 1000 })
          // Continue with next batch
          const host = c.req.header('host')
          const scheme = c.req.header('x-forwarded-proto') || 'https'
          await fetch(`${scheme}://${host}/process-broadcasts?secret=${encodeURIComponent(secret)}`)
            .then(r => r.json()).then(r => alog('INFO', 'broadcast %s: chain call result: %j', b.id, r))
            .catch(e => console.warn('[broadcast] chain call failed:', e.message))
        }
      }

      results.push({ id: b.id, sent: sentInBatch, cursor: newCursor, total: users.length })
    } catch (err) {
      console.error(`[broadcast] ${b.id}: fatal error: ${err.message}`)
      results.push({ id: b.id, error: err.message })
    }
  }

  return c.json({ processed: results.length, results })
})

/**
 * CRON-эндпоинт — вызывается каждую минуту.
 * На Vercel — платформенным cron (заголовок x-vercel-cron), на Amvera — внутренним таймером (localhost).
 * Внешние запросы без этих признаков отклоняются.
 */
app.get('/cron-process-broadcasts', async (c) => {
  const host = (c.req.header('host') || '').toLowerCase()
  const forwardedFor = c.req.header('x-forwarded-for') || ''
  const isLocal = host.startsWith('localhost') || host.startsWith('127.0.0.1') || forwardedFor.includes('127.0.0.1')
  const isVercelCron = c.req.header('x-vercel-cron') === '1'
  if (!isLocal && !isVercelCron) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const broadcasts = await getScheduledBroadcasts()
  if (!broadcasts.length) {
    return c.json({ message: 'No broadcasts to process' })
  }

  const results = []
  const PROGRESS_INTERVAL = 15

  for (const b of broadcasts) {
    try {
      await updateBroadcast(b.id, { status: 'sending' })
      console.log(`[broadcast] ${b.id}: cron picked up`)

      const users = await getAllUsers()
      let cursor = await getCursor(b.id)
      const batchSize = 20
      const end = Math.min(cursor + batchSize, users.length)

      let sentInBatch = 0
      let failedInBatch = 0
      let i = cursor
      for (; i < end; i++) {
        const user = users[i]
        try {
          const alreadySent = await isSent(b.id, user.user_id)
          if (alreadySent) {
            cursor++
            continue
          }

          await sendBroadcastMessage(user.user_id, b)
          await markSent(b.id, user.user_id)
          await markDelivered(b.id, user.user_id)
          sentInBatch++
          cursor++
          await delay(BATCH_DELAY)
        } catch (err) {
          console.error(`[broadcast] ${b.id}: ERROR for userId=${user.user_id}: ${err.message}`)
          await markFailed(b.id, user.user_id).catch(() => {})
          if (err.message.includes('404') && (err.message.includes('chat.not.found') || err.message.includes('dialog.not.found'))) {
            await markInactive(user.user_id).catch(() => {})
            alog('INFO', 'broadcast %s: marked inactive userId=%d', b.id, user.user_id)
          }
          alog('INFO', 'broadcast %s: markFailed userId=%d, advancing', b.id, user.user_id)
          failedInBatch++
          cursor++
          await delay(BATCH_DELAY)
        }
      }

      if (failedInBatch) {
        alog('WARN', 'broadcast %s: %d users failed in this batch, skipped', b.id, failedInBatch)
      }
      const newCursor = i
      await setCursor(b.id, newCursor)

      // Progress report to admin (edit existing, don't spam)
      const totalAttempted = newCursor
      if (totalAttempted > 0 && totalAttempted < users.length && totalAttempted % PROGRESS_INTERVAL < batchSize) {
        const cStats = await getBroadcastStats(b.id)
        const pct = Math.round((totalAttempted / users.length) * 100)
        const msg = `📤 Рассылка #${b.id}: ${pct}%\n` +
          `✅ Отправлено: ${cStats.sent} / ${users.length}\n` +
          `❌ Ошибок: ${cStats.failed}\n` +
          `📈 Прогресс: ${totalAttempted}/${users.length}`

        const adminChatId = b.created_by_chat_id
        if (!adminChatId) {
          alog('WARN', 'broadcast %s: no created_by_chat_id, skipping cron progress', b.id)
        } else {
          const existingMsgId = await getProgressMessageId(b.id)
          if (existingMsgId) {
            editMessage(adminChatId, existingMsgId, msg).catch(e =>
              console.warn('[broadcast] cron progress edit failed:', e.message)
            )
          } else {
            sendMessage(adminChatId, msg).then(resp => {
              if (resp?.message_id) {
                setProgressMessageId(b.id, resp.message_id).catch(() => {})
              }
            }).catch(e =>
              console.warn('[broadcast] cron progress send failed:', e.message)
            )
          }
        }
      }

      if (newCursor >= users.length) {
        await updateBroadcast(b.id, { status: 'sent' })
        console.log(`[broadcast] ${b.id}: completed (${users.length} users)`)
        const cStats = await getBroadcastStats(b.id)
        const cTotal = await getUserCount()
        const openPct = cStats.sent ? Math.round(cStats.opened / cStats.sent * 100) : 0
        const unsubPct = cStats.sent ? Math.round(cStats.unsubbed / cStats.sent * 100) : 0
        const summary = `✅ Рассылка #${b.id} завершена!\n\n` +
          `📤 Отправлено: ${cStats.sent} / ${cTotal}\n` +
          `👁 Открыто: ${cStats.opened} (${openPct}%)\n` +
          `🚫 Отписалось: ${cStats.unsubbed} (${unsubPct}%)\n` +
          `❌ Ошибок: ${cStats.failed}`
        const summaryChatId = b.created_by_chat_id
        if (summaryChatId) {
          await sendMessage(summaryChatId, summary).catch(e => console.warn('[broadcast] cron summary send failed:', e.message))
        }
      } else {
        console.log(`[broadcast] ${b.id}: cron progress ${newCursor}/${users.length}`)
        // Если админ остановил рассылку, пока шёл батч — не возобновляем
        const fresh = await getBroadcast(b.id)
        if (fresh && fresh.status === 'cancelled') {
          alog('INFO', 'broadcast %s: stopped during batch, not rescheduling', b.id)
        } else {
          await updateBroadcast(b.id, { status: 'scheduled', scheduled_at: Date.now() + 1000 })
        }
      }

      results.push({ id: b.id, sent: sentInBatch, cursor: newCursor, total: users.length })
    } catch (err) {
      console.error(`[broadcast] ${b.id}: cron fatal error: ${err.message}`)
      results.push({ id: b.id, error: err.message })
    }
  }

  return c.json({ processed: results.length, results })
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

const webHandler = handle(app)

export default async function nodeHandler (req, res) {
  const proto = req.headers['x-forwarded-proto'] || 'https'
  const host = req.headers.host || 'localhost'
  const url = `${proto}://${host}${req.url}`

  const init = { method: req.method, headers: req.headers }
  if (!['GET', 'HEAD'].includes(req.method)) {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    init.body = Buffer.concat(chunks)
  }

  const webReq = new Request(url, init)
  const webRes = await webHandler(webReq)

  res.statusCode = webRes.status
  for (const [key, value] of webRes.headers) {
    res.setHeader(key, value)
  }

  const body = await webRes.arrayBuffer()
  res.end(Buffer.from(body))
}

export { app, handleBotStarted, handleMessage, handleCallbackQuery }


