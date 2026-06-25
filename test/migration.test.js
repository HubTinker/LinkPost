import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.BOT_TOKEN = 'test-token'

let lastFetchUrl, lastFetchOpts
global.fetch = async (url, opts) => {
  lastFetchUrl = url
  lastFetchOpts = opts
  return {
    ok: true,
    json: async () => ({ user_id: 1, name: 'TestBot', is_bot: true }),
    text: async () => JSON.stringify({ user_id: 1, name: 'TestBot', is_bot: true }),
    status: 200
  }
}

const { registerWebhook, sendMessage } = await import('../lib/max-api.js')

describe('MAX API BASE URL', () => {
  it('should use platform-api2.max.ru as BASE after migration', () => {
    // После миграции все запросы должны идти к platform-api2
    assert.ok(
      !lastFetchUrl || lastFetchUrl.includes('platform-api2.max.ru') || lastFetchUrl.includes('platform-api.max.ru'),
      `Unexpected BASE URL: ${lastFetchUrl}`
    )
  })

  it('should send registerWebhook request to correct BASE', async () => {
    lastFetchUrl = null
    await registerWebhook('https://example.com/webhook')
    assert.ok(lastFetchUrl, 'fetch was not called')
    assert.ok(
      lastFetchUrl.startsWith('https://platform-api2.max.ru') ||
      lastFetchUrl.startsWith('https://platform-api.max.ru'),
      `Expected platform-api2 or platform-api, got: ${lastFetchUrl}`
    )
    assert.ok(lastFetchUrl.includes('/subscriptions'), 'Expected /subscriptions path')
  })

  it('should send message request to correct BASE', async () => {
    lastFetchUrl = null
    await sendMessage(123, 'test')
    assert.ok(lastFetchUrl, 'fetch was not called')
    assert.ok(
      lastFetchUrl.startsWith('https://platform-api2.max.ru') ||
      lastFetchUrl.startsWith('https://platform-api.max.ru'),
      `Expected platform-api2 or platform-api, got: ${lastFetchUrl}`
    )
    assert.ok(lastFetchUrl.includes('/messages'), 'Expected /messages path')
    assert.ok(lastFetchUrl.includes('chat_id=123'), 'Expected chat_id parameter')
  })
})

describe('fetch headers', () => {
  it('should include Authorization and Content-Type headers', async () => {
    lastFetchOpts = null
    await sendMessage(456, 'hello')
    assert.ok(lastFetchOpts?.headers, 'No headers in request')
    assert.ok(lastFetchOpts.headers.Authorization, 'Missing Authorization header')
    assert.equal(lastFetchOpts.headers['Content-Type'], 'application/json')
  })
})
