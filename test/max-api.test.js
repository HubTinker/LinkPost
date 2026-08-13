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

const { editMessageWithKeyboard, deleteMessage, extractMessageId } = await import('../lib/max-api.js')

describe('editMessageWithKeyboard', () => {
  it('should throw when chatId is null', async () => {
    await assert.rejects(
      () => editMessageWithKeyboard(null, 90, 'text', [[]]),
      { message: 'chatId is required, got null' }
    )
  })

  it('should throw when messageId is null', async () => {
    await assert.rejects(
      () => editMessageWithKeyboard(1, null, 'text', [[]]),
      { message: 'messageId is required, got null' }
    )
  })

  it('should PUT with chat_id, message_id and inline keyboard', async () => {
    lastFetchUrl = null
    lastFetchOpts = null
    await editMessageWithKeyboard(1, 90, 'hello', [
      [{ type: 'callback', text: '🔙', data: 'back' }]
    ])
    assert.equal(lastFetchOpts.method, 'PUT')
    assert.ok(lastFetchUrl.includes('chat_id=1'))
    assert.ok(lastFetchUrl.includes('message_id=90'))
    const body = JSON.parse(lastFetchOpts.body)
    assert.equal(body.text, 'hello')
    assert.equal(body.attachments[0].type, 'inline_keyboard')
    assert.deepEqual(body.attachments[0].payload.buttons, [
      [{ type: 'callback', text: '🔙', payload: 'back' }]
    ])
  })
})

describe('deleteMessage', () => {
  it('should throw when chatId is null', async () => {
    await assert.rejects(
      () => deleteMessage(null, 90),
      { message: 'chatId is required, got null' }
    )
  })

  it('should throw when messageId is null', async () => {
    await assert.rejects(
      () => deleteMessage(1, null),
      { message: 'messageId is required, got null' }
    )
  })

  it('should DELETE with chat_id and message_id', async () => {
    lastFetchUrl = null
    lastFetchOpts = null
    await deleteMessage(1, 90)
    assert.equal(lastFetchOpts.method, 'DELETE')
    assert.ok(lastFetchUrl.includes('chat_id=1'))
    assert.ok(lastFetchUrl.includes('message_id=90'))
    assert.equal(lastFetchOpts.body, undefined)
  })
})


describe('extractMessageId', () => {
  it('should extract mid from message.body.mid (real MAX API shape)', () => {
    assert.equal(extractMessageId({ message: { body: { mid: 'mid.abc' } } }), 'mid.abc')
  })

  it('should fall back to message_id', () => {
    assert.equal(extractMessageId({ message_id: 42 }), 42)
  })

  it('should return null when no id present', () => {
    assert.equal(extractMessageId({ ok: true }), null)
    assert.equal(extractMessageId(null), null)
  })
})
