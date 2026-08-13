import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert'

import {
  createBroadcast, getBroadcast, updateBroadcast, deleteBroadcast,
  getAllBroadcasts, getScheduledBroadcasts,
  markSent, isSent, markDelivered, markOpened, markUnsubbed, markFailed,
  getCursor, setCursor, getBroadcastStats, resetBroadcastStats,
  setStatusMessageId, getStatusMessageId
} from '../lib/broadcast.js'

import { kv } from '../lib/kv-mock.js'

describe('Broadcast CRUD', () => {
  beforeEach(async () => {
    await kv._clear()
  })

  it('should create a draft broadcast', async () => {
    const b = await createBroadcast({ text: 'Hello', created_by: 123 })
    assert.ok(b.id)
    assert.strictEqual(b.text, 'Hello')
    assert.strictEqual(b.status, 'draft')
    assert.strictEqual(b.created_by, 123)
  })

  it('should create a scheduled broadcast', async () => {
    const future = Date.now() + 3600000
    const b = await createBroadcast({ text: 'Scheduled', created_by: 123, scheduled_at: future })
    assert.strictEqual(b.status, 'scheduled')
    assert.strictEqual(b.scheduled_at, future)
  })

  it('should get a broadcast by id', async () => {
    const created = await createBroadcast({ text: 'Get me', created_by: 123 })
    const b = await getBroadcast(created.id)
    assert.ok(b)
    assert.strictEqual(b.text, 'Get me')
  })

  it('should return null for nonexistent broadcast', async () => {
    const b = await getBroadcast('nonexistent')
    assert.strictEqual(b, null)
  })

  it('should update a broadcast', async () => {
    const created = await createBroadcast({ text: 'Original', created_by: 123 })
    await updateBroadcast(created.id, { text: 'Updated' })
    const b = await getBroadcast(created.id)
    assert.strictEqual(b.text, 'Updated')
  })

  it('should not allow updating restricted fields', async () => {
    const created = await createBroadcast({ text: 'Original', created_by: 123 })
    await updateBroadcast(created.id, { created_by: 999 })
    const b = await getBroadcast(created.id)
    assert.strictEqual(b.created_by, 123)
  })

  it('should delete a broadcast and its sets', async () => {
    const created = await createBroadcast({ text: 'Delete me', created_by: 123 })
    await markSent(created.id, 1)
    await markSent(created.id, 2)
    await deleteBroadcast(created.id)
    const b = await getBroadcast(created.id)
    assert.strictEqual(b, null)
  })

  it('should list all broadcasts sorted by created_at desc', async () => {
    const b1 = await createBroadcast({ text: 'First', created_by: 123 })
    await new Promise(r => setTimeout(r, 10))
    const b2 = await createBroadcast({ text: 'Second', created_by: 123 })
    const all = await getAllBroadcasts()
    assert.strictEqual(all.length, 2)
    assert.strictEqual(all[0].id, b2.id)
  })
})

describe('Broadcast tracking', () => {
  beforeEach(async () => {
    await kv._clear()
  })

  it('should mark and check sent status', async () => {
    const b = await createBroadcast({ text: 'Tracking', created_by: 123 })
    const added = await markSent(b.id, 100)
    assert.strictEqual(added, 1)
    const sent = await isSent(b.id, 100)
    assert.ok(sent)
    const notSent = await isSent(b.id, 999)
    assert.ok(!notSent)
  })

  it('should mark delivered, opened, unsubbed, and failed', async () => {
    const b = await createBroadcast({ text: 'Tracking', created_by: 123 })
    await markSent(b.id, 100)
    await markDelivered(b.id, 100)
    await markOpened(b.id, 100)
    await markUnsubbed(b.id, 200)
    await markFailed(b.id, 300)
    const stats = await getBroadcastStats(b.id)
    assert.strictEqual(stats.sent, 1)
    assert.strictEqual(stats.delivered, 1)
    assert.strictEqual(stats.opened, 1)
    assert.strictEqual(stats.unsubbed, 1)
    assert.strictEqual(stats.failed, 1)
  })
})

describe('Broadcast failed tracking', () => {
  beforeEach(async () => {
    await kv._clear()
  })

  it('should mark failed for a user', async () => {
    const b = await createBroadcast({ text: 'Fail me', created_by: 123 })
    await markFailed(b.id, 100)
    const stats = await getBroadcastStats(b.id)
    assert.strictEqual(stats.failed, 1)
  })

  it('should not double-count failed for same user', async () => {
    const b = await createBroadcast({ text: 'Fail me', created_by: 123 })
    await markFailed(b.id, 100)
    await markFailed(b.id, 100)
    const stats = await getBroadcastStats(b.id)
    assert.strictEqual(stats.failed, 1)
  })

  it('should count failed for different users', async () => {
    const b = await createBroadcast({ text: 'Fail me', created_by: 123 })
    await markFailed(b.id, 100)
    await markFailed(b.id, 200)
    const stats = await getBroadcastStats(b.id)
    assert.strictEqual(stats.failed, 2)
  })
})

describe('Broadcast stats aggregation', () => {
  beforeEach(async () => {
    await kv._clear()
  })

  it('should aggregate stats across multiple broadcasts', async () => {
    const b1 = await createBroadcast({ text: 'First', created_by: 123 })
    const b2 = await createBroadcast({ text: 'Second', created_by: 123 })

    await markSent(b1.id, 1)
    await markSent(b1.id, 2)
    await markOpened(b1.id, 1)
    await markFailed(b1.id, 3)

    await markSent(b2.id, 10)
    await markOpened(b2.id, 10)
    await markUnsubbed(b2.id, 11)
    await markUnsubbed(b2.id, 12)

    const s1 = await getBroadcastStats(b1.id)
    const s2 = await getBroadcastStats(b2.id)

    assert.strictEqual(s1.sent, 2)
    assert.strictEqual(s1.opened, 1)
    assert.strictEqual(s1.failed, 1)
    assert.strictEqual(s1.unsubbed, 0)

    assert.strictEqual(s2.sent, 1)
    assert.strictEqual(s2.opened, 1)
    assert.strictEqual(s2.unsubbed, 2)
    assert.strictEqual(s2.failed, 0)

    const totalSent = s1.sent + s2.sent
    const totalOpened = s1.opened + s2.opened
    const totalUnsubbed = s1.unsubbed + s2.unsubbed
    const totalFailed = s1.failed + s2.failed

    assert.strictEqual(totalSent, 3)
    assert.strictEqual(totalOpened, 2)
    assert.strictEqual(totalUnsubbed, 2)
    assert.strictEqual(totalFailed, 1)
  })
})

describe('Broadcast cursor', () => {
  beforeEach(async () => {
    await kv._clear()
  })

  it('should default cursor to 0', async () => {
    const b = await createBroadcast({ text: 'Cursor', created_by: 123 })
    const cursor = await getCursor(b.id)
    assert.strictEqual(cursor, 0)
  })

  it('should set and get cursor', async () => {
    const b = await createBroadcast({ text: 'Cursor', created_by: 123 })
    await setCursor(b.id, 42)
    const cursor = await getCursor(b.id)
    assert.strictEqual(cursor, 42)
  })
})

describe('resetBroadcastStats', () => {
  beforeEach(async () => {
    await kv._clear()
  })

  it('should reset cursor and delete all stat sets', async () => {
    const b = await createBroadcast({ text: 'Reset me', created_by: 123 })
    await markSent(b.id, 100)
    await markSent(b.id, 200)
    await markFailed(b.id, 300)
    await setCursor(b.id, 42)

    const before = await getBroadcastStats(b.id)
    assert.strictEqual(before.sent, 2)
    assert.strictEqual(before.failed, 1)

    await resetBroadcastStats(b.id)

    const after = await getBroadcastStats(b.id)
    assert.strictEqual(after.sent, 0)
    assert.strictEqual(after.failed, 0)

    const cursor = await getCursor(b.id)
    assert.strictEqual(cursor, 0)
  })
})

describe('Scheduled broadcasts', () => {
  beforeEach(async () => {
    await kv._clear()
  })

  it('should return scheduled broadcasts with time <= now', async () => {
    const past = Date.now() - 60000
    const future = Date.now() + 3600000
    await createBroadcast({ text: 'Past', created_by: 123, scheduled_at: past })
    await createBroadcast({ text: 'Future', created_by: 123, scheduled_at: future })
    const scheduled = await getScheduledBroadcasts()
    assert.strictEqual(scheduled.length, 1)
    assert.strictEqual(scheduled[0].text, 'Past')
  })
})

describe('status message id', () => {
  beforeEach(async () => {
    await kv._clear()
  })

  it('should roundtrip status message id', async () => {
    const b = await createBroadcast({ text: 'X', created_by: 123 })
    assert.strictEqual(await getStatusMessageId(b.id), null)
    await setStatusMessageId(b.id, 90)
    assert.strictEqual(await getStatusMessageId(b.id), 90)
  })

  it('should store under broadcast:{id}:status_msg prefix', async () => {
    const b = await createBroadcast({ text: 'X', created_by: 123 })
    await setStatusMessageId(b.id, 90)
    assert.strictEqual(await kv.get(`broadcast:${b.id}:status_msg`), 90)
  })

  it('should delete status message id with broadcast', async () => {
    const b = await createBroadcast({ text: 'X', created_by: 123 })
    await setStatusMessageId(b.id, 90)
    await deleteBroadcast(b.id)
    assert.strictEqual(await kv.get(`broadcast:${b.id}:status_msg`), null)
  })

  it('should clear status message id on stats reset', async () => {
    const b = await createBroadcast({ text: 'X', created_by: 123 })
    await setStatusMessageId(b.id, 90)
    await resetBroadcastStats(b.id)
    assert.strictEqual(await kv.get(`broadcast:${b.id}:status_msg`), null)
  })
})
