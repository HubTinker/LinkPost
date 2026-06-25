import dotenv from 'dotenv'

dotenv.config({ path: '.env.local' })

const LOG_LEVEL = (process.env.LOG_LEVEL ?? 'INFO').toUpperCase()
const LOG_LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 }
const CURRENT_LEVEL = LOG_LEVELS[LOG_LEVEL] ?? 1

function log (level, ...args) {
  if ((LOG_LEVELS[level] ?? 1) >= CURRENT_LEVEL) {
    console.log(`[migrate] [${level}]`, ...args)
  }
}

async function loadKv () {
  const useMock = !process.env.KV_URL && !process.env.KV_REST_API_URL
  if (useMock) {
    log('WARN', 'KV_URL / KV_REST_API_URL not set, using mock')
  }
  const mod = useMock ? await import('../lib/kv-mock.js') : await import('@vercel/kv')
  return mod.kv
}

async function migrate () {
  const kv = await loadKv()

  const adminIds = (process.env.ADMIN_USER_IDS ?? '')
    .split(',')
    .map(s => Number(s.trim()))
    .filter(Boolean)

  if (!adminIds.length) {
    log('ERROR', 'ADMIN_USER_IDS is empty or not set')
    process.exit(1)
  }

  const fallbackOwner = adminIds[0]
  log('INFO', `Fallback owner: ${fallbackOwner}`)

  const allKeys = await kv.smembers('links_all')
  log('INFO', `Total links in links_all: ${allKeys.length}`)

  let migrated = 0
  let skipped = 0

  for (const key of allKeys) {
    const existing = await kv.get(`link:${key}`)
    if (!existing) {
      log('WARN', `link:${key} not found in KV, skipping`)
      skipped++
      continue
    }

    if (existing.creator_id != null) {
      log('DEBUG', `link:${key} already has creator_id=${existing.creator_id}, skipping`)
      skipped++
      continue
    }

    log('DEBUG', `migrating link:${key} → creator_id=${fallbackOwner}`)
    await kv.set(`link:${key}`, { ...existing, creator_id: fallbackOwner })
    await kv.sadd(`user_links:${fallbackOwner}`, key)
    migrated++
  }

  log('INFO', `Done: migrated=${migrated}, skipped=${skipped}`)
}

migrate().catch(err => {
  console.error('[migrate] [ERROR]', err.message)
  process.exit(1)
})
