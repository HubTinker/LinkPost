const BASE = 'https://platform-api.max.ru'

function headers () {
  return {
    Authorization: process.env.BOT_TOKEN,
    'Content-Type': 'application/json'
  }
}

async function request (method, path, body) {
  console.log('[API] request', method, path)
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
    console.log('[API] success', path, '→', JSON.stringify(result).slice(0, 300))
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
