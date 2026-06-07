const useMock = !process.env.KV_URL && !process.env.KV_REST_API_URL
const { kv } = useMock
  ? await import('./kv-mock.js')
  : await import('@vercel/kv')

const LINK_PREFIX = 'link:'
const USER_PREFIX = 'user:'
const USERS_SET = 'users_all'
const LINKS_SET = 'links_all'
const LINK_SUBS_PREFIX = 'link_subs:'

// ── Ссылки ───────────────────────────────────────────────────────────────────

export async function setLink (key, url, message) {
  await kv.set(`${LINK_PREFIX}${key}`, { url, message })
  await kv.sadd(LINKS_SET, key)
}

export async function getLink (key) {
  return await kv.get(`${LINK_PREFIX}${key}`)
}

export async function delLink (key) {
  await kv.del(`${LINK_PREFIX}${key}`)
  await kv.srem(LINKS_SET, key)
}

export async function getAllLinks () {
  const keys = await kv.smembers(LINKS_SET)
  if (!keys.length) return []
  const values = await Promise.all(keys.map(k => kv.get(`${LINK_PREFIX}${k}`)))
  return keys.map((k, i) => ({ key: k, ...values[i] }))
}

// ── Подписки на ключи ─────────────────────────────────────────────────────────

export async function addUserToLink (key, userId) {
  await kv.sadd(`${LINK_SUBS_PREFIX}${key}`, String(userId))
}

export async function getLinkSubs (key) {
  const ids = await kv.smembers(`${LINK_SUBS_PREFIX}${key}`)
  return ids?.map(Number) ?? []
}

// ── Статус активности ─────────────────────────────────────────────────────────

export async function markInactive (userId) {
  const user = await kv.get(`${USER_PREFIX}${userId}`)
  if (user) {
    user.inactive = true
    user.updated_at = Date.now()
    await kv.set(`${USER_PREFIX}${userId}`, user)
  }
}

export async function reactivateUser (userId) {
  const user = await kv.get(`${USER_PREFIX}${userId}`)
  if (user) {
    user.inactive = false
    user.updated_at = Date.now()
    await kv.set(`${USER_PREFIX}${userId}`, user)
  }
}

// ── Пользователи ─────────────────────────────────────────────────────────────

/**
 * @param {{ user_id: number, name: string, username?: string }} user
 * @param {string} [subscribedKey]
 */
export async function saveUser ({ user_id, name, username }, subscribedKey) {
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
  const ids = await kv.smembers(USERS_SET)
  if (!ids?.length) return []
  const users = await Promise.all(ids.map(id => kv.get(`${USER_PREFIX}${id}`)))
  return users.filter(Boolean)
}

export async function getUserCount () {
  return await kv.scard(USERS_SET)
}
