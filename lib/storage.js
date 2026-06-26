const LINK_PREFIX = 'link:'
const USER_PREFIX = 'user:'
const USERS_SET = 'users_all'
const LINKS_SET = 'links_all'
const LINK_SUBS_PREFIX = 'link_subs:'
const USER_LINKS_PREFIX = 'user_links:'
const STATS_PREFIX = 'stats:new:'
const STATS_TOTAL = 'stats:new:total'
const STATS_TTL = 90 * 24 * 60 * 60
const LOG_LEVEL = (process.env.LOG_LEVEL ?? 'INFO').toUpperCase()

function formatDate (d = new Date()) {
  const dt = d instanceof Date ? d : new Date(d)
  const y = dt.getFullYear()
  const m = String(dt.getMonth() + 1).padStart(2, '0')
  const day = String(dt.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function daysAgo (n) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return formatDate(d)
}

function log (level, ...args) {
  const levels = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 }
  if ((levels[level] ?? 1) >= (levels[LOG_LEVEL] ?? 0)) {
    console.log(`[storage] [${level}]`, ...args)
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

// ── Ссылки ───────────────────────────────────────────────────────────────────

export async function setLink (key, url, message, creatorId) {
  const kv = await getKv()
  key = key.toLowerCase()
  const createdAt = Date.now()
  log('DEBUG', `setLink: key=${key}, url=${url}, creator=${creatorId}, created_at=${createdAt}`)
  await kv.set(`${LINK_PREFIX}${key}`, { url, message, creator_id: creatorId ?? null, created_at: createdAt })
  await kv.sadd(LINKS_SET, key)
  if (creatorId != null) {
    await kv.sadd(`${USER_LINKS_PREFIX}${creatorId}`, key)
    log('DEBUG', `setLink: added ${key} to user_links:${creatorId}`)
  }
}

export async function getLink (key) {
  const kv = await getKv()
  const lowerKey = key.toLowerCase()
  let data = await kv.get(`${LINK_PREFIX}${lowerKey}`)
  if (!data && lowerKey !== key) {
    data = await kv.get(`${LINK_PREFIX}${key}`)
  }
  return data
}

export async function delLink (key) {
  const kv = await getKv()
  key = key.toLowerCase()
  const existing = await kv.get(`${LINK_PREFIX}${key}`)
  if (existing?.creator_id != null) {
    await kv.srem(`${USER_LINKS_PREFIX}${existing.creator_id}`, key)
    log('DEBUG', `delLink: key=${key}, removed from user_links:${existing.creator_id}`)
  }
  await kv.del(`${LINK_PREFIX}${key}`)
  await kv.srem(LINKS_SET, key)
}

export async function getAllLinks () {
  const kv = await getKv()
  const keys = await kv.smembers(LINKS_SET)
  if (!keys.length) return []
  const values = await Promise.all(keys.map(k => kv.get(`${LINK_PREFIX}${k}`)))
  return keys.map((k, i) => values[i] ? { key: k, ...values[i] } : null).filter(Boolean)
}

export async function getLinksByCreator (userId) {
  const kv = await getKv()
  const keys = await kv.smembers(`${USER_LINKS_PREFIX}${userId}`)
  log('DEBUG', `getLinksByCreator: userId=${userId}, found=${keys.length} keys`)
  if (!keys.length) return []
  const values = await Promise.all(keys.map(k => kv.get(`${LINK_PREFIX}${k}`)))
  return keys.map((k, i) => values[i] ? { key: k, ...values[i] } : null).filter(Boolean)
}

// ── Подписки на ключи ─────────────────────────────────────────────────────────

export async function addUserToLink (key, userId) {
  const kv = await getKv()
  const added = await kv.sadd(`${LINK_SUBS_PREFIX}${key.toLowerCase()}`, String(userId))
  if (added === 1) {
    await incrDailyStat(key, formatDate())
    log('DEBUG', `addUserToLink: new subscriber, key=${key}, userId=${userId}`)
  }
  return added
}

export async function getLinkSubs (key) {
  const kv = await getKv()
  const ids = await kv.smembers(`${LINK_SUBS_PREFIX}${key.toLowerCase()}`)
  return ids?.map(Number) ?? []
}

// ── Статус активности ─────────────────────────────────────────────────────────

export async function markInactive (userId) {
  const kv = await getKv()
  const user = await kv.get(`${USER_PREFIX}${userId}`)
  if (user) {
    user.inactive = true
    user.updated_at = Date.now()
    await kv.set(`${USER_PREFIX}${userId}`, user)
  }
}

export async function reactivateUser (userId) {
  const kv = await getKv()
  const user = await kv.get(`${USER_PREFIX}${userId}`)
  if (user) {
    user.inactive = false
    user.updated_at = Date.now()
    await kv.set(`${USER_PREFIX}${userId}`, user)
  }
}

// ── Счётчики по дням ──────────────────────────────────────────────────────────

async function incrDailyStat (key, date) {
  const kv = await getKv()
  const statKey = `${STATS_PREFIX}${key.toLowerCase()}:${date}`
  const val = await kv.incr(statKey)
  await kv.expire(statKey, STATS_TTL)
  log('DEBUG', `incrDailyStat: key=${key}, date=${date}, val=${val}`)
  return val
}

async function incrDailyTotal (date) {
  const kv = await getKv()
  const val = await kv.incr(`${STATS_TOTAL}:${date}`)
  await kv.expire(`${STATS_TOTAL}:${date}`, STATS_TTL)
  log('DEBUG', `incrDailyTotal: date=${date}, val=${val}`)
  return val
}

function rangeDates (from, to) {
  const dates = []
  const current = new Date(from)
  const end = new Date(to)
  while (current <= end) {
    dates.push(formatDate(current))
    current.setDate(current.getDate() + 1)
  }
  return dates
}

export async function getDailyStat (key, date) {
  const kv = await getKv()
  const val = await kv.get(`${STATS_PREFIX}${key.toLowerCase()}:${date}`)
  const num = Number(val)
  log('DEBUG', `getDailyStat: key=${key}, date=${date}, val=${num}`)
  return Number.isFinite(num) ? num : 0
}

export async function getDailyTotal (date) {
  const kv = await getKv()
  const val = await kv.get(`${STATS_TOTAL}:${date}`)
  const num = Number(val)
  log('DEBUG', `getDailyTotal: date=${date}, val=${num}`)
  return Number.isFinite(num) ? num : 0
}

export async function getStatRange (key, from, to) {
  const kv = await getKv()
  const dates = rangeDates(from, to)
  const keys = dates.map(d => `${STATS_PREFIX}${key.toLowerCase()}:${d}`)
  if (!keys.length) return []
  const values = await Promise.all(keys.map(k => kv.get(k)))
  return dates.map((date, i) => ({ date, count: Number(values[i]) || 0 }))
}

export async function getTotalRange (from, to) {
  const kv = await getKv()
  const dates = rangeDates(from, to)
  const keys = dates.map(d => `${STATS_TOTAL}:${d}`)
  if (!keys.length) return []
  const values = await Promise.all(keys.map(k => kv.get(k)))
  return dates.map((date, i) => ({ date, count: Number(values[i]) || 0 }))
}

export async function getLinkSubCount (key) {
  const kv = await getKv()
  const count = await kv.scard(`${LINK_SUBS_PREFIX}${key.toLowerCase()}`)
  log('DEBUG', `getLinkSubCount: key=${key}, count=${count}`)
  return count
}

export async function getLinkAge (key) {
  const kv = await getKv()
  const link = await kv.get(`${LINK_PREFIX}${key.toLowerCase()}`)
  if (!link?.created_at) {
    log('DEBUG', `getLinkAge: key=${key}, no created_at`)
    return null
  }
  const days = Math.floor((Date.now() - link.created_at) / 86400000)
  log('DEBUG', `getLinkAge: key=${key}, age=${days} days`)
  return days
}

// ── Рейтинг ключей ────────────────────────────────────────────────────────────

export async function getLinksRankedBySubs () {
  log('DEBUG', 'getLinksRankedBySubs: start')
  const links = await getAllLinks()
  if (!links.length) {
    log('DEBUG', 'getLinksRankedBySubs: no links found')
    return []
  }
  const enriched = await Promise.all(links.map(async (l) => {
    const subCount = await getLinkSubCount(l.key)
    return { key: l.key, url: l.url, message: l.message, subCount }
  }))
  enriched.sort((a, b) => b.subCount - a.subCount)
  const top3 = enriched.slice(0, 3).map(l => `${l.key}=${l.subCount}`).join(', ')
  log('DEBUG', `getLinksRankedBySubs: total=${enriched.length}, top3=[${top3}]`)
  return enriched
}

// ── Пользователи ─────────────────────────────────────────────────────────────

export async function saveUser ({ user_id, name, username }, subscribedKey) {
  const kv = await getKv()
  const existing = await kv.get(`${USER_PREFIX}${user_id}`)
  const isNew = !existing
  const firstSeen = isNew ? Date.now() : (existing.first_seen || Date.now())

  log('DEBUG', `saveUser: userId=${user_id}, isNew=${isNew}, subscribedKey=${subscribedKey ?? null}`)

  await kv.set(`${USER_PREFIX}${user_id}`, {
    user_id,
    name,
    username: username ?? null,
    inactive: false,
    subscribed_key: subscribedKey ?? null,
    first_seen: firstSeen,
    updated_at: Date.now()
  })
  await kv.sadd(USERS_SET, String(user_id))

  if (isNew) {
    await incrDailyTotal(formatDate())
  }

  if (subscribedKey) {
    await addUserToLink(subscribedKey, user_id)
  }
}

export async function getAllUsers () {
  const kv = await getKv()
  const ids = await kv.smembers(USERS_SET)
  if (!ids?.length) return []
  const users = await Promise.all(ids.map(id => kv.get(`${USER_PREFIX}${id}`)))
  return users.filter(Boolean)
}

export async function getUserCount () {
  const kv = await getKv()
  return await kv.scard(USERS_SET)
}

export async function getLinkCount () {
  const kv = await getKv()
  return await kv.scard(LINKS_SET)
}

// ── Rate Limiting ─────────────────────────────────────────────────────────────

export async function checkRateLimit (key, max, windowMs) {
  const kv = await getKv()
  const countKey = `ratelimit:${key}`
  const count = await kv.incr(countKey)
  if (count === 1) {
    await kv.pexpire(countKey, windowMs)
  }
  log('DEBUG', `checkRateLimit: key=${key}, count=${count}, max=${max}`)
  return count <= max
}
