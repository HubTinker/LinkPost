import tls from 'node:tls'
import { readFileSync, existsSync } from 'node:fs'

const BASE = 'https://platform-api2.max.ru'

let allCAs = null
try {
  if (process.env.NODE_EXTRA_CA_CERTS && existsSync('certs/mincifra-chain.pem')) {
    const extraPem = readFileSync('certs/mincifra-chain.pem').toString()
    // Разбиваем файл на отдельные сертификаты
    const extraCerts = extraPem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || []
    allCAs = [...tls.rootCertificates, ...extraCerts]
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
    const socket = tls.connect({
      host: url.hostname,
      port: url.port || 443,
      ca: allCAs
    }, () => {
      // Write raw HTTP request
      socket.write(`${method} ${url.pathname}${url.search} HTTP/1.1\r\n`)
      socket.write(`Host: ${url.hostname}\r\n`)
      for (const [k, v] of Object.entries(headers())) {
        socket.write(`${k}: ${v}\r\n`)
      }
      if (bodyStr) {
        socket.write(`Content-Length: ${Buffer.byteLength(bodyStr)}\r\n`)
      }
      socket.write(`Connection: close\r\n`)
      socket.write(`\r\n`)
      if (bodyStr) socket.write(bodyStr)

      let data = ''
      socket.on('data', chunk => { data += chunk })
      socket.on('end', () => {
        const headerEnd = data.indexOf('\r\n\r\n')
        if (headerEnd === -1) {
          reject(new Error('MAX API invalid HTTP response'))
          return
        }
        const headerLines = data.slice(0, headerEnd).split('\r\n')
        const statusLine = headerLines[0]
        const statusCode = parseInt(statusLine.split(' ')[1], 10)
        const body = data.slice(headerEnd + 4)

        if (statusCode < 200 || statusCode >= 300) {
          console.error('[API] error', statusCode, body)
          reject(new Error(`MAX API error ${statusCode}: ${body}`))
          return
        }
        try {
          const result = JSON.parse(body)
          console.log('[API] success', path, '\u2192', JSON.stringify(result).slice(0, 300))
          resolve(result)
        } catch (e) {
          console.error('[API] JSON parse error', e.message)
          reject(new Error(`MAX API invalid JSON: ${body.slice(0, 200)}`))
        }
      })
    })

    socket.on('error', (err) => {
      console.error('[API] request failed:', err.message)
      reject(err)
    })
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

export async function sendBroadcastMessage (chatId, broadcast) {
  if (chatId == null) {
    console.error('[API] sendBroadcastMessage: chatId is required')
    throw new Error(`chatId is required, got ${chatId}`)
  }

  const payload = {
    text: broadcast.text
  }

  if (broadcast.format && broadcast.format !== 'plain') {
    payload.format = broadcast.format
  }

  const attachments = []

  if (broadcast.images && broadcast.images.length) {
    for (const fileId of broadcast.images) {
      attachments.push({
        type: 'image',
        payload: { file_id: fileId }
      })
    }
  }

  if (broadcast.buttons && broadcast.buttons.length) {
    attachments.push({
      type: 'inline_keyboard',
      payload: {
        buttons: broadcast.buttons.map(row => {
          const btnRow = Array.isArray(row) ? row : [row]
          return btnRow.map(btn => ({
            type: 'link',
            text: btn.text,
            url: btn.url
          }))
        })
      }
    })
  }

  if (attachments.length) {
    payload.attachments = attachments
  }

  return request('POST', `/messages?chat_id=${chatId}`, payload)
}

export async function uploadFile (fileBuffer, filename) {
  throw new Error('File upload not yet implemented. Send images directly to the bot in chat to obtain file_id.')
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
