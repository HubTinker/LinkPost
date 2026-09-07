# Broadcast Waves — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Добавить лимит получателей рассылки (100/200/500/1000/свой ввод/«Всем»), память доставок в рамках рассылки и повторные «волны» только для не получивших.

**Architecture:** Рассылка переходит с курсора-индекса на детерминированную очередь: движок (`lib/broadcast-runner.js`) на каждом батче пересчитывает список кандидатов (старейшие по `first_seen`, исключая `:sent`, `inactive`, `run_attempted`). Лимит отсчитывается через `scard(:sent) − _run_sent_at_start`. Оба пути отправки (кнопка и `/process-broadcasts`) используют один движок.

**Tech Stack:** Node.js ≥18, ES Modules, Hono, @vercel/kv, в тестах — `lib/kv-mock.js` + стаб `global.fetch`.

## Global Constraints

- Все тексты UI — на русском, в стиле существующих сообщений бота.
- Новых зависимостей не добавляем.
- `npm test` = `node --test test/*.test.js` (eslint нет).
- `updateBroadcast` белый список полей — изменяется ТОЛЬКО в Task 1.
- Единственная точка сброса run-состояния — `clearRunAttempted` при явном старте админом (не на хопах цепочки, не при stop/resume).
- Имена payload'ов callback: `broadcast_recipients:<bid>`, `broadcast_go:<bid>:<n>`, `broadcast_go_all:<bid>`, `broadcast_custom:<bid>`.
- Спека: `docs/superpowers/specs/2026-09-07-broadcast-waves-design.md`.

---

### Task 1: Run-состояние в хранилище

**Files:**
- Modify: `lib/broadcast.js`
- Test: `test/broadcast.test.js`

**Interfaces:**
- Produces: `markRunAttempted(bid, userId) → sadd`, `getRunAttempted(bid) → Promise<Set<number>>`, `clearRunAttempted(bid) → del`, `getSentUsers(bid) → Promise<Set<number>>`; whitelist `updateBroadcast` += `limit`, `_awaiting_limit`, `_run_sent_at_start`; суффикс `RUN_ATTEMPTED_SUFFIX = ':run_attempted'`.

- [ ] **Step 1: Добавить тест (красный)**

В `test/broadcast.test.js` в импорты (строки 4–10) добавить `markRunAttempted, getRunAttempted, clearRunAttempted, getSentUsers`. В конец файла:

```js
describe('Broadcast run tracking', () => {
  beforeEach(async () => {
    await kv._clear()
  })

  it('should mark and read run attempted users', async () => {
    const b = await createBroadcast({ text: 'Run', created_by: 123 })
    await markRunAttempted(b.id, 100)
    await markRunAttempted(b.id, 200)
    const attempted = await getRunAttempted(b.id)
    assert.ok(attempted.has(100))
    assert.ok(attempted.has(200))
    assert.strictEqual(attempted.has(300), false)
  })

  it('should clear run attempted', async () => {
    const b = await createBroadcast({ text: 'Run', created_by: 123 })
    await markRunAttempted(b.id, 100)
    await clearRunAttempted(b.id)
    assert.strictEqual((await getRunAttempted(b.id)).size, 0)
  })

  it('should delete run_attempted on deleteBroadcast', async () => {
    const b = await createBroadcast({ text: 'Run', created_by: 123 })
    await markRunAttempted(b.id, 100)
    await deleteBroadcast(b.id)
    assert.strictEqual((await kv.smembers(`broadcast:${b.id}:run_attempted`)).length, 0)
  })

  it('should clear run_attempted on resetBroadcastStats', async () => {
    const b = await createBroadcast({ text: 'Run', created_by: 123 })
    await markRunAttempted(b.id, 100)
    await resetBroadcastStats(b.id)
    assert.strictEqual((await kv.smembers(`broadcast:${b.id}:run_attempted`)).length, 0)
  })

  it('should persist new fields via updateBroadcast', async () => {
    const b = await createBroadcast({ text: 'Run', created_by: 123 })
    await updateBroadcast(b.id, { limit: 100, _awaiting_limit: true, _run_sent_at_start: 5 })
    const updated = await getBroadcast(b.id)
    assert.strictEqual(updated.limit, 100)
    assert.strictEqual(updated._awaiting_limit, true)
    assert.strictEqual(updated._run_sent_at_start, 5)
  })
})
```

- [ ] **Step 2: Запустить и убедиться, что падает**

Run: `node --test test/broadcast.test.js`
Expected: `ReferenceError: markRunAttempted is not defined`

- [ ] **Step 3: Реализовать**

В `lib/broadcast.js`:
1. После `CURSOR_SUFFIX` (строка 10) добавить:
```js
const RUN_ATTEMPTED_SUFFIX = ':run_attempted'
```
2. В `updateBroadcast` (строка 67) разрешить новые поля:
```js
const allowed = ['title', 'text', 'images', 'buttons', 'format', 'status', 'scheduled_at', '_images_done', '_buttons_done', 'created_by_chat_id', 'limit', '_awaiting_limit', '_run_sent_at_start']
```
3. После `markFailed` (строка 155) добавить:
```js
export async function markRunAttempted (broadcastId, userId) {
  const kv = await getKv()
  return kv.sadd(`${BR_PREFIX}${broadcastId}${RUN_ATTEMPTED_SUFFIX}`, String(userId))
}

export async function getRunAttempted (broadcastId) {
  const kv = await getKv()
  const ids = await kv.smembers(`${BR_PREFIX}${broadcastId}${RUN_ATTEMPTED_SUFFIX}`)
  return new Set(ids.map(Number))
}

export async function clearRunAttempted (broadcastId) {
  const kv = await getKv()
  await kv.del(`${BR_PREFIX}${broadcastId}${RUN_ATTEMPTED_SUFFIX}`)
}

export async function getSentUsers (broadcastId) {
  const kv = await getKv()
  const ids = await kv.smembers(`${BR_PREFIX}${broadcastId}${SENT_SUFFIX}`)
  return new Set(ids.map(Number))
}
```
4. В `deleteBroadcast` массив `keys` (строки 86–96) добавить строку:
```js
    `${BR_PREFIX}${id}${RUN_ATTEMPTED_SUFFIX}`,
```
5. В `resetBroadcastStats` (строка 211) в `Promise.all` добавить:
```js
    kv.del(`${prefix}${RUN_ATTEMPTED_SUFFIX}`),
```

- [ ] **Step 4: Запустить и убедиться, что проходит**

Run: `node --test test/broadcast.test.js`
Expected: PASS (все describe, включая старые)

- [ ] **Step 5: Commit**

```bash
git add lib/broadcast.js test/broadcast.test.js
git commit -m "Add run attempt tracking to broadcast storage"
```

---

### Task 2: Движок рассылки волнами

**Files:**
- Create: `lib/broadcast-runner.js`
- Test: `test/broadcast-runner.test.js`

**Interfaces:**
- Consumes: Task 1 (`getSentUsers`, `markRunAttempted`, `getRunAttempted`, `clearRunAttempted` не обязателен здесь), `lib/storage.js` (`getAllUsers`, `getUserCount`, `markInactive`), `lib/max-api.js` (`sendBroadcastMessage`, `sendMessage`, `editMessage`, `editMessageWithKeyboard`, `extractMessageId`).
- Produces: `runBroadcastBatch(bid, batchSize = 20) → { error? | done:boolean, stopped?:boolean, sent:number, failed:number, S:number, limit:number|null }`; `getEligibleUsers(b) → Promise<Array<user>>` (отсортированы); `getRunSentCount(b, sentTotal) → number`; `getRecipientCounts(b) → Promise<{sent, eligible, inactive}>`.
- Семантика: `status='sending'` в начале батча; при завершении — `status='sent'` + итог админу + правка status-сообщения; при `cancelled` — `{stopped:true}` без финализации; прогресс каждые 15 доставок, только пока запуск продолжается.

- [ ] **Step 1: Написать тесты (красные)**

Создать `test/broadcast-runner.test.js` (шаблон стаба fetch — как в `test/handler.test.js:8-18`):

```js
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.BOT_TOKEN = 'test-token'

let fetchCalls
global.fetch = async (url, opts) => {
  if (!fetchCalls) fetchCalls = []
  fetchCalls.push({ url: String(url), method: opts?.method || 'GET', body: JSON.parse(opts?.body || '{}') })
  return {
    ok: true,
    json: async () => ({ ok: true, message: { body: { mid: 999 } } }),
    text: async () => '',
    status: 200
  }
}

const { kv } = await import('../lib/kv-mock.js')
const { createBroadcast, updateBroadcast, markSent, markFailed, isSent, getBroadcastStats, clearRunAttempted } = await import('../lib/broadcast.js')
const { runBroadcastBatch, getEligibleUsers, getRunSentCount } = await import('../lib/broadcast-runner.js')

async function seedUsers (specs) {
  for (const s of specs) {
    await kv.sadd('users_all', String(s.id))
    await kv.set(`user:${s.id}`, { user_id: s.id, first_seen: s.first_seen, inactive: s.inactive ?? false })
  }
}

/** Имитация старта запуска админом (аналог startBroadcastRun в api/index.js) */
async function startRun (b, limit) {
  const stats = await getBroadcastStats(b.id)
  await updateBroadcast(b.id, { status: 'scheduled', scheduled_at: Date.now(), created_by_chat_id: 1, limit, _run_sent_at_start: stats.sent })
  await clearRunAttempted(b.id)
}

describe('getEligibleUsers', () => {
  beforeEach(async () => { await kv._clear(); fetchCalls = [] })

  it('should order by first_seen asc, undefined first, tie-break by user_id', async () => {
    await seedUsers([
      { id: 5, first_seen: 300 },
      { id: 2, first_seen: undefined },
      { id: 3, first_seen: 100 },
      { id: 1, first_seen: 100 }
    ])
    const b = await createBroadcast({ text: 'Order', created_by: 123 })
    const eligible = await getEligibleUsers(b)
    assert.deepStrictEqual(eligible.map(u => u.user_id), [2, 1, 3, 5])
  })

  it('should exclude sent, inactive and run-attempted; include previously failed', async () => {
    await seedUsers([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }])
    const b = await createBroadcast({ text: 'Filter', created_by: 123 })
    await markSent(b.id, 1)
    await markFailed(b.id, 2) // упал в прошлом запуске → кандидат (вариант Y)
    await kv.sadd(`broadcast:${b.id}:run_attempted`, '3')
    await kv.set('user:4', { user_id: 4, inactive: true })
    const eligible = await getEligibleUsers(b)
    assert.deepStrictEqual(eligible.map(u => u.user_id), [2])
  })
})

describe('runBroadcastBatch', () => {
  beforeEach(async () => { await kv._clear(); fetchCalls = [] })

  it('should stop at limit and not over-send', async () => {
    await seedUsers([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }])
    const b = await createBroadcast({ text: 'Limit', created_by: 123 })
    await startRun(b, 2)
    const res = await runBroadcastBatch(b.id, 3)
    assert.strictEqual(res.done, true)
    assert.strictEqual(res.sent, 2)
    assert.strictEqual(res.S, 2)
    const ids = fetchCalls.filter(c => c.url.includes('/messages?user_id=')).map(c => c.url.split('user_id=')[1])
    assert.deepStrictEqual(ids, ['1', '2'])
  })

  it('should not count failures against the limit', async () => {
    await seedUsers([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }])
    const original = global.fetch
    global.fetch = async (url, opts) => {
      if (String(url).includes('user_id=1')) throw new Error('MAX API error 500: boom')
      return original(url, opts)
    }
    try {
      const b = await createBroadcast({ text: 'Fail', created_by: 123 })
      await startRun(b, 2)
      const res = await runBroadcastBatch(b.id, 3)
      assert.strictEqual(res.sent, 2)
      assert.strictEqual(res.failed, 1)
      assert.strictEqual(res.done, true)
      assert.ok(await isSent(b.id, 2))
      assert.ok(await isSent(b.id, 3))
      assert.ok(!(await isSent(b.id, 1)))
    } finally {
      global.fetch = original
    }
  })

  it('should retry previous-run failures in a new run (variant Y)', async () => {
    await seedUsers([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }])
    const original = global.fetch
    global.fetch = async (url, opts) => {
      if (String(url).includes('user_id=1')) throw new Error('MAX API error 500: boom')
      return original(url, opts)
    }
    let b
    try {
      b = await createBroadcast({ text: 'Retry', created_by: 123 })
      await startRun(b, 2)
      const run1 = await runBroadcastBatch(b.id, 3)
      assert.strictEqual(run1.sent, 2)
      assert.strictEqual(run1.done, true)
    } finally {
      global.fetch = original
    }
    await startRun(b, 2)
    const run2 = await runBroadcastBatch(b.id, 3)
    assert.strictEqual(run2.sent, 2) // user 1 (повтор) и user 4
    assert.ok(await isSent(b.id, 1), 'previous-run failure should be retried and delivered')
    assert.ok(await isSent(b.id, 4))
  })

  it('should send to all eligible when limit is null (multi-batch chain)', async () => {
    await seedUsers([{ id: 1 }, { id: 2 }, { id: 3 }])
    const b = await createBroadcast({ text: 'All', created_by: 123 })
    await startRun(b, null)
    const res1 = await runBroadcastBatch(b.id, 2)
    assert.strictEqual(res1.done, false)
    assert.strictEqual(res1.sent, 2)
    await updateBroadcast(b.id, { status: 'scheduled', scheduled_at: Date.now() + 1000 })
    const res2 = await runBroadcastBatch(b.id, 2)
    assert.strictEqual(res2.done, true)
    assert.strictEqual(res2.sent, 1)
    const ids = fetchCalls.filter(c => c.url.includes('/messages?user_id=')).map(c => c.url.split('user_id=')[1])
    assert.strictEqual(new Set(ids).size, 3, 'no duplicate sends across chain hops')
  })

  it('should fall back to current sent count when _run_sent_at_start is missing', async () => {
    await seedUsers([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }])
    const b = await createBroadcast({ text: 'Fallback', created_by: 123 })
    await markSent(b.id, 1)
    await markSent(b.id, 2)
    // старый формат записи: лимит есть, точки отсчёта нет
    await updateBroadcast(b.id, { status: 'scheduled', scheduled_at: Date.now(), limit: 5 })
    const res = await runBroadcastBatch(b.id, 1)
    assert.strictEqual(res.S, 1) // базой стал текущий scard(:sent)=2
    assert.strictEqual(res.done, false)
  })

  it('should not run when cancelled (stopped flag)', async () => {
    await seedUsers([{ id: 1 }, { id: 2 }, { id: 3 }])
    const b = await createBroadcast({ text: 'Stop', created_by: 123 })
    await startRun(b, 5)
    await updateBroadcast(b.id, { status: 'cancelled' })
    const res = await runBroadcastBatch(b.id, 2)
    assert.strictEqual(res.stopped, true)
    assert.strictEqual(res.sent, 0)
  })

  it('should send progress every 15 and a summary on completion', async () => {
    const users = Array.from({ length: 30 }, (_, i) => ({ id: i + 1 }))
    await seedUsers(users)
    const b = await createBroadcast({ text: 'Progress', created_by: 123 })
    await startRun(b, null)
    const res1 = await runBroadcastBatch(b.id, 20)
    assert.strictEqual(res1.done, false)
    await updateBroadcast(b.id, { status: 'scheduled', scheduled_at: Date.now() + 1000 })
    const res2 = await runBroadcastBatch(b.id, 20)
    assert.strictEqual(res2.done, true)
    const progressMsgs = fetchCalls.filter(c => c.body?.text && c.body.text.includes('📤 Рассылка'))
    assert.ok(progressMsgs.length >= 1, 'progress message expected')
    const summary = fetchCalls.find(c => c.body?.text && c.body.text.includes('завершена'))
    assert.ok(summary, 'summary should be sent')
    assert.ok(summary.body.text.includes('в этот запуск: 30'))
    const bFinal = await (await import('../lib/broadcast.js')).getBroadcast(b.id)
    assert.strictEqual(bFinal.status, 'sent')
  })
})

describe('getRunSentCount', () => {
  it('should compute run sent count from _run_sent_at_start', () => {
    assert.strictEqual(getRunSentCount({ _run_sent_at_start: 10 }, 13), 3)
    assert.strictEqual(getRunSentCount({}, 7), 0)
  })
})
```

- [ ] **Step 2: Убедиться, что падает**

Run: `node --test test/broadcast-runner.test.js`
Expected: `ERR_MODULE_NOT_FOUND` для `../lib/broadcast-runner.js`

- [ ] **Step 3: Реализовать `lib/broadcast-runner.js`**

```js
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
  if (run.S <= 0 || run.S % PROGRESS_INTERVAL !== 0) return
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
  const remaining = limit == null ? batchSize : Math.min(batchSize, limit - S)
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
    await reportProgress(fresh, { stats, S: runS, limit, eligibleTotal: eligible.length, failed })
  }
  if (limitReached || exhausted) {
    await finalizeBroadcast(fresh)
    return { done: true, sent, failed, S: runS, limit }
  }
  return { done: false, sent, failed, S: runS, limit }
}
```

- [ ] **Step 4: Запустить и убедиться, что проходит**

Run: `node --test test/broadcast-runner.test.js`
Expected: PASS (8 it-блоков). Если тест Y-повтора нестабилен — упростите по примечанию ниже.

- [ ] **Step 5: Прогнать весь набор старых тестов (регрессия)**

Run: `npm test`
Expected: PASS (старые тесты не затронуты — api ещё на старом движке)

- [ ] **Step 6: Commit**

```bash
git add lib/broadcast-runner.js test/broadcast-runner.test.js
git commit -m "Add wave broadcast runner engine"
```

---

### Task 3: UI выбора получателей, «Свой вариант», кнопки деталей

**Files:**
- Modify: `api/index.js` (импорты ~L20-27; helpers ~L253-260; handleMessage ~L469-545; callback-обработчики: L795-824 кнопки, L844-1001 restart+confirm_now заменить, L1017-1055 view, L1057-1078 stats)
- Test: `test/handler.test.js`

**Interfaces:**
- Consumes: Task 2 (`runBroadcastBatch`, `getEligibleUsers`, `getRunSentCount`, `getRecipientCounts`), Task 1 (`clearRunAttempted`).
- Produces: payloads `broadcast_recipients:<bid>`, `broadcast_go:<bid>:<n>`, `broadcast_go_all:<bid>`, `broadcast_custom:<bid>`; хелперы `getAwaitingLimitBroadcast(userId)`, `startBroadcastRun(bid, limit, chatId)`, `showRecipientsScreen(chatId, editMsgId, b)`, `launchBroadcast(chatId, editMsgId, bid)`; удаляются `broadcast_confirm_now` и `broadcast_restart`.

- [ ] **Step 1: Написать тесты (красные)**

В `test/handler.test.js`:
1. Поднять `seedUsers` из describe `'broadcast status screen'` (строки 1287–1292) на уровень модуля (сразу после импортов, до `describe('handleMessage guard')`).
2. В describe `'broadcast status screen'` заменить payload `broadcast_confirm_now:${b.id}` на `broadcast_go_all:${b.id}` (2 места: ~L1299 и ~L1317).
3. Заменить describe `'broadcast_restart callback'` (начинается ~L1090) на:

```js
describe('broadcast recipients flow', () => {
  beforeEach(() => {
    fetchCalls = []
    kv._clear()
  })

  it('should show recipient counts and preset buttons', async () => {
    await seedUsers([{ id: 1 }, { id: 2 }])
    const b = await createBroadcast({ text: 'Wave', created_by: 123 })
    await handleCallbackQuery({
      callback: { payload: `broadcast_recipients:${b.id}`, user: { user_id: 123 } },
      message: { recipient: { chat_id: 1 }, body: { mid: 90 } }
    })
    const screen = fetchCalls.find(c => c.method === 'PUT' && c.url.includes('message_id=90'))
    assert.ok(screen?.body?.text?.includes('Кому отправляем?'))
    assert.ok(screen.body.text.includes('📭 Ещё не получали: 2'))
  })

  it('should block start when no eligible recipients', async () => {
    await seedUsers([{ id: 1 }])
    const b = await createBroadcast({ text: 'Wave', created_by: 123 })
    await markSent(b.id, 1)
    await handleCallbackQuery({
      callback: { payload: `broadcast_recipients:${b.id}`, user: { user_id: 123 } },
      message: { recipient: { chat_id: 1 }, body: { mid: 90 } }
    })
    const screen = fetchCalls.find(c => c.method === 'PUT' && c.url.includes('message_id=90'))
    assert.ok(screen?.body?.text?.includes('Нет новых получателей'))
  })

  it('should start limited run from preset and not over-send', async () => {
    await seedUsers([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }])
    const b = await createBroadcast({ text: 'Wave', created_by: 123 })
    await handleCallbackQuery({
      callback: { payload: `broadcast_go:${b.id}:2`, user: { user_id: 123 } },
      message: { recipient: { chat_id: 1 }, body: { mid: 90 } }
    })
    const sentTo = fetchCalls.filter(c => c.url.includes('/messages?user_id=')).map(c => c.url.split('user_id=')[1])
    assert.deepStrictEqual(sentTo, ['1', '2'])
    const done = fetchCalls.find(c => c.method === 'PUT' && c.url.includes('message_id=90'))
    assert.ok(done?.body?.text?.includes('завершена'))
  })

  it('should refuse start while broadcast is sending', async () => {
    const b = await createBroadcast({ text: 'Busy', created_by: 123 })
    await updateBroadcast(b.id, { status: 'sending' })
    await handleCallbackQuery({
      callback: { payload: `broadcast_go:${b.id}:100`, user: { user_id: 123 } },
      message: { recipient: { chat_id: 1 }, body: { mid: 90 } }
    })
    const msg = fetchCalls.find(c => c.body?.text?.includes('Сначала остановите'))
    assert.ok(msg, 'busy guard message expected')
  })

  it('should accept custom number for a SENT broadcast (regression: intercept outside draft)', async () => {
    await seedUsers([{ id: 1 }, { id: 2 }])
    const b = await createBroadcast({ text: 'Repeat', created_by: 123 })
    await markSent(b.id, 1)
    await updateBroadcast(b.id, { status: 'sent' })
    // «Разослать ещё» → «Свой вариант»
    await handleCallbackQuery({
      callback: { payload: `broadcast_custom:${b.id}`, user: { user_id: 123 } },
      message: { recipient: { chat_id: 1 }, body: { mid: 90 } }
    })
    const prompt = fetchCalls.find(c => c.body?.text?.includes('Введите число получателей'))
    assert.ok(prompt, 'custom prompt expected')
    // ввод числа текстом — перехват вне ветки черновика
    await handleMessage({ chat_id: 1, message: { body: { text: '1' } }, user: { user_id: 123 } })
    const sentTo = fetchCalls.filter(c => c.url.includes('/messages?user_id=')).map(c => c.url.split('user_id=')[1])
    assert.deepStrictEqual(sentTo, ['2'], 'only never-sent user should receive')
    const fresh = await getBroadcast(b.id)
    assert.strictEqual(fresh._awaiting_limit, false)
    assert.strictEqual(fresh.limit, 1)
  })

  it('should reject invalid custom number and keep flag', async () => {
    await seedUsers([{ id: 1 }])
    const b = await createBroadcast({ text: 'Bad', created_by: 123 })
    await handleCallbackQuery({
      callback: { payload: `broadcast_custom:${b.id}`, user: { user_id: 123 } },
      message: { recipient: { chat_id: 1 }, body: { mid: 90 } }
    })
    await handleMessage({ chat_id: 1, message: { body: { text: 'abc' } }, user: { user_id: 123 } })
    const warn = fetchCalls.find(c => c.body?.text?.includes('Введите число от 1 до 10000'))
    assert.ok(warn)
    assert.strictEqual((await getBroadcast(b.id))._awaiting_limit, true)
    await handleMessage({ chat_id: 1, message: { body: { text: '0' } }, user: { user_id: 123 } })
    assert.strictEqual((await getBroadcast(b.id))._awaiting_limit, true)
  })
})
```

В импорты `test/handler.test.js` (строка 21–24) добавить `markSent` и `getBroadcast` (при отсутствии).

- [ ] **Step 2: Запустить и убедиться, что падает**

Run: `node --test test/handler.test.js`
Expected: FAIL — новые payload'ы не обрабатываются, старые restart-тесты падают.

- [ ] **Step 3: Импорты и хелперы**

В `api/index.js`:
1. В импорт из `../lib/broadcast.js` (L20-27) добавить `clearRunAttempted`.
2. После импортов storage добавить:
```js
import { runBroadcastBatch, getEligibleUsers, getRunSentCount, getRecipientCounts } from '../lib/broadcast-runner.js'
```
3. После `getActiveDraft` (строка 260) добавить:

```js
/** Рассылка админа, ожидающая ввода числа получателей («Свой вариант») */
async function getAwaitingLimitBroadcast (userId) {
  try {
    const all = await getAllBroadcasts()
    return all.find(b => b._awaiting_limit && b.created_by === userId) || null
  } catch {
    return null
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
```

- [ ] **Step 4: Перехват числа в `handleMessage`**

В `api/index.js` заменить начало блока (строка 469-471):
```js
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
```
(ниже без изменений, включая шаги текст → картинки → кнопки).

- [ ] **Step 5: Кнопки предпросмотра**

В двух местах заменить кнопку «✅ Отправить» на экран получателей (строка ~536 в handleMessage и ~819 в `broadcast_buttons_done:`):
```js
            [{ type: 'callback', text: '👥 Кому отправляем', data: `broadcast_recipients:${draft.id}` }],
```
(во втором месте — `broadcast_recipients:${bid}`).

- [ ] **Step 6: Новые callback-обработчики вместо confirm_now**

Заменить блок `broadcast_confirm_now:` (строки 868–1001) на:

```js
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
    const res = await startBroadcastRun(bid, Number.isFinite(n) && n >= 1 ? Math.floor(n) : null, chatId)
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
```

- [ ] **Step 7: Удалить обработчик `broadcast_restart`**

Полностью удалить блок `if (cb.payload.startsWith('broadcast_restart:'))` (строки 844–866).

- [ ] **Step 8: Экран деталей (broadcast_view)**

В обработчике `broadcast_view:`:
1. Сделать `b` перезаписываемым и снимать флаг ожидания:
```js
    let b = await getBroadcast(bid)
    if (!b) return sendMessage(chatId, '❌ Рассылка не найдена.')
    if (b._awaiting_limit) {
      await updateBroadcast(bid, { _awaiting_limit: false })
      b = await getBroadcast(bid)
    }
```
2. Заменить блок прогресса (строки 1023–1033):
```js
    if (b.status === 'scheduled' || b.status === 'sending') {
      const stats = await getBroadcastStats(bid)
      const S = getRunSentCount(b, stats.sent)
      const eligible = await getEligibleUsers(b)
      detail += b.limit == null
        ? `📤 Запуск: ${S} из ${eligible.length}\n`
        : `📤 Запуск: ${S} / ${b.limit}\n`
      detail += `✅ Получили всего: ${stats.sent} | ❌ Ошибок: ${stats.failed}\n`
    }
```
3. Заменить кнопки (строки 1035–1053):
```js
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
```

- [ ] **Step 9: Статистика рассылки**

В обработчике `broadcast_stats:` (после строки `msg += \`✅ Отправлено: ...\``) добавить:
```js
    msg += `📤 В этот запуск: ${getRunSentCount(b, stats.sent)} (лимит: ${b.limit ?? 'все'})\n`
```

- [ ] **Step 10: Прогнать тесты**

Run: `node --test test/handler.test.js test/broadcast.test.js test/broadcast-runner.test.js`
Expected: PASS. Если старый тест `broadcast_restart callback` остался — удалить (заменён в Step 1).

- [ ] **Step 11: Commit**

```bash
git add api/index.js test/handler.test.js
git commit -m "Add recipient limit UI to broadcast flow"
```

---

### Task 4: Роуты через общий движок

**Files:**
- Modify: `api/index.js` (L1266-1413 `/process-broadcasts`, L1420-1559 `/cron-process-broadcasts`, импорты)

**Interfaces:**
- Consumes: Task 2 `runBroadcastBatch`, Task 3 helpers не нужны.
- Produces: `processScheduledBroadcast(b, { continueChain, host, scheme, secret })` — общий шаг для обоих роутов; из импортов api/index.js удаляются неиспользуемые `getCursor, setCursor, resetBroadcastStats` (проверить, что нигде больше не используются — `isSent` остаётся для открытий).

- [ ] **Step 1: Общий шаг обработки**

В `api/index.js` перед роутом `/process-broadcasts` (строка ~1266) добавить:

```js
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
```

- [ ] **Step 2: Переписать `/process-broadcasts`**

Заменить тело роута (строки 1266–1413) на:

```js
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
```

- [ ] **Step 3: Переписать `/cron-process-broadcasts`**

Заменить тело роута (строки 1420–1559) — шапка с проверкой `isLocal`/`isVercelCron` остаётся, ниже:

```js
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
```

- [ ] **Step 4: Почистить импорты**

Из импорта `../lib/broadcast.js` в api/index.js удалить `getCursor, setCursor, resetBroadcastStats` (после проверки grep'ом, что в файле их больше нет ссылок: `grep -n "getCursor\|setCursor\|resetBroadcastStats" api/index.js` → пусто).

- [ ] **Step 5: Тесты**

Run: `npm test`
Expected: PASS. Особое внимание — `'should edit the stored status message on chain completion'` и `'should not use nav_msg for broadcast completion'` (route-level, через `app.request('/process-broadcasts?secret=test-secret')`): рассылка без `limit`/`_run_sent_at_start` → фолбэк, «Всем», завершение за один вызов.

- [ ] **Step 6: Commit**

```bash
git add api/index.js
git commit -m "Route broadcasts through shared runner"
```

---

### Task 5: Документация

**Files:**
- Modify: `AGENTS.md`, `docs/architecture.md`, `docs/api.md`

- [ ] **Step 1: `AGENTS.md` — карта структуры**

В дереве `lib/` (между `broadcast.js` и `nav.js`) добавить строку:
```md
│   ├── broadcast-runner.js # Движок рассылки «волнами» (лимит, память :sent)
```
(выровнять отступы по существующему дереву).

- [ ] **Step 2: `docs/architecture.md`**

1. В дерево `lib/` (строки 12–15) добавить:
```md
├── broadcast-runner.js  # Движок рассылок: волны, лимит, память :sent
```
2. В конец раздела «Структура KV» (после строки 38) добавить:

```md
## Рассылки (broadcast)

```
broadcast:<id>               → { text, images, buttons, status, limit, _run_sent_at_start, ... }
broadcast:<id>:sent          → Set<user_id>   # «Память»: кто получил ЭТУ рассылку (навсегда)
broadcast:<id>:run_attempted → Set<user_id>   # Обработанные в текущем запуске
broadcast:<id>:delivered|opened|unsubbed|failed → Set<user_id>  # Статистика
broadcasts:all               → Set<id>
broadcasts:scheduled         → ZSet<score=время, member=id>
```

## Рассылка «волнами»

Админ выбирает лимит получателей (100/200/500/1000, свой ввод или «Всем»). Получатели — старейшие по `first_seen`, ещё не получившие эту рассылку (`:sent`). `lib/broadcast-runner.js` — единый движок для кнопки и `/process-broadcasts`: на каждом батче пересчитывает список кандидатов, прогресс считается как `scard(:sent) − _run_sent_at_start`; повторный запуск («Разослать ещё») идёт только не получившим.
```

- [ ] **Step 3: `docs/api.md`**

1. В таблице «Inline-кнопки» строку про `broadcast` заменить на:
```md
| `broadcast_menu` | Кнопка `📨 Рассылка` | Меню рассылок: новая, список, очистка неактивных |
```
2. В конец файла (перед «См. также») добавить:

```md
## Рассылки (broadcast)

Поток: черновик (текст → картинки → кнопки) → экран «Кому отправляем?» (лимит 100/200/500/1000, «Свой вариант», «Всем») → запуск. Дубликатов нет: повторный запуск той же рассылки («📤 Разослать ещё») доставляется только тем, кто её ещё не получал.

**GET** `/process-broadcasts?secret=…` — продолжение цепочки рассылки (батчами по 20, вызывается самим ботом). **GET** `/cron-process-broadcasts` — cron-подхват (Vercel cron или локальный вызов).
```

- [ ] **Step 4: Полный прогон и commit**

Run: `npm test` → Expected: PASS.

```bash
git add AGENTS.md docs/architecture.md docs/api.md
git commit -m "Document broadcast wave mechanics"
