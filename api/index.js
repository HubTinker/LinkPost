/**
 * LinkPost Bot — Hono.js + Vercel Edge + native fetch + Vercel KV
 *
 * Маршруты:
 *   POST /webhook          — приём событий от MAX
 *   GET  /setup-webhook    — регистрация webhook (вызвать вручную 1 раз)
 */

import { Hono } from 'hono'
import { handle } from 'hono/vercel'
import { sendMessage, sendMessageWithLink, sendMessageWithKeyboard, registerWebhook, markAsRead, sendBroadcastMessage, editMessage, editMessageWithKeyboard, deleteMessage, extractMessageId, answerCallback } from '../lib/max-api.js'
import { setNavMessageId, getNavMessageId } from '../lib/nav.js'
import {
  setLink, getLink, delLink, getAllLinks, getLinksByCreator,
  updateLinkMessage, setPendingEdit, getPendingEdit, clearPendingEdit,
  saveUser, getUserCount, getAllUsers, reactivateUser, markInactive, removeUser,
  getLinkSubCount, getLinkAge, getDailyStat, getDailyTotal, getStatRange, getTotalRange, getLinkCount,
  getLinksRankedBySubs,
  daysAgo
} from '../lib/storage.js'
import {
  createBroadcast, getBroadcast, updateBroadcast, deleteBroadcast,
  getAllBroadcasts, getScheduledBroadcasts,
  markOpened, markUnsubbed,
  getBroadcastStats, isSent,
  setStatusMessageId,
  clearRunAttempted
} from '../lib/broadcast.js'
import { runBroadcastBatch, getEligibleUsers, getRunSentCount, getRecipientCounts } from '../lib/broadcast-runner.js'

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

// Колбэки, доступные не-админам (с внутренней проверкой прав)
const ALLOWED_NON_ADMIN_PAYLOADS = ['links', 'back']
const ALLOWED_NON_ADMIN_PREFIXES = ['links_page:', 'link_preview:', 'del:', 'confirm_del:', 'edit_msg:', 'edit_cancel:']

const canManage = (userId, link) => isAdmin(userId) || link?.creator_id === userId

const LINKS_PAGE_SIZE = 20

// ── Утилиты ───────────────────────────────────────────────────────────────────

/** Парсим аргументы: /command arg1 arg2 ...rest → ['arg1', 'arg2', ...] */
const parseArgs = (text = '') => text.trim().split(/\s+/).slice(1)

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

/** Терминальное сообщение команды: ряд действий + строка «Назад» */
async function sendCommandResult (chatId, text, actions = [], backData = 'back') {
  const rows = []
  if (actions.length) rows.push(actions.map(a => ({ type: 'callback', ...a })))
  rows.push([{ type: 'callback', text: '🔙 Назад', data: backData }])
  return sendMessageWithKeyboard(chatId, text, rows)
}

/** Показать список связок с пагинацией (админ — все, создатель — свои) */
async function showLinksList (chatId, userId, page = 1, editMsgId = null, useNavFallback = true) {
  const isAdminUser = isAdmin(userId)
  const all = isAdminUser ? await getAllLinks() : await getLinksByCreator(userId)

  if (!all.length) {
    const text = isAdminUser
      ? '📭 Нет активных связок. Добавьте первую через /setlink.'
      : '📭 У вас пока нет связок.'
    if (isAdminUser) {
      return renderScreen({ chatId, editMsgId, useNavFallback, text, buttons: [
        [{ type: 'callback', text: '🔙 Назад', data: 'back' }]
      ] })
    }
    return sendMessage(chatId, text)
  }

  const sorted = [...all].sort((a, b) => a.key.localeCompare(b.key))
  const totalPages = Math.ceil(sorted.length / LINKS_PAGE_SIZE)
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
  return renderScreen({ chatId, editMsgId, useNavFallback, text: out, buttons: rows })
}

const MAX_LINK_MESSAGE_DISPLAY = 3000

/** Показать карточку связки: текст, ссылка, диплинк + кнопки */
async function showLinkCard (chatId, userId, key, editMsgId = null, useNavFallback = true, notice = null) {
  const link = await getLink(key)
  if (!isAdmin(userId) && (!link || !canManage(userId, link))) {
    return sendMessage(chatId, `⛔ Ключ "${key}" не найден или у вас нет прав.`)
  }
  if (!link) return sendMessage(chatId, `❌ Ключ "${key}" не найден.`)

  const displayMessage = link.message?.length > 0
    ? (link.message.length > MAX_LINK_MESSAGE_DISPLAY ? `${link.message.slice(0, MAX_LINK_MESSAGE_DISPLAY)}...` : link.message)
    : '(нет текста)'

  const text = (notice ? `${notice}\n\n` : '') +
    `🔑 Ключ: ${key}\n\n` +
    `💬 Сообщение:\n${displayMessage}\n\n` +
    `🔗 Ссылка: ${link.url}\n\n` +
    `🔗 Диплинк: https://max.ru/${BOT_NICK}?start=${key}`

  return renderScreen({ chatId, editMsgId, useNavFallback, text, buttons: [
    [
      { type: 'callback', text: '✏️', data: `edit_msg:${key}` },
      { type: 'callback', text: '🗑 Удалить', data: `del:${key}` },
      { type: 'callback', text: '👁 Посмотреть', data: `link_preview:${key}` }
    ],
    [{ type: 'callback', text: '🔙 Назад', data: 'links' }]
  ] })
}

/** Показать админское главное меню */
async function showAdminMenu (chatId, userId, editMsgId = null, useNavFallback = true) {
  if (!isAdmin(userId)) return
  const count = await getUserCount()
  alog('DEBUG', ' showAdminMenu: показано меню для чата', chatId)
  await renderScreen({ chatId, editMsgId, useNavFallback, text:
    `👋 Привет, Админ! В базе ${count} пользователей.`,
    buttons: [
      [{ type: 'callback', text: '📋 Связки', data: 'links' },
       { type: 'callback', text: '➕ Создать', data: 'create' }],
      [{ type: 'callback', text: '👥 Пользователи', data: 'users' },
       { type: 'callback', text: '📊 Статистика', data: 'stats' }],
      [{ type: 'callback', text: '📨 Рассылка', data: 'broadcast_menu' }]
    ]
  })
}

/** Best-effort запись nav_msg: сбой KV не должен ломать UI (правка плана №1) */
async function saveNavMessageIdSafely (chatId, messageId) {
  try {
    await setNavMessageId(chatId, messageId)
  } catch (e) {
    alog('WARN', 'renderScreen: failed to save nav message id: %s', e.message)
  }
}

/**
 * Единая точка рендера навигационных экранов: правка на месте, фолбэк delete+send.
 * НЕ бросает наружу при ошибках API/KV (кроме guard непустых buttons).
 */
async function renderScreen ({ chatId, editMsgId, text, buttons, useNavFallback = true }) {
  if (!buttons?.length) throw new Error('renderScreen: buttons required')
  // target выбирается один раз: сообщение-источник, либо nav_msg (только если source
  // отсутствует и разрешён фолбэк; команды идут с useNavFallback: false — всегда новое сообщение)
  let targetId = editMsgId
  if (targetId == null && useNavFallback) {
    try {
      targetId = await getNavMessageId(chatId)
    } catch (e) {
      alog('WARN', 'renderScreen: getNavMessageId failed: %s', e.message)
    }
  }
  if (targetId != null) {
    // Критическая операция UI — edit. KV-запись выполняется ТОЛЬКО после успешного
    // edit и вне этого try, поэтому сбой KV не ломает успешную правку.
    let edited = false
    try {
      await editMessageWithKeyboard(chatId, targetId, text, buttons)
      edited = true
    } catch (e) {
      // Сюда попадаем ТОЛЬКО при неудачном edit (KV-сбой сюда не приводит)
      alog('WARN', 'renderScreen: edit failed for %s: %s', targetId, e.message)
      // Жёсткий инвариант: после ошибки edit конкретного target nav_msg не используется.
      // Удаляем ровно тот target, который пытались редактировать.
      try {
        await deleteMessage(chatId, targetId)
      } catch (de) {
        alog('WARN', 'renderScreen: delete failed for %s: %s', targetId, de.message)
      }
    }
    if (edited) {
      await saveNavMessageIdSafely(chatId, targetId)
      return { message_id: targetId }
    }
  }
  try {
    const resp = await sendMessageWithKeyboard(chatId, text, buttons)
    const respMid = extractMessageId(resp)
    if (respMid != null) await saveNavMessageIdSafely(chatId, respMid)
    return resp
  } catch (e) {
    alog('WARN', 'renderScreen: send failed: %s', e.message)
    return null
  }
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

/** Рассылка админа, ожидающая ввода числа получателей («Свой вариант») */
async function getAwaitingLimitBroadcast (userId) {
  try {
    const all = await getAllBroadcasts()
    return all.find(b => b._awaiting_limit && b.created_by === userId) || null
  } catch {
    return null
  }
}

/** Снятие pending_edit: сбой KV не должен ломать UX (флаг сам протухнет через 15 мин).
 *  Возвращает true, если флага после вызова нет (сброс удался или его не было),
 *  false — если сброс упал (WARNING уже залогирован). */
async function clearPendingEditQuietly (userId) {
  try {
    await clearPendingEdit(userId)
    return true
  } catch (e) {
    alog('WARN', 'clearPendingEdit failed for user %d: %s', userId, e.message)
    return false
  }
}

/** Старт нового запуска: лимит, точка отсчёта, сброс run-состояния (единственная точка). */
async function startBroadcastRun (bid, limit, chatId) {
  const b = await getBroadcast(bid)
  if (!b) return { error: 'not_found' }
  if (!['draft', 'sent', 'cancelled'].includes(b.status)) return { error: 'busy' }
  const stats = await getBroadcastStats(bid)
  await updateBroadcast(bid, {
    status: 'scheduled',
    scheduled_at: Date.now(),
    created_by_chat_id: chatId,
    limit,
    _awaiting_limit: false,
    _run_sent_at_start: stats.sent
  })
  await clearRunAttempted(bid)
  return { ok: true }
}

/** Экран «Кому отправляем?» */
async function showRecipientsScreen (chatId, editMsgId, b) {
  await updateBroadcast(b.id, { _awaiting_limit: false })
  const counts = await getRecipientCounts(b)
  if (counts.eligible === 0) {
    return renderScreen({ chatId, editMsgId, text:
      '📭 Нет новых получателей — все уже получили эту рассылку.',
      buttons: [[{ type: 'callback', text: '🔙 Назад', data: `broadcast_view:${b.id}` }]]
    })
  }
  return renderScreen({ chatId, editMsgId, text:
    formatBroadcastPreview(b) + '\n\n' +
    `👥 Уже получили: ${counts.sent}\n` +
    `📭 Ещё не получали: ${counts.eligible}\n` +
    `🚫 Неактивных: ${counts.inactive}\n\n` +
    'Кому отправляем?',
    buttons: [
      [
        { type: 'callback', text: '100', data: `broadcast_go:${b.id}:100` },
        { type: 'callback', text: '200', data: `broadcast_go:${b.id}:200` }
      ],
      [
        { type: 'callback', text: '500', data: `broadcast_go:${b.id}:500` },
        { type: 'callback', text: '1000', data: `broadcast_go:${b.id}:1000` }
      ],
      [
        { type: 'callback', text: '✏️ Свой вариант', data: `broadcast_custom:${b.id}` },
        { type: 'callback', text: '👥 Всем', data: `broadcast_go_all:${b.id}` }
      ],
      [{ type: 'callback', text: '🔙 Назад', data: `broadcast_view:${b.id}` }]
    ]
  })
}

/** Запуск рассылки: первый батч инлайн, экран «запущена»/«завершена», цепочка. */
async function launchBroadcast (chatId, editMsgId, bid) {
  const res = await runBroadcastBatch(bid)
  if (res.error === 'not_found') return sendMessage(chatId, '❌ Рассылка не найдена.')
  if (res.stopped) {
    return renderScreen({ chatId, editMsgId, text:
      '⏸ Рассылка была остановлена — отправка не продолжена.',
      buttons: [[{ type: 'callback', text: '🔙 Назад', data: `broadcast_view:${bid}` }]]
    })
  }
  if (res.done) {
    const stats = await getBroadcastStats(bid)
    return renderScreen({ chatId, editMsgId, text:
      `✅ Рассылка #${bid} завершена! Получили: ${stats.sent}.`,
      buttons: [[{ type: 'callback', text: '🔙 Назад', data: `broadcast_view:${bid}` }]]
    })
  }
  const launched = await renderScreen({ chatId, editMsgId, text:
    `📤 Рассылка #${bid} запущена! Отправлено ${res.S} из ${res.limit == null ? 'всех' : res.limit}.\n` +
    'ℹ️ Прогресс будет приходить каждые 15 сообщений.',
    buttons: [[{ type: 'callback', text: '🔙 Назад', data: `broadcast_view:${bid}` }]]
  })
  if (launched?.message_id) {
    try {
      await setStatusMessageId(bid, launched.message_id)
    } catch (e) {
      alog('WARN', 'broadcast %s: failed to save status message id: %s', bid, e.message)
    }
  }
  const secret = process.env.SETUP_SECRET
  if (secret) {
    await fetch(`${APP_BASE_URL}/process-broadcasts?secret=${encodeURIComponent(secret)}`)
      .then(r => r.json()).then(r => alog('INFO', 'broadcast %s: chain call result: %j', bid, r))
      .catch(e => console.warn('[broadcast] chain call failed:', e.message))
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
    await showAdminMenu(chat_id, user?.user_id, null, false)
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

  // Режим редактирования: читаем флаг ДО проверки пустого текста,
  // иначе медиа-сообщения в режиме молчат (спека §3.3, §3.5)
  let pending = null
  if (user?.user_id) {
    try {
      pending = await getPendingEdit(user.user_id)
    } catch (e) {
      alog('WARN', 'getPendingEdit failed: %s', e.message)
    }
  }

  if (!text) {
    if (pending) {
      return sendMessage(chat_id, '⚠️ Жду текстовое сообщение. Отправьте текст или нажмите «❌ Отмена».')
    }
    return
  }

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

  // ── Режим редактирования текста связки ──────────────────────────────────────
  if (pending) {
    if (text.startsWith('/')) {
      // Команда в режиме: сначала фиксируем сброс, иначе следующий текст
      // ошибочно запишется в связку; при сбое KV команду не выполняем
      try {
        await clearPendingEdit(userId)
      } catch (e) {
        alog('WARN', 'clearPendingEdit failed: %s', e.message)
        return sendMessage(chat_id, '⚠️ Не удалось сбросить режим редактирования, попробуйте ещё раз.')
      }
      await sendMessage(chat_id, '⚠️ Режим редактирования сброшен.')
      // обычный роутинг команды продолжается ниже
    } else {
      const pendingLink = await getLink(pending.key)
      if (!pendingLink) {
        await clearPendingEditQuietly(userId)
        return sendMessage(chat_id, `❌ Ключ "${pending.key}" не найден.`)
      }
      if (!canManage(userId, pendingLink)) {
        await clearPendingEditQuietly(userId)
        return sendMessage(chat_id, '⛔ Вы можете редактировать только свои ключи.')
      }
      const updated = await updateLinkMessage(pending.key, text.slice(0, 4096))
      if (!updated) {
        await clearPendingEditQuietly(userId)
        return sendMessage(chat_id, `❌ Ключ "${pending.key}" не найден.`)
      }
      const cleared = await clearPendingEditQuietly(userId)
      alog('DEBUG', ' pending_edit: key=%s updated by userId=%d', pending.key, userId)
      const notice = cleared
        ? '✅ Текст обновлён!'
        : '✅ Текст обновлён!\n⚠️ Не удалось сбросить режим редактирования, попробуйте ещё раз.'
      return showLinkCard(chat_id, userId, pending.key, null, false, notice)
    }
  }

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
      return sendCommandResult(chat_id,
        '⚠️ Формат: /setlink <ключ> <url> <сообщение>\n\n' +
        'Пример:\n/setlink vip https://max.ru/channel/xxx Добро пожаловать! 🎉'
      )
    }
    try {
      const u = new URL(url)
      if (!['http:', 'https:'].includes(u.protocol)) throw new Error()
    } catch {
      return sendCommandResult(chat_id, '⚠️ URL должен быть валидным и начинаться с http:// или https://')
    }
    if (key.length > 50) {
      return sendCommandResult(chat_id, '⚠️ Ключ слишком длинный (максимум 50 символов).')
    }
    if (url.length > 2048) {
      return sendCommandResult(chat_id, '⚠️ URL слишком длинный (максимум 2048 символов).')
    }
    const msg = rest.join(' ').slice(0, 4096)
    alog('DEBUG', ' /setlink: key=%s, url=%s, creator=%d', key, url, userId)
    await setLink(key, url, msg, userId)
    alog('DEBUG', ' /setlink: saved successfully')
    return sendCommandResult(
      chat_id,
      '✅ Связка сохранена!\n\n' +
      `🔑 Ключ: ${key}\n` +
      `🔗 Ссылка: ${url}\n` +
      `💬 Сообщение: ${msg}\n\n` +
      `Диплинк:\nhttps://max.ru/${BOT_NICK}?start=${key}`,
      [
        { text: '📋 Связки', data: 'links' },
        { text: '➕ Создать ещё', data: 'create' }
      ]
    )
  }

  if (text.startsWith('/dellink')) {
    const [key] = parseArgs(text)
    if (!key) return sendCommandResult(chat_id, '⚠️ Укажи ключ: /dellink <ключ>')
    const existing = await getLink(key)
    if (!existing) return sendCommandResult(chat_id, `❌ Ключ "${key}" не найден.`)
    if (!canManage(userId, existing)) {
      alog('DEBUG', ' /dellink: denied, key=%s, userId=%d, creator=%d', key, userId, existing.creator_id)
      return sendCommandResult(chat_id, '⛔ Вы можете удалять только свои ключи.')
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
    return showLinksList(chat_id, userId, page, null, false)
  }

  if (text === '/link' || text.startsWith('/link ')) {
    const [key] = parseArgs(text)
    if (!key) {
      return sendMessage(chat_id, '⚠️ Формат: /link <ключ>\n\nПример:\n/link vip')
    }
    return showLinkCard(chat_id, userId, key, null, false)
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

  // Broadcast flow (admin only)
  if (isAdmin(userId)) {
    // «Свой вариант»: число перехватывается у любой рассылки админа (не только черновика)
    const awaiting = await getAwaitingLimitBroadcast(userId)
    if (awaiting) {
      const n = /^\d+$/.test(text) ? Number(text) : 0
      if (n >= 1 && n <= 10000) {
        const res = await startBroadcastRun(awaiting.id, n, chat_id)
        if (res.error === 'busy') return sendMessage(chat_id, '⚠️ Сначала остановите текущую отправку.')
        if (res.error) return sendMessage(chat_id, '❌ Рассылка не найдена.')
        return launchBroadcast(chat_id, null, awaiting.id)
      }
      return sendMessage(chat_id, '⚠️ Введите число от 1 до 10000.')
    }

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
            return sendCommandResult(
              chat_id,
              `📷 Изображение добавлено (${images.length}). Отправьте ещё или нажмите «Готово».`,
              [{ text: '✅ Готово', data: `broadcast_images_done:${draft.id}` }],
              'broadcast_menu'
            )
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
            [{ type: 'callback', text: '👥 Кому отправляем', data: `broadcast_recipients:${draft.id}` }],
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
  const editMsgId = update.message?.body?.mid ?? update.message?.message_id ?? null

  // ACK: гасим спиннер MAX до любых проверок (лимит MAX — 2 ack/сек на диалог;
  // при ошибке только лог, обработка не блокируется)
  answerCallback(cb.callback_id).catch(e => alog('WARN', 'answerCallback failed: %s', e.message))

  // Любая кнопка вне edit-флоу выводит пользователя из режима редактирования
  if (!cb.payload.startsWith('edit_msg:') && !cb.payload.startsWith('edit_cancel:')) {
    await clearPendingEditQuietly(userId)
  }

  const isAllowedPayload = ALLOWED_NON_ADMIN_PAYLOADS.includes(cb.payload) ||
    ALLOWED_NON_ADMIN_PREFIXES.some(p => cb.payload.startsWith(p))
  if (!isAdmin(userId) && !isAllowedPayload) return

  // Track broadcast opens
  if (isAdmin(userId) && cb.user?.user_id) {
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
    return showLinksList(chatId, userId, 1, editMsgId)
  }

  if (cb.payload.startsWith('links_page:')) {
    const page = parseInt(cb.payload.slice('links_page:'.length), 10) || 1
    return showLinksList(chatId, userId, page, editMsgId)
  }

  if (cb.payload.startsWith('link_preview:')) {
    const key = cb.payload.slice('link_preview:'.length)
    const link = await getLink(key)
    if (!isAdmin(userId) && (!link || !canManage(userId, link))) {
      return sendMessage(chatId, `⛔ Ключ "${key}" не найден или у вас нет прав.`)
    }
    if (!link) return sendMessage(chatId, `❌ Ключ "${key}" не найден.`)
    alog('DEBUG', ' link_preview: key=%s, userId=%d', key, userId)
    return sendMessageWithLink(chatId, link.message, { label: LINK_BUTTON_LABEL, url: link.url })
  }

  if (cb.payload === 'create') {
    return renderScreen({ chatId, editMsgId, text:
      '➕ Создание связки:\n\n' +
      '/setlink <ключ> <url> <сообщение>\n\n' +
      'Пример:\n/setlink vip https://max.ru/channel/xxx Добро пожаловать! 🎉',
      buttons: [[{ type: 'callback', text: '🔙 Назад', data: 'back' }]]
    })
  }

  if (cb.payload === 'users') {
    const count = await getUserCount()
    return renderScreen({ chatId, editMsgId, text: `👥 В базе ${count} пользователей.`, buttons: [
      [{ type: 'callback', text: '🔙 Назад', data: 'back' }]
    ] })
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
    return renderScreen({ chatId, editMsgId, text:
      '📨 Рассылки\n\n' +
      `📝 Черновики: ${stats.draft}\n` +
      `⏳ Запланировано: ${stats.scheduled}\n` +
      `📤 Отправляется: ${stats.sending}\n` +
      `✅ Отправлено: ${stats.sent}\n` +
      `⏸ Отменено: ${stats.cancelled}`,
      buttons: [
        [{ type: 'callback', text: '📝 Новая рассылка', data: 'broadcast_create' }],
        [{ type: 'callback', text: '📋 Список рассылок', data: 'broadcast_list' }],
        [{ type: 'callback', text: '🧹 Очистить неактивных', data: 'broadcast_clear_stale' }],
        [{ type: 'callback', text: '🔙 Назад', data: 'back' }]
      ]
    })
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
    return renderScreen({ chatId, editMsgId, text:
      '📝 Новая рассылка (шаг 1/4)\n\n' +
      'Введите текст сообщения (поддерживается Markdown):\n\n' +
      `ID черновика: ${draft.id}`,
      buttons: [[{ type: 'callback', text: '🔙 Назад', data: 'broadcast_menu' }]]
    })
  }

  if (cb.payload === 'stats') {
    alog('DEBUG', ' callback: stats → подменю')
    return renderScreen({ chatId, editMsgId, text: '📊 Статистика\n\nВыберите раздел:', buttons: [
      [{ type: 'callback', text: '📈 Общая', data: 'stats_general' }],
      [{ type: 'callback', text: '🔑 По ключу', data: 'stats_by_key' }],
      [{ type: 'callback', text: '🏆 Топ ключей', data: 'stats_top' }],
      [{ type: 'callback', text: '📨 Рассылки', data: 'stats_broadcasts_overall' }],
      [{ type: 'callback', text: '🔙 Назад', data: 'back' }]
    ] })
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

    return renderScreen({ chatId, editMsgId, text: msg, buttons: [
      [{ type: 'callback', text: '🔙 Назад', data: 'back' }]
    ] })
  }

  if (cb.payload === 'stats_by_key') {
    alog('DEBUG', ' callback: stats_by_key → список ключей')
    const links = await getAllLinks()
    if (!links.length) {
      return renderScreen({ chatId, editMsgId, text: '📭 Нет активных связок.', buttons: [
        [{ type: 'callback', text: '🔙 Назад', data: 'back' }]
      ] })
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
    return renderScreen({ chatId, editMsgId, text: `🔑 Выберите ключ (${links.length}):`, buttons })
  }

  if (cb.payload.startsWith('stats_key:')) {
    const key = cb.payload.slice('stats_key:'.length)
    alog('DEBUG', ' callback: stats_key → key=%s', key)
    const link = await getLink(key)
    if (!link) {
      return renderScreen({ chatId, editMsgId, text: `❌ Ключ "${key}" не найден.`, buttons: [
        [{ type: 'callback', text: '🔙 К списку', data: 'stats_by_key' }]
      ] })
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

    return renderScreen({ chatId, editMsgId, text: msg, buttons: [
      [
        { type: 'callback', text: '🗑 Удалить', data: `del:${key}` },
        { type: 'callback', text: '🔙 К списку', data: 'stats_by_key' }
      ]
    ] })
  }

  if (cb.payload === 'stats_top') {
    alog('DEBUG', ' callback: stats_top → рейтинг ключей')
    const ranked = await getLinksRankedBySubs()
    if (!ranked.length) {
      return renderScreen({ chatId, editMsgId, text: '📭 Нет активных связок.', buttons: [
        [{ type: 'callback', text: '🔙 Назад', data: 'back' }]
      ] })
    }
    const top10 = ranked.slice(0, 10)
    let msg = '🏆 Топ ключей по подписчикам\n\n'
    top10.forEach((l, i) => {
      msg += `${i + 1}. 🔑 ${l.key} → 👥 ${l.subCount}\n`
    })
    return renderScreen({ chatId, editMsgId, text: msg, buttons: [
      [{ type: 'callback', text: '🔙 Назад', data: 'back' }]
    ] })
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
    return renderScreen({ chatId, editMsgId, text: msg, buttons: [
      [{ type: 'callback', text: '🔙 Назад', data: 'back' }]
    ] })
  }

  if (cb.payload.startsWith('broadcast_images_done:')) {
    const bid = cb.payload.slice('broadcast_images_done:'.length)
    await updateBroadcast(bid, { _images_done: true })
    return renderScreen({ chatId, editMsgId, text:
      '🔘 Шаг 3/4: Кнопки\n\n' +
      'Отправьте кнопки в формате:\n' +
      'Текст кнопки | https://ссылка\n\n' +
      'По одной кнопке на строку. До 5 кнопок.\n' +
      'Нажмите «Готово» чтобы пропустить.',
      buttons: [
        [{ type: 'callback', text: '✅ Готово', data: `broadcast_buttons_done:${bid}` }],
        [{ type: 'callback', text: '🔙 Назад', data: 'broadcast_menu' }]
      ]
    })
  }

  if (cb.payload.startsWith('broadcast_buttons_done:')) {
    const bid = cb.payload.slice('broadcast_buttons_done:'.length)
    const b = await getBroadcast(bid)
    if (!b) return sendMessage(chatId, '❌ Рассылка не найдена.')
    await updateBroadcast(bid, { _buttons_done: true })
    return renderScreen({ chatId, editMsgId, text:
      formatBroadcastPreview(b) + '\n\nОтправить сейчас?',
      buttons: [
        [{ type: 'callback', text: '👥 Кому отправляем', data: `broadcast_recipients:${bid}` }],
        [{ type: 'callback', text: '🔍 Тест', data: `broadcast_test:${bid}` }],
        [{ type: 'callback', text: '🔙 Назад', data: 'broadcast_menu' }]
      ]
    })
  }

  if (cb.payload.startsWith('broadcast_test:')) {
    const bid = cb.payload.slice('broadcast_test:'.length)
    const b = await getBroadcast(bid)
    if (!b) return sendMessage(chatId, '❌ Рассылка не найдена.')

    try {
      await sendBroadcastMessage(userId, b)
      alog('INFO', 'broadcast %s: test sent to admin userId=%d', bid, userId)
      return renderScreen({ chatId, editMsgId, text:
        '✅ Тестовая отправка выполнена!\n\n' + formatBroadcastPreview(b),
        buttons: [[{ type: 'callback', text: '🔙 Назад', data: 'broadcast_menu' }]]
      })
    } catch (err) {
      console.error(`[broadcast] ${bid}: test send error: ${err.message}`)
      return sendMessage(chatId, `❌ Ошибка тестовой отправки: ${err.message}`)
    }
  }

  if (cb.payload.startsWith('broadcast_recipients:')) {
    const bid = cb.payload.slice('broadcast_recipients:'.length)
    const b = await getBroadcast(bid)
    if (!b) return sendMessage(chatId, '❌ Рассылка не найдена.')
    return showRecipientsScreen(chatId, editMsgId, b)
  }

  if (cb.payload.startsWith('broadcast_go:')) {
    const rest = cb.payload.slice('broadcast_go:'.length)
    const [bid, nStr] = rest.split(':')
    if (!bid || !nStr) return sendMessage(chatId, '❌ Неверный выбор.')
    const n = Number(nStr)
    if (!Number.isInteger(n) || n < 1) return sendMessage(chatId, '❌ Неверный выбор.')
    const res = await startBroadcastRun(bid, Math.floor(n), chatId)
    if (res.error === 'busy') return sendMessage(chatId, '⚠️ Сначала остановите текущую отправку.')
    if (res.error) return sendMessage(chatId, '❌ Рассылка не найдена.')
    return launchBroadcast(chatId, editMsgId, bid)
  }

  if (cb.payload.startsWith('broadcast_go_all:')) {
    const bid = cb.payload.slice('broadcast_go_all:'.length)
    const res = await startBroadcastRun(bid, null, chatId)
    if (res.error === 'busy') return sendMessage(chatId, '⚠️ Сначала остановите текущую отправку.')
    if (res.error) return sendMessage(chatId, '❌ Рассылка не найдена.')
    return launchBroadcast(chatId, editMsgId, bid)
  }

  if (cb.payload.startsWith('broadcast_custom:')) {
    const bid = cb.payload.slice('broadcast_custom:'.length)
    const b = await getBroadcast(bid)
    if (!b) return sendMessage(chatId, '❌ Рассылка не найдена.')
    const all = await getAllBroadcasts()
    for (const other of all) {
      if (other._awaiting_limit && other.id !== bid) {
        await updateBroadcast(other.id, { _awaiting_limit: false }).catch(() => {})
      }
    }
    await updateBroadcast(bid, { _awaiting_limit: true })
    return renderScreen({ chatId, editMsgId, text:
      '✏️ Введите число получателей (1–10000):',
      buttons: [[{ type: 'callback', text: '🔙 Назад', data: `broadcast_view:${bid}` }]]
    })
  }

  if (cb.payload === 'broadcast_list') {
    const broadcasts = await getAllBroadcasts()
    if (!broadcasts.length) {
      return renderScreen({ chatId, editMsgId, text: '📭 Нет рассылок.', buttons: [
        [{ type: 'callback', text: '🔙 Назад', data: 'broadcast_menu' }]
      ] })
    }
    const buttons = broadcasts.slice(0, 10).map(b => [
      { type: 'callback', text: `${statusEmoji(b.status)} ${b.id}`, data: `broadcast_view:${b.id}` }
    ])
    buttons.push([{ type: 'callback', text: '🔙 Назад', data: 'broadcast_menu' }])
    return renderScreen({ chatId, editMsgId, text: '📋 Рассылки:', buttons })
  }

  if (cb.payload.startsWith('broadcast_view:')) {
    const bid = cb.payload.slice('broadcast_view:'.length)
    let b = await getBroadcast(bid)
    if (!b) return sendMessage(chatId, '❌ Рассылка не найдена.')
    if (b._awaiting_limit) {
      await updateBroadcast(bid, { _awaiting_limit: false })
      b = await getBroadcast(bid)
    }

    let detail = formatBroadcastDetail(b)
    if (b.status === 'scheduled' || b.status === 'sending') {
      const stats = await getBroadcastStats(bid)
      const S = getRunSentCount(b, stats.sent)
      const eligible = await getEligibleUsers(b)
      detail += b.limit == null
        ? `📤 Запуск: ${S} из ${S + eligible.length}\n`
        : `📤 Запуск: ${S} / ${b.limit}\n`
      detail += `✅ Получили всего: ${stats.sent} | ❌ Ошибок: ${stats.failed}\n`
    }

    const btnRows = []
    if (b.status === 'draft') {
      btnRows.push([{ type: 'callback', text: '✏️ Редактировать', data: `broadcast_edit:${bid}` }])
      btnRows.push([{ type: 'callback', text: '▶️ Запустить', data: `broadcast_recipients:${bid}` }])
    }
    if (b.status === 'scheduled' || b.status === 'sending') {
      btnRows.push([{ type: 'callback', text: '⏸ Остановить', data: `broadcast_stop:${bid}` }])
    }
    if (b.status === 'cancelled') {
      btnRows.push([{ type: 'callback', text: '▶️ Возобновить', data: `broadcast_resume:${bid}` }])
      btnRows.push([{ type: 'callback', text: '📤 Разослать ещё', data: `broadcast_recipients:${bid}` }])
    }
    if (b.status === 'sent') {
      btnRows.push([{ type: 'callback', text: '📤 Разослать ещё', data: `broadcast_recipients:${bid}` }])
    }
    btnRows.push([{ type: 'callback', text: '📊 Статистика', data: `broadcast_stats:${bid}` }])
    btnRows.push([{ type: 'callback', text: '🗑 Удалить', data: `broadcast_delete:${bid}` }])
    btnRows.push([{ type: 'callback', text: '🔙 К списку', data: 'broadcast_list' }])

    return renderScreen({ chatId, editMsgId, text: detail, buttons: btnRows })
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
    msg += `📤 В этот запуск: ${getRunSentCount(b, stats.sent)} (лимит: ${b.limit ?? 'все'})\n`
    msg += `👁 Открыто:       ${stats.opened} (${openPct}%)\n`
    msg += `🚫 Отписалось:    ${stats.unsubbed} (${unsubPct}%)\n`

    return renderScreen({ chatId, editMsgId, text: msg, buttons: [
      [{ type: 'callback', text: '🔙 Назад', data: `broadcast_view:${bid}` }]
    ] })
  }

  if (cb.payload.startsWith('broadcast_delete:')) {
    const bid = cb.payload.slice('broadcast_delete:'.length)
    return renderScreen({ chatId, editMsgId, text:
      `🗑 Удалить рассылку #${bid}?`,
      buttons: [
        [
          { type: 'callback', text: '✅ Да', data: `broadcast_delete_confirm:${bid}` },
          { type: 'callback', text: '❌ Нет', data: `broadcast_view:${bid}` }
        ]
      ]
    })
  }

  if (cb.payload.startsWith('broadcast_delete_confirm:')) {
    const bid = cb.payload.slice('broadcast_delete_confirm:'.length)
    await deleteBroadcast(bid)
    alog('DEBUG', 'broadcast_delete_confirm: deleted %s', bid)
    return renderScreen({ chatId, editMsgId, text: `🗑 Рассылка #${bid} удалена.`, buttons: [
      [{ type: 'callback', text: '🔙 К списку', data: 'broadcast_list' }]
    ] })
  }

  if (cb.payload.startsWith('broadcast_stop:')) {
    const bid = cb.payload.slice('broadcast_stop:'.length)
    await updateBroadcast(bid, { status: 'cancelled', scheduled_at: null })
    alog('DEBUG', 'broadcast_stop: stopped %s', bid)
    return renderScreen({ chatId, editMsgId, text: `⏸ Рассылка #${bid} остановлена.`, buttons: [
      [{ type: 'callback', text: '🔙 Назад', data: `broadcast_view:${bid}` }]
    ] })
  }

  if (cb.payload.startsWith('broadcast_resume:')) {
    const bid = cb.payload.slice('broadcast_resume:'.length)
    await updateBroadcast(bid, { status: 'scheduled', scheduled_at: Date.now() })
    alog('DEBUG', 'broadcast_resume: resumed %s', bid)
    return renderScreen({ chatId, editMsgId, text: `▶️ Рассылка #${bid} возобновлена.`, buttons: [
      [{ type: 'callback', text: '🔙 Назад', data: `broadcast_view:${bid}` }]
    ] })
  }

  if (cb.payload.startsWith('broadcast_edit:')) {
    const bid = cb.payload.slice('broadcast_edit:'.length)
    const b = await getBroadcast(bid)
    if (!b) return sendMessage(chatId, '❌ Рассылка не найдена.')
    if (b.status !== 'draft') {
      return sendMessage(chatId, '⚠️ Редактировать можно только черновики.')
    }
    await updateBroadcast(bid, { text: '', _images_done: false, _buttons_done: false, images: [], buttons: [] })
    return renderScreen({ chatId, editMsgId, text:
      '📝 Редактирование (шаг 1/4)\n\n' +
      'Введите новый текст сообщения:\n\n' +
      `ID: ${bid}`,
      buttons: [[{ type: 'callback', text: '🔙 Назад', data: `broadcast_view:${bid}` }]]
    })
  }

  if (cb.payload === 'broadcast_clear_stale') {
    const all = await getAllUsers()
    const stale = all.filter(u => u.inactive)
    if (!stale.length) {
      return renderScreen({ chatId, editMsgId, text: '✅ Нет неактивных пользователей для очистки.', buttons: [
        [{ type: 'callback', text: '🔙 Назад', data: 'broadcast_menu' }]
      ] })
    }
    const count = stale.length
    for (const u of stale) {
      await removeUser(u.user_id).catch(() => {})
    }
    alog('INFO', 'broadcast_clear_stale: removed %d inactive users', count)
    return renderScreen({ chatId, editMsgId, text:
      `🧹 Удалено ${count} неактивных пользователей из базы.`,
      buttons: [[{ type: 'callback', text: '🔙 Назад', data: 'broadcast_menu' }]]
    })
  }

  if (cb.payload === 'back') {
    alog('DEBUG', ' callback: back → главное меню')
    if (!isAdmin(userId)) {
      return sendMessage(chatId, 'Используйте /links для просмотра ваших связок.')
    }
    return showAdminMenu(chatId, userId, editMsgId)
  }

  if (cb.payload.startsWith('edit_msg:')) {
    const key = cb.payload.slice('edit_msg:'.length)
    const link = await getLink(key)
    if (!isAdmin(userId) && (!link || !canManage(userId, link))) {
      alog('DEBUG', ' edit_msg: denied, key=%s, userId=%d', key, userId)
      return sendMessage(chatId, `⛔ Ключ "${key}" не найден или у вас нет прав.`)
    }
    if (!link) return sendMessage(chatId, `❌ Ключ "${key}" не найден.`)

    // Взаимоисключение: режим «Свой вариант» рассылки не должен жить вместе с pending_edit
    try {
      const awaiting = await getAwaitingLimitBroadcast(userId)
      if (awaiting) await updateBroadcast(awaiting.id, { _awaiting_limit: false })
    } catch (e) {
      alog('WARN', 'edit_msg: failed to clear _awaiting_limit: %s', e.message)
    }

    try {
      await setPendingEdit(userId, key, chatId)
    } catch (e) {
      alog('WARN', 'edit_msg: setPendingEdit failed: %s', e.message)
      return sendMessage(chatId, '❌ Не удалось начать редактирование, попробуйте ещё раз.')
    }
    alog('DEBUG', ' edit_msg: pending set, key=%s, userId=%d', key, userId)
    return renderScreen({ chatId, editMsgId, text:
      `✏️ Редактирование текста «${key}»\n\n` +
      'Пришлите новый текст сообщения.\n' +
      'Ограничение: 4096 символов.\n' +
      'Ссылка и ключ не изменятся.',
      buttons: [
        [{ type: 'callback', text: '❌ Отмена', data: `edit_cancel:${key}` }]
      ]
    })
  }

  if (cb.payload.startsWith('edit_cancel:')) {
    const key = cb.payload.slice('edit_cancel:'.length)
    const cleared = await clearPendingEditQuietly(userId)
    alog('DEBUG', ' edit_cancel: pending cleared, key=%s, userId=%d', key, userId)
    const notice = cleared ? null : '⚠️ Не удалось сбросить режим редактирования, попробуйте ещё раз.'
    return showLinkCard(chatId, userId, key, editMsgId, true, notice)
  }

  if (cb.payload.startsWith('del:')) {
    const key = cb.payload.slice(4)
    const existing = await getLink(key)
    if (!isAdmin(userId) && (!existing || !canManage(userId, existing))) {
      alog('DEBUG', ' del: denied, key=%s, userId=%d', key, userId)
      return sendMessage(chatId, `⛔ Ключ "${key}" не найден или у вас нет прав.`)
    }
    if (!existing) return sendMessage(chatId, `❌ Ключ "${key}" не найден.`)
    alog('DEBUG', ' del: confirmation requested for key=%s, userId=%d', key, userId)
    return renderScreen({ chatId, editMsgId, text:
      `🗑 Удалить связку "${key}"?\n\n🔗 ${existing.url}\n\n💬 ${existing.message}`,
      buttons: [
        [
          { type: 'callback', text: '✅ Да, удалить', data: `confirm_del:${key}` },
          { type: 'callback', text: '❌ Нет', data: 'links' }
        ]
      ]
    })
  }

  if (cb.payload.startsWith('confirm_del:')) {
    const key = cb.payload.slice('confirm_del:'.length)
    const existing = await getLink(key)
    if (!isAdmin(userId) && (!existing || !canManage(userId, existing))) {
      alog('DEBUG', ' confirm_del: denied, key=%s, userId=%d', key, userId)
      return sendMessage(chatId, `⛔ Ключ "${key}" не найден или у вас нет прав.`)
    }
    if (!existing) return sendMessage(chatId, `❌ Ключ "${key}" не найден.`)
    alog('DEBUG', ' confirm_del: deleted key=%s by userId=%d', key, userId)
    await delLink(key)
    return renderScreen({ chatId, editMsgId, text: `✅ Связка "${key}" удалена.`, buttons: [
      [{ type: 'callback', text: '🔙 К списку', data: 'links' }]
    ] })
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

/** Общий шаг обработки одной рассылки для /process-broadcasts и cron. */
async function processScheduledBroadcast (b, { continueChain = false, host = null, scheme = 'https', secret = null } = {}) {
  const res = await runBroadcastBatch(b.id)
  if (res.error || res.stopped || res.done) return res
  const fresh = await getBroadcast(b.id)
  if (fresh && fresh.status === 'cancelled') return { ...res, stopped: true }
  await updateBroadcast(b.id, { status: 'scheduled', scheduled_at: Date.now() + 1000 })
  if (continueChain && host && secret) {
    await fetch(`${scheme}://${host}/process-broadcasts?secret=${encodeURIComponent(secret)}`)
      .then(r => r.json()).then(r => alog('INFO', 'broadcast %s: chain call result: %j', b.id, r))
      .catch(e => console.warn('[broadcast] chain call failed:', e.message))
  }
  return res
}

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
  for (const b of broadcasts) {
    try {
      const res = await processScheduledBroadcast(b, {
        continueChain: true,
        host: c.req.header('host'),
        scheme: c.req.header('x-forwarded-proto') || 'https',
        secret
      })
      results.push({ id: b.id, sent: res.sent ?? 0, failed: res.failed ?? 0, S: res.S ?? 0, done: !!res.done })
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
  for (const b of broadcasts) {
    try {
      const res = await processScheduledBroadcast(b)
      results.push({ id: b.id, sent: res.sent ?? 0, failed: res.failed ?? 0, S: res.S ?? 0, done: !!res.done })
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

export { app, handleBotStarted, handleMessage, handleCallbackQuery, renderScreen }


