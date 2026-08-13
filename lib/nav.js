const NAV_PREFIX = 'nav_msg:'
const NAV_TTL = 24 * 60 * 60

let _kv = null
async function getKv () {
  if (!_kv) {
    const useMock = !process.env.KV_URL && !process.env.KV_REST_API_URL
    const mod = useMock ? await import('./kv-mock.js') : await import('@vercel/kv')
    _kv = mod.kv
  }
  return _kv
}

export async function setNavMessageId (chatId, messageId) {
  const kv = await getKv()
  const key = `${NAV_PREFIX}${chatId}`
  await kv.set(key, messageId)
  await kv.expire(key, NAV_TTL)
}

export async function getNavMessageId (chatId) {
  const kv = await getKv()
  return kv.get(`${NAV_PREFIX}${chatId}`)
}
