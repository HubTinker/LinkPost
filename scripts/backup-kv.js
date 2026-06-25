import dotenv from 'dotenv'
import { writeFileSync } from 'node:fs'

dotenv.config({ path: '.env.local' })

const LOG_LEVEL = (process.env.LOG_LEVEL ?? 'INFO').toUpperCase()
const LOG_LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 }
const CURRENT_LEVEL = LOG_LEVELS[LOG_LEVEL] ?? 1

function log (level, ...args) {
  if ((LOG_LEVELS[level] ?? 1) >= CURRENT_LEVEL) {
    console.log(`[backup] [${level}]`, ...args)
  }
}

async function loadKv () {
  const useMock = !process.env.KV_URL && !process.env.KV_REST_API_URL
  if (useMock) {
    log('WARN', 'KV_URL / KV_REST_API_URL not set, using mock (backup will be empty)')
  }
  const mod = useMock ? await import('../lib/kv-mock.js') : await import('@vercel/kv')
  return mod.kv
}

function timestamp () {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`
}

async function backup () {
  log('DEBUG', 'Starting KV dump...')
  const kv = await loadKv()

  const dump = {
    timestamp: new Date().toISOString(),
    links_all: await kv.smembers('links_all'),
    links: {},
    link_subs: {},
    users_all: await kv.smembers('users_all'),
    users: {}
  }

  log('DEBUG', `links_all: ${dump.links_all.length} keys`)

  for (const key of dump.links_all) {
    dump.links[key] = await kv.get(`link:${key}`)
    const subs = await kv.smembers(`link_subs:${key}`)
    if (subs.length) {
      dump.link_subs[key] = subs
    }
    log('DEBUG', `link:${key} → ${JSON.stringify(dump.links[key])} (${subs.length} subs)`)
  }

  log('DEBUG', `users_all: ${dump.users_all.length} ids`)

  for (const id of dump.users_all) {
    dump.users[id] = await kv.get(`user:${id}`)
    log('DEBUG', `user:${id} → saved`)
  }

  const filename = `backup-${timestamp()}.json`
  writeFileSync(filename, JSON.stringify(dump, null, 2), 'utf-8')

  const stats = {
    links: Object.keys(dump.links).length,
    users: Object.keys(dump.users).length,
    subs: Object.keys(dump.link_subs).length
  }
  log('INFO', `Done: ${stats.links} links, ${stats.users} users, ${stats.subs} subscription sets`)
  log('INFO', `Saved to ${filename}`)
}

backup().catch(err => {
  console.error('[backup] [ERROR]', err.message)
  process.exit(1)
})
