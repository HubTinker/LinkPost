import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert'

import {
  createBroadcast, getBroadcast, updateBroadcast, deleteBroadcast,
  getAllBroadcasts, getScheduledBroadcasts,
  markSent, isSent, markDelivered, markOpened, markUnsubbed,
  getCursor, setCursor, getBroadcastStats
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

  it('should mark delivered, opened, unsubbed', async () => {
    const b = await createBroadcast({ text: 'Tracking', created_by: 123 })
    await markSent(b.id, 100)
    await markDelivered(b.id, 100)
    await markOpened(b.id, 100)
    await markUnsubbed(b.id, 200)
    const stats = await getBroadcastStats(b.id)
    assert.strictEqual(stats.sent, 1)
    assert.strictEqual(stats.delivered, 1)
    assert.strictEqual(stats.opened, 1)
    assert.strictEqual(stats.unsubbed, 1)
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
