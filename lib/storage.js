const LINK_PREFIX = 'link:'
const USER_PREFIX = 'user:'
const USERS_SET = 'users_all'
const LINKS_SET = 'links_all'
const LINK_SUBS_PREFIX = 'link_subs:'

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

export async function setLink (key, url, message) {
  const kv = await getKv()
  await kv.set(`${LINK_PREFIX}${key}`, { url, message })
  await kv.sadd(LINKS_SET, key)
}

export async function getLink (key) {
  const kv = await getKv()
  return await kv.get(`${LINK_PREFIX}${key}`)
}

export async function delLink (key) {
  const kv = await getKv()
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

// ── Подписки на ключи ─────────────────────────────────────────────────────────

export async function addUserToLink (key, userId) {
  const kv = await getKv()
  await kv.sadd(`${LINK_SUBS_PREFIX}${key}`, String(userId))
}

export async function getLinkSubs (key) {
  const kv = await getKv()
  const ids = await kv.smembers(`${LINK_SUBS_PREFIX}${key}`)
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
