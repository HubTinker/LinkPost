const BR_PREFIX = 'broadcast:'
const BR_ALL_SET = 'broadcasts:all'
const BR_SCHEDULED_ZSET = 'broadcasts:scheduled'

const SENT_SUFFIX = ':sent'
const DELIVERED_SUFFIX = ':delivered'
const OPENED_SUFFIX = ':opened'
const UNSUBBED_SUFFIX = ':unsubbed'
const FAILED_SUFFIX = ':failed'
const CURSOR_SUFFIX = ':cursor'
const PROGRESS_MSG_SUFFIX = ':progress_msg'

const STATS_TTL = 90 * 24 * 60 * 60
const LOG_LEVEL = (process.env.LOG_LEVEL ?? 'INFO').toUpperCase()

function log (level, ...args) {
  const levels = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 }
  if ((levels[level] ?? 1) >= (levels[LOG_LEVEL] ?? 0)) {
    console.log(`[broadcast] [${level}]`, ...args)
  }
}

let _kv = null
async function getKv () {
  if (!_kv) {
    const useMock = !process.env.KV_URL && !process.env.KV_REST_API_URL
    const mod = useMock ? await import('./kv-mock.js') : await import('@vercel/kv')
    _kv = mod.kv
  }
  return _kv
}

export async function createBroadcast (data) {
  const kv = await getKv()
  const id = `br_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const broadcast = {
    id,
    title: data.title ?? null,
    text: data.text ?? '',
    images: data.images ?? [],
    buttons: data.buttons ?? [],
    format: data.format ?? 'markdown',
    status: (data.scheduled_at && Number.isFinite(data.scheduled_at)) ? 'scheduled' : 'draft',
    scheduled_at: (data.scheduled_at && Number.isFinite(data.scheduled_at)) ? data.scheduled_at : null,
    created_at: Date.now(),
    created_by: data.created_by
  }
  await kv.set(`${BR_PREFIX}${id}`, broadcast)
  await kv.sadd(BR_ALL_SET, id)
  if (broadcast.scheduled_at) {
    await kv.zadd(BR_SCHEDULED_ZSET, { score: broadcast.scheduled_at, member: id })
  }
  log('INFO', `created broadcast ${id}, status=${broadcast.status}`)
  return broadcast
}

export async function getBroadcast (id) {
  const kv = await getKv()
  return kv.get(`${BR_PREFIX}${id}`)
}

export async function updateBroadcast (id, patch) {
  const kv = await getKv()
  const existing = await kv.get(`${BR_PREFIX}${id}`)
  if (!existing) return null
  const allowed = ['title', 'text', 'images', 'buttons', 'format', 'status', 'scheduled_at', '_images_done', '_buttons_done']
  const safePatch = {}
  for (const k of allowed) {
    if (k in patch) safePatch[k] = patch[k]
  }
  const updated = { ...existing, ...safePatch, id }
  await kv.set(`${BR_PREFIX}${id}`, updated)

  if (patch.scheduled_at !== undefined) {
    await kv.zrem(BR_SCHEDULED_ZSET, id)
    if (updated.scheduled_at != null) {
      await kv.zadd(BR_SCHEDULED_ZSET, { score: updated.scheduled_at, member: id })
    }
  }
  return updated
}

export async function deleteBroadcast (id) {
  const kv = await getKv()
  const keys = [
    `${BR_PREFIX}${id}`,
    `${BR_PREFIX}${id}${SENT_SUFFIX}`,
    `${BR_PREFIX}${id}${DELIVERED_SUFFIX}`,
    `${BR_PREFIX}${id}${OPENED_SUFFIX}`,
    `${BR_PREFIX}${id}${UNSUBBED_SUFFIX}`,
    `${BR_PREFIX}${id}${FAILED_SUFFIX}`,
    `${BR_PREFIX}${id}${CURSOR_SUFFIX}`,
    `${BR_PREFIX}${id}${PROGRESS_MSG_SUFFIX}`
  ]
  for (const key of keys) {
    await kv.del(key)
  }
  await kv.srem(BR_ALL_SET, id)
  await kv.zrem(BR_SCHEDULED_ZSET, id)
  log('INFO', `deleted broadcast ${id}`)
}

export async function getAllBroadcasts () {
  const kv = await getKv()
  const ids = await kv.smembers(BR_ALL_SET)
  if (!ids.length) return []
  const values = await Promise.all(ids.map(id => kv.get(`${BR_PREFIX}${id}`)))
  return values.filter(Boolean).sort((a, b) => b.created_at - a.created_at)
}

export async function getScheduledBroadcasts () {
  const kv = await getKv()
  const ids = await kv.zrangebyscore(BR_SCHEDULED_ZSET, 0, Date.now())
  if (!ids.length) return []
  const values = await Promise.all(ids.map(id => kv.get(`${BR_PREFIX}${id}`)))
  return values.filter(b => b && b.status === 'scheduled')
}

export async function markSent (broadcastId, userId) {
  const kv = await getKv()
  return kv.sadd(`${BR_PREFIX}${broadcastId}${SENT_SUFFIX}`, String(userId))
}

export async function isSent (broadcastId, userId) {
  const kv = await getKv()
  return kv.sismember(`${BR_PREFIX}${broadcastId}${SENT_SUFFIX}`, String(userId))
}

export async function markDelivered (broadcastId, userId) {
  const kv = await getKv()
  return kv.sadd(`${BR_PREFIX}${broadcastId}${DELIVERED_SUFFIX}`, String(userId))
}

export async function markOpened (broadcastId, userId) {
  const kv = await getKv()
  return kv.sadd(`${BR_PREFIX}${broadcastId}${OPENED_SUFFIX}`, String(userId))
}

export async function markUnsubbed (broadcastId, userId) {
  const kv = await getKv()
  return kv.sadd(`${BR_PREFIX}${broadcastId}${UNSUBBED_SUFFIX}`, String(userId))
}

export async function markFailed (broadcastId, userId) {
  const kv = await getKv()
  return kv.sadd(`${BR_PREFIX}${broadcastId}${FAILED_SUFFIX}`, String(userId))
}

export async function getCursor (broadcastId) {
  const kv = await getKv()
  const val = await kv.get(`${BR_PREFIX}${broadcastId}${CURSOR_SUFFIX}`)
  return Number(val) || 0
}

export async function setCursor (broadcastId, value) {
  const kv = await getKv()
  const key = `${BR_PREFIX}${broadcastId}${CURSOR_SUFFIX}`
  await kv.set(key, value)
  await kv.expire(key, STATS_TTL)
}

export async function setProgressMessageId (broadcastId, messageId) {
  const kv = await getKv()
  const key = `${BR_PREFIX}${broadcastId}${PROGRESS_MSG_SUFFIX}`
  await kv.set(key, messageId)
  // TTL = 7 days
  await kv.expire(key, 7 * 86400)
}

export async function getProgressMessageId (broadcastId) {
  const kv = await getKv()
  return kv.get(`${BR_PREFIX}${broadcastId}${PROGRESS_MSG_SUFFIX}`)
}

export async function getBroadcastStats (broadcastId) {
  const kv = await getKv()
  const [sent, delivered, opened, unsubbed, failed] = await Promise.all([
    kv.scard(`${BR_PREFIX}${broadcastId}${SENT_SUFFIX}`),
    kv.scard(`${BR_PREFIX}${broadcastId}${DELIVERED_SUFFIX}`),
    kv.scard(`${BR_PREFIX}${broadcastId}${OPENED_SUFFIX}`),
    kv.scard(`${BR_PREFIX}${broadcastId}${UNSUBBED_SUFFIX}`),
    kv.scard(`${BR_PREFIX}${broadcastId}${FAILED_SUFFIX}`)
  ])
  return { sent, delivered, opened, unsubbed, failed }
}

export async function resetBroadcastStats (broadcastId) {
  const kv = await getKv()
  const prefix = `${BR_PREFIX}${broadcastId}`
  await Promise.all([
    kv.del(`${prefix}${SENT_SUFFIX}`),
    kv.del(`${prefix}${DELIVERED_SUFFIX}`),
    kv.del(`${prefix}${OPENED_SUFFIX}`),
    kv.del(`${prefix}${UNSUBBED_SUFFIX}`),
    kv.del(`${prefix}${FAILED_SUFFIX}`),
    kv.del(`${prefix}${PROGRESS_MSG_SUFFIX}`)
  ])
  await setCursor(broadcastId, 0)
}

export { BR_PREFIX, BR_ALL_SET, BR_SCHEDULED_ZSET }
