/**
 * Long polling скрипт — ТОЛЬКО для локальной разработки.
 * На production используйте webhook через /setup-webhook.
 */
import dotenv from 'dotenv'
import { handleBotStarted, handleMessage, handleCallbackQuery } from './api/index.js'
dotenv.config({ path: '.env.local' })

const BASE = 'https://platform-api.max.ru'
const TOKEN = process.env.BOT_TOKEN

let marker = null
let retryDelay = 1000
let polling = false

function sleep (ms) {
  return new Promise(r => setTimeout(r, ms))
}

async function poll () {
  if (polling) return
  polling = true
  const params = new URLSearchParams({
    timeout: '30',
    limit: '100',
    types: 'bot_started,message_created,message_callback'
  })
  if (marker) params.set('marker', marker)

  try {
    const res = await fetch(`${BASE}/updates?${params}`, {
      headers: { Authorization: TOKEN }
    })

    if (res.status === 429) {
      retryDelay = Math.min(retryDelay * 2, 30000)
      console.warn(`[POLL] 429 rate limited, retrying in ${retryDelay}ms`)
      return
    }

    if (!res.ok) {
      const err = await res.text()
      console.error(`[POLL] Error ${res.status}: ${err}`)
      retryDelay = Math.min(retryDelay * 2, 30000)
      return
    }

    retryDelay = 1000

    const data = await res.json()

    if (data.marker) marker = data.marker

    if (!data.updates?.length) return

    for (const update of data.updates) {
      // Формат разный для разных типов апдейтов:
      //   bot_started: chat_id/user на верхнем уровне
      //   message_created: chat_id в message.recipient, user в message.sender
      const chat_id = update.chat_id || update.message?.recipient?.chat_id
      const user = update.user || update.message?.sender

      if (!chat_id) {
        console.warn('[POLL] Пропускаем апдейт без chat_id:', update.update_type)
        continue
      }

      try {
        if (update.update_type === 'bot_started') {
          await handleBotStarted({ chat_id, user, payload: update.payload })
        } else if (update.update_type === 'message_created') {
          await handleMessage({ chat_id, message: update.message, user })
        } else if (update.update_type === 'message_callback') {
          await handleCallbackQuery(update)
        }
      } catch (err) {
        console.error('[POLL] Handler error:', err.message)
      }
    }
  } catch (err) {
    console.error('[POLL] Network error:', err.message)
    retryDelay = Math.min(retryDelay * 2, 30000)
  } finally {
    polling = false
  }
}

console.log('🔄 Long Polling запущен (ждём события из MAX)...')
setInterval(poll, 1000)
poll()
