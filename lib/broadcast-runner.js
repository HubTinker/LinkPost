// Движок рассылки «волнами»: детерминированная очередь, лимит за запуск,
// память доставок через :sent. Общий для кнопки и /process-broadcasts.
import {
  getBroadcast, updateBroadcast, getBroadcastStats,
  markSent, markDelivered, markFailed, markRunAttempted,
  getSentUsers, getRunAttempted,
  getProgressMessageId, setProgressMessageId, getStatusMessageId
} from './broadcast.js'
import {
  sendBroadcastMessage, sendMessage, editMessage, editMessageWithKeyboard, extractMessageId
} from './max-api.js'
import { getAllUsers, getUserCount, markInactive } from './storage.js'

const BATCH_DELAY = 50
const PROGRESS_INTERVAL = 15
const delay = (ms) => new Promise(r => setTimeout(r, ms))

/** Кандидаты для НОВОГО запуска: старейшие первыми; без inactive, без :sent, без run_attempted. */
export async function getEligibleUsers (b) {
  const [users, sentSet, runSet] = await Promise.all([
    getAllUsers(),
    getSentUsers(b.id),
    getRunAttempted(b.id)
  ])
  return users
    .filter(u => !u.inactive && !sentSet.has(Number(u.user_id)) && !runSet.has(Number(u.user_id)))
    .sort((a, z) => ((a.first_seen ?? 0) - (z.first_seen ?? 0)) || ((a.user_id ?? 0) - (z.user_id ?? 0)))
}

/** Доставлено в текущем запуске = scard(:sent) − точка отсчёта запуска. */
export function getRunSentCount (b, sentTotal) {
  const base = typeof b._run_sent_at_start === 'number' ? b._run_sent_at_start : sentTotal
  return Math.max(0, sentTotal - base)
}

/** Сводка для экрана «Кому отправляем?». */
export async function getRecipientCounts (b) {
  const [stats, eligible, users] = await Promise.all([
    getBroadcastStats(b.id),
    getEligibleUsers(b),
    getAllUsers()
  ])
  return { sent: stats.sent, eligible: eligible.length, inactive: users.filter(u => u.inactive).length }
}

function progressText (b, { stats, S, limit, eligibleTotal }) {
  const head = limit == null
    ? `📤 Рассылка #${b.id}: ${S} из ${Math.max(S, eligibleTotal)}`
    : `📤 Рассылка #${b.id}: ${S} / ${limit}`
  return `${head}\n✅ Получили всего: ${stats.sent}\n❌ Ошибок: ${stats.failed}`
}

async function reportProgress (b, run) {
  // Прогресс — когда батч пересёк очередную границу в 15 доставок (а не строго
  // на 15/30/…): лимит 20/10 в цепочке батчей иначе не выдал бы ни одного отчёта.
  if (run.S <= 0) return
  const startS = typeof run.startS === 'number' ? run.startS : 0
  const crossed = Math.floor(startS / PROGRESS_INTERVAL) < Math.floor(run.S / PROGRESS_INTERVAL)
  if (!crossed) return
  const chatId = b.created_by_chat_id
  if (!chatId) return
  const msg = progressText(b, run)
  const existing = await getProgressMessageId(b.id)
  if (existing) {
    editMessage(chatId, existing, msg).catch(e => console.warn('[broadcast] progress edit failed:', e.message))
  } else {
    sendMessage(chatId, msg).then(resp => {
      const mid = extractMessageId(resp)
      if (mid != null) setProgressMessageId(b.id, mid).catch(() => {})
    }).catch(e => console.warn('[broadcast] progress send failed:', e.message))
  }
}

async function finalizeBroadcast (b) {
  await updateBroadcast(b.id, { status: 'sent' })
  const stats = await getBroadcastStats(b.id)
  const S = getRunSentCount(b, stats.sent)
  const [totalUsers, users] = await Promise.all([getUserCount(), getAllUsers()])
  const inactive = users.filter(u => u.inactive).length
  const openPct = stats.sent ? Math.round((stats.opened / stats.sent) * 100) : 0
  const unsubPct = stats.sent ? Math.round((stats.unsubbed / stats.sent) * 100) : 0
  const summary = `✅ Рассылка #${b.id} завершена!\n\n` +
    `📤 Получили: ${stats.sent} (в этот запуск: ${S})\n` +
    `👁 Открыто: ${stats.opened} (${openPct}%)\n` +
    `🚫 Отписалось: ${stats.unsubbed} (${unsubPct}%)\n` +
    `❌ Ошибок: ${stats.failed}\n` +
    `🚫 Пропущено неактивных: ${inactive}\n` +
    `🗂 Всего пользователей: ${totalUsers}`
  const chatId = b.created_by_chat_id
  if (chatId) {
    await sendMessage(chatId, summary).catch(e => console.warn('[broadcast] failed to send summary to creator:', e.message))
  }
  const statusMsgId = await getStatusMessageId(b.id)
  if (statusMsgId && chatId) {
    editMessageWithKeyboard(chatId, statusMsgId,
      `✅ Рассылка #${b.id} завершена! Получили: ${stats.sent}.`,
      [[{ type: 'callback', text: '🔙 Назад', data: 'broadcast_menu' }]]
    ).catch(e => console.warn('[broadcast] status screen edit failed:', e.message))
  }
}

/**
 * Один батч рассылки (до batchSize доставок). Идемпотентен: повторный вызов
 * не доставляет дважды (run_attempted + :sent). Ставит status='sending' на время батча.
 */
export async function runBroadcastBatch (bid, batchSize = 20) {
  const b = await getBroadcast(bid)
  if (!b) return { error: 'not_found' }
  if (b.status === 'cancelled') return { done: false, stopped: true, sent: 0, failed: 0, S: 0, limit: b.limit ?? null }

  const stats = await getBroadcastStats(bid)
  const limit = b.limit ?? null
  let S = getRunSentCount(b, stats.sent)
  if (limit != null && S >= limit) return { done: true, sent: 0, failed: 0, S, limit }

  // Конкурентный guard: пока идёт батч, getScheduledBroadcasts не подхватит рассылку
  await updateBroadcast(bid, { status: 'sending' })

  const eligible = await getEligibleUsers(b)
  // Батч — фиксированное число ПОПЫТОК, а не «слоты до лимита»: упавшие доставки
  // не съедают лимит (их добирают следующими в этом же батче).
  const remaining = batchSize
  const batch = eligible.slice(0, Math.max(0, remaining))

  let sent = 0
  let failed = 0
  let runS = S
  for (const user of batch) {
    try {
      await sendBroadcastMessage(user.user_id, b)
      await markSent(bid, user.user_id)
      await markDelivered(bid, user.user_id)
      await markRunAttempted(bid, user.user_id)
      sent++
      runS++
    } catch (err) {
      console.error(`[broadcast] ${bid}: ERROR for userId=${user.user_id}: ${err.message}`)
      await markFailed(bid, user.user_id).catch(() => {})
      await markRunAttempted(bid, user.user_id).catch(() => {})
      if (err.message.includes('404') && (err.message.includes('chat.not.found') || err.message.includes('dialog.not.found'))) {
        await markInactive(user.user_id).catch(() => {})
      }
      failed++
    }
    if (limit != null && runS >= limit) break
    await delay(BATCH_DELAY)
  }

  const limitReached = limit != null && runS >= limit
  const exhausted = eligible.length <= batch.length
  const fresh = await getBroadcast(bid)
  if (fresh && fresh.status === 'cancelled') {
    return { done: false, stopped: true, sent, failed, S: runS, limit }
  }
  if (!limitReached && !exhausted) {
    await reportProgress(fresh, { stats, S: runS, startS: S, limit, eligibleTotal: eligible.length, failed })
  }
  if (limitReached || exhausted) {
    await finalizeBroadcast(fresh)
    return { done: true, sent, failed, S: runS, limit }
  }
  return { done: false, sent, failed, S: runS, limit }
}
