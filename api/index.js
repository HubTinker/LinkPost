/**
 * LinkPost Bot — Hono.js + Vercel Edge + native fetch + Vercel KV
 *
 * Маршруты:
 *   POST /webhook          — приём событий от MAX
 *   GET  /setup-webhook    — регистрация webhook (вызвать вручную 1 раз)
 */

import { Hono } from 'hono'
import { handle } from 'hono/vercel'
import { sendMessage, sendMessageWithLink, sendMessageWithKeyboard, registerWebhook, markAsRead, sendBroadcastMessage } from '../lib/max-api.js'
import {
  setLink, getLink, delLink, getAllLinks, getLinksByCreator,
  saveUser, getUserCount, reactivateUser,
  getLinkSubCount, getLinkAge, getDailyStat, getDailyTotal, getStatRange, getTotalRange, getLinkCount,
  getLinksRankedBySubs,
  daysAgo
} from '../lib/storage.js'
import {
  createBroadcast, getBroadcast, updateBroadcast, deleteBroadcast,
  getAllBroadcasts, getScheduledBroadcasts,
  markSent, markDelivered, markOpened, markUnsubbed,
  getBroadcastStats
} from '../lib/broadcast.js'

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

function parseRussianDate (str) {
  const m = str.match(/^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{1,2}):(\d{2})$/)
  if (!m) return null
  const [, day, month, year, hour, min] = m
  const d = new Date(+year, +month - 1, +day, +hour, +min)
  return isNaN(d.getTime()) ? null : d.getTime()
}

function formatBroadcastPreview (b) {
  let out = '📨 Предпросмотр:\n\n' + (b.text || '(нет текста)')
  if (b.images?.length) out += `\n\n📷 Изображений: ${b.images.length}`
  if (b.buttons?.length) out += `\n\n🔘 Кнопок: ${b.buttons.length}`
  return out
}

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

  // Не-админы — молча игнорируем все команды (без сообщений об ошибках)
  if (!isAdmin(userId) && text.startsWith('/')) return

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
        // Proceed to schedule step
        const updated = await getBroadcast(draft.id)
        return sendMessageWithKeyboard(chat_id,
          `🔘 Кнопки сохранены (${updated.buttons?.length || 0}).\n\n⏰ Шаг 4/4: Когда отправить?`,
          [
            [{ type: 'callback', text: '🚀 Отправить сейчас', data: `broadcast_send_now:${draft.id}` }],
            [{ type: 'callback', text: '📅 Запланировать', data: `broadcast_schedule_input:${draft.id}` }],
            [{ type: 'callback', text: '🔙 Назад', data: 'broadcast_menu' }]
          ]
        )
      }

      // Step 4: scheduling — entering datetime
      if (draft._buttons_done && draft._schedule_pending) {
        const parsed = parseRussianDate(text)
        if (!parsed || parsed <= Date.now()) {
          return sendMessage(chat_id, '⚠️ Неверная дата или время в прошлом. Формат: ДД.ММ.ГГГГ ЧЧ:ММ\n\nПример: 31.12.2026 18:00')
        }
        await updateBroadcast(draft.id, {
          status: 'scheduled',
          scheduled_at: parsed,
          _schedule_pending: false
        })
        return sendMessageWithKeyboard(chat_id,
          `✅ Рассылка запланирована на ${text}`,
          [[{ type: 'callback', text: '🔙 Назад', data: 'broadcast_menu' }]]
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

  if (!isAdmin(userId)) return

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
      `🔘 Кнопки сохранены (${b.buttons?.length || 0}).\n\n⏰ Шаг 4/4: Когда отправить?`,
      [
        [{ type: 'callback', text: '🚀 Отправить сейчас', data: `broadcast_send_now:${bid}` }],
        [{ type: 'callback', text: '📅 Запланировать', data: `broadcast_schedule_input:${bid}` }],
        [{ type: 'callback', text: '🔙 Назад', data: 'broadcast_menu' }]
      ]
    )
  }

  if (cb.payload.startsWith('broadcast_send_now:')) {
    const bid = cb.payload.slice('broadcast_send_now:'.length)
    const b = await getBroadcast(bid)
    if (!b) return sendMessage(chatId, '❌ Рассылка не найдена.')
    return sendMessageWithKeyboard(chatId,
      formatBroadcastPreview(b) + '\n\nОтправить сейчас?',
      [
        [{ type: 'callback', text: '✅ Подтвердить', data: `broadcast_confirm_now:${bid}` }],
        [{ type: 'callback', text: '🔙 Назад', data: 'broadcast_menu' }]
      ]
    )
  }

  if (cb.payload.startsWith('broadcast_confirm_now:')) {
    const bid = cb.payload.slice('broadcast_confirm_now:'.length)
    await updateBroadcast(bid, {
      status: 'scheduled',
      scheduled_at: Date.now()
    })
    return sendMessageWithKeyboard(chatId,
      '✅ Рассылка запущена! Отправка начнётся в течение минуты.',
      [[{ type: 'callback', text: '🔙 Назад', data: 'broadcast_menu' }]]
    )
  }

  if (cb.payload.startsWith('broadcast_schedule_input:')) {
    const bid = cb.payload.slice('broadcast_schedule_input:'.length)
    await updateBroadcast(bid, { _schedule_pending: true })
    return sendMessageWithKeyboard(chatId,
      '📅 Введите дату и время в формате:\n\nДД.ММ.ГГГГ ЧЧ:ММ\n\nПример: 31.12.2026 18:00',
      [[{ type: 'callback', text: '🔙 Назад', data: 'broadcast_menu' }]]
    )
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


