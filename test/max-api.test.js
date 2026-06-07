import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// Мокаем fetch + BOT_TOKEN до импорта модуля
process.env.BOT_TOKEN = 'test-token'
const BASE = 'https://platform-api.max.ru'

let lastFetchUrl, lastFetchOpts
global.fetch = async (url, opts) => {
  lastFetchUrl = url
  lastFetchOpts = opts
  return {
    ok: true,
    json: async () => ({ ok: true }),
    text: async () => '',
    status: 200
  }
}

const { sendMessage, sendMessageWithLink } = await import('../lib/max-api.js')

describe('sendMessage', () => {
  it('should throw when chatId is null', async () => {
    await assert.rejects(
      () => sendMessage(null, 'hello'),
      { message: 'chatId is required, got null' }
    )
  })

  it('should throw when chatId is undefined', async () => {
    await assert.rejects(
      () => sendMessage(undefined, 'hello'),
      { message: 'chatId is required, got undefined' }
    )
  })

  it('should succeed with valid chatId', async () => {
    lastFetchUrl = null
    await sendMessage(123, 'hello')
    assert.ok(lastFetchUrl?.includes('chat_id=123'))
  })
})

describe('sendMessageWithLink', () => {
  it('should throw when chatId is null', async () => {
    await assert.rejects(
      () => sendMessageWithLink(null, 'text', { label: 'btn', url: 'https://example.com' }),
      { message: 'chatId is required, got null' }
    )
  })

  it('should throw when chatId is undefined', async () => {
    await assert.rejects(
      () => sendMessageWithLink(undefined, 'text', { label: 'btn', url: 'https://example.com' }),
      { message: 'chatId is required, got undefined' }
    )
  })
})
