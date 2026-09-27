import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.BOT_TOKEN = 'test-token'
process.env.ADMIN_USER_IDS = '123'
process.env.BOT_NICK = 'TestBot'

let fetchCalls
global.fetch = async (url, opts) => {
  if (!fetchCalls) fetchCalls = []
  fetchCalls.push({ url, method: opts?.method || 'GET', body: JSON.parse(opts?.body || '{}') })
  return {
    ok: true,
    json: async () => ({ ok: true, message: { body: { mid: 999 } } }),
    text: async () => '',
    status: 200
  }
}

const { kv } = await import('../lib/kv-mock.js')
const { answerCallback } = await import('../lib/max-api.js')
const { setLink, setPendingEdit, getPendingEdit } = await import('../lib/storage.js')
const { handleMessage, handleCallbackQuery } = await import('../api/index.js')

describe('answerCallback', () => {
  beforeEach(() => { fetchCalls = [] })

  it('should POST /answers with callback_id', async () => {
    await answerCallback('cb.123')
    const ack = fetchCalls.find(c => c.url.includes('/answers'))
    assert.ok(ack, 'ack request not found')
    assert.ok(ack.url.includes('callback_id=cb.123'))
    assert.equal(ack.method, 'POST')
  })

  it('should skip request when callbackId is missing', async () => {
    await answerCallback(undefined)
    assert.equal(fetchCalls.filter(c => c.url.includes('/answers')).length, 0)
  })
})

describe('showLinkCard — кнопка редактирования', () => {
  beforeEach(() => { fetchCalls = [] ; kv._clear() })

  it('/link shows card with edit button in first row', async () => {
    await setLink('vip', 'https://example.com', 'Hello', 123)
    await handleMessage({
      chat_id: 1,
      message: { body: { text: '/link vip' } },
      user: { user_id: 123, name: 'Admin' }
    })
    const card = fetchCalls.find(c => c.body?.text?.includes('🔑 Ключ: vip'))
    assert.ok(card, 'card message not found')
    const firstRow = card.body.attachments[0].payload.buttons[0]
    assert.equal(firstRow[0].text, '✏️')
    assert.equal(firstRow[0].payload, 'edit_msg:vip')
    assert.equal(firstRow[1].payload, 'del:vip')
    assert.equal(firstRow[2].payload, 'link_preview:vip')
  })

  it('card renders without notice for existing callers', async () => {
    await setLink('vip', 'https://example.com', 'Hello', 123)
    await handleMessage({
      chat_id: 1,
      message: { body: { text: '/link vip' } },
      user: { user_id: 123, name: 'Admin' }
    })
    const card = fetchCalls.find(c => c.body?.text?.includes('🔑 Ключ: vip'))
    assert.ok(card.body.text.startsWith('🔑 Ключ: vip'), 'notice must be absent by default')
  })
})
