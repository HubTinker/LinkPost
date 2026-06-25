const LINK_PREFIX = 'link:'
const USER_PREFIX = 'user:'
const USERS_SET = 'users_all'
const LINKS_SET = 'links_all'
const LINK_SUBS_PREFIX = 'link_subs:'
const USER_LINKS_PREFIX = 'user_links:'
const LOG_LEVEL = 'DEBUG'

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
  log('DEBUG', `setLink: key=${key}, url=${url}, creator=${creatorId}`)
  await kv.set(`${LINK_PREFIX}${key}`, { url, message, creator_id: creatorId ?? null })
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
  return keys.map((k, i) => ({ key: k, ...values[i] }))
}

export async function getLinksByCreator (userId) {
  const kv = await getKv()
  const keys = await kv.smembers(`${USER_LINKS_PREFIX}${userId}`)
  log('DEBUG', `getLinksByCreator: userId=${userId}, found=${keys.length} keys`)
  if (!keys.length) return []
  const values = await Promise.all(keys.map(k => kv.get(`${LINK_PREFIX}${k}`)))
  return keys.map((k, i) => ({ key: k, ...values[i] }))
}

// ── Подписки на ключи ─────────────────────────────────────────────────────────

export async function addUserToLink (key, userId) {
  const kv = await getKv()
  await kv.sadd(`${LINK_SUBS_PREFIX}${key.toLowerCase()}`, String(userId))
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

// ── Пользователи ─────────────────────────────────────────────────────────────

export async function saveUser ({ user_id, name, username }, subscribedKey) {
  const kv = await getKv()
  await kv.set(`${USER_PREFIX}${user_id}`, {
    user_id,
    name,
    username: username ?? null,
    inactive: false,
    subscribed_key: subscribedKey ?? null,
    updated_at: Date.now()
  })
  await kv.sadd(USERS_SET, String(user_id))
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
