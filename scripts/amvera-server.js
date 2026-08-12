/**
 * LinkPost Bot — entry point для Amvera (production).
 *
 * Обычный Node.js HTTP-сервер (Hono), как в scripts/dev-server.js, плюс:
 *   - каждую минуту дёргает локальный /cron-process-broadcasts,
 *     чтобы подхватывать и продолжать запланированные рассылки
 *     (на Vercel эту роль выполняет платформенный cron).
 *
 * Переменные окружения задаются в настройках проекта Amvera (не .env.local).
 */
import dotenv from 'dotenv'
import { serve } from '@hono/node-server'
import { app } from '../api/index.js'

dotenv.config({ path: '.env.local' })

const port = parseInt(process.env.PORT ?? '3000', 10)
const CRON_INTERVAL_MS = 60_000

/** Обработать запланированные рассылки через собственный эндпоинт (localhost). */
async function processScheduledBroadcasts () {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/cron-process-broadcasts`, {
      headers: { 'x-forwarded-for': '127.0.0.1' }
    })
    const data = await res.json()
    if (data.processed > 0) {
      console.log('[cron] processed broadcasts:', JSON.stringify(data.results))
    }
  } catch (err) {
    console.warn('[cron] tick failed:', err.message)
  }
}

serve({ fetch: app.fetch, port }, () => {
  console.log(`🚀 LinkPost Bot (Amvera) запущен на порту ${port}`)
  console.log(`📡 Webhook эндпоинт: POST /webhook`)
  console.log(`⏰ Таймер рассылок: каждые ${CRON_INTERVAL_MS / 1000}с`)
})

setInterval(processScheduledBroadcasts, CRON_INTERVAL_MS)
processScheduledBroadcasts()
