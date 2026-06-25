import https from 'node:https'
import tls from 'node:tls'
import { readFileSync, existsSync } from 'node:fs'

const BASE = 'https://platform-api.max.ru'

let allCAs = null
try {
  if (process.env.NODE_EXTRA_CA_CERTS && existsSync('certs/mincifra-chain.pem')) {
    const extra = readFileSync('certs/mincifra-chain.pem').toString()
    // Объединяем системные CA + наш сертификат (ca заменяет, а не дополняет)
    allCAs = [...tls.rootCertificates, extra]
    console.log('[API] loaded combined CA certs, count:', allCAs.length)
  }
} catch (e) {
  console.log('[API] no custom CA cert', e.message)
}

function headers () {
  return {
    Authorization: process.env.BOT_TOKEN,
    'Content-Type': 'application/json'
  }
}

function nodeRequest (method, path, body) {
  const url = new URL(`${BASE}${path}`)
  const bodyStr = body ? JSON.stringify(body) : undefined

  return new Promise((resolve, reject) => {
    const options = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method,
      headers: headers(),
      ca: allCAs
    }

    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          console.error('[API] error', res.statusCode, data)
          reject(new Error(`MAX API error ${res.statusCode}: ${data}`))
          return
        }
        try {
          const result = JSON.parse(data)
          console.log('[API] success', path, '\u2192', JSON.stringify(result).slice(0, 300))
          resolve(result)
        } catch (e) {
          console.error('[API] JSON parse error', e.message)
          reject(new Error(`MAX API invalid JSON: ${data.slice(0, 200)}`))
        }
      })
    })

    req.on('error', reject)
    if (bodyStr) req.write(bodyStr)
    req.end()
  })
}

async function request (method, path, body) {
  console.log('[API] request', method, path)

  if (allCAs) return nodeRequest(method, path, body)

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: headers(),
    body: body ? JSON.stringify(body) : undefined
  })

  if (!res.ok) {
    const err = await res.text()
    console.error('[API] error', res.status, err)
    throw new Error(`MAX API error ${res.status}: ${err}`)
  }

  const result = await res.json()
  console.log('[API] success', path, '\u2192', JSON.stringify(result).slice(0, 300))
  return result
}

export async function sendMessage (chatId, text, extra = {}) {
  if (chatId == null) {
    console.error('[API] sendMessage: chatId is required')
    throw new Error(`chatId is required, got ${chatId}`)
  }
  return request('POST', `/messages?chat_id=${chatId}`, {
    text,
    ...extra
  })
}

export async function sendMessageWithLink (chatId, text, btn, format) {
  if (chatId == null) {
    console.error('[API] sendMessageWithLink: chatId is required')
    throw new Error(`chatId is required, got ${chatId}`)
  }
  return request('POST', `/messages?chat_id=${chatId}`, {
    text,
    ...(format ? { format } : {}),
    attachments: [
      {
        type: 'inline_keyboard',
        payload: {
          buttons: [[{ type: 'link', text: btn.label, url: btn.url }]]
        }
      }
    ]
  })
}

export async function sendMessageWithKeyboard (chatId, text, buttons) {
  if (chatId == null) {
    console.error('[API] sendMessageWithKeyboard: chatId is required')
    throw new Error(`chatId is required, got ${chatId}`)
  }
  const payload = {
    text,
    attachments: [
      {
        type: 'inline_keyboard',
        payload: {
          buttons: buttons.map(row =>
            row.map(btn => ({
              type: 'callback',
              text: btn.text,
              payload: btn.data
            }))
          )
        }
      }
    ]
  }
  console.log('[API] sendMessageWithKeyboard payload:', JSON.stringify(payload, null, 2))
  return request('POST', `/messages?chat_id=${chatId}`, payload)
}

export async function markAsRead (chatId) {
  return request('POST', `/chats/${chatId}/actions`, { action: 'mark_seen' })
}

export async function registerWebhook (webhookUrl) {
  return request('POST', '/subscriptions', {
    url: webhookUrl,
    update_types: ['bot_started', 'message_created', 'message_callback']
  })
}
