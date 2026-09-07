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
