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

describe('handleCallbackQuery — edit_msg / edit_cancel', () => {
  beforeEach(() => { fetchCalls = []; kv._clear() })

  function cbUpdate (payload, userId = 123) {
    return {
      update_type: 'message_callback',
      callback: { payload, callback_id: 'cb.1', user: { user_id: userId } },
      message: { recipient: { chat_id: 1 }, body: { mid: 'mid.1' } }
    }
  }

  it('edit_msg sets pending, shows prompt, acks callback', async () => {
    await setLink('vip', 'https://example.com', 'Old', 123)
    await handleCallbackQuery(cbUpdate('edit_msg:vip'))
    const pending = await getPendingEdit(123)
    assert.equal(pending.key, 'vip')
    assert.equal(pending.chat_id, 1)
    const ack = fetchCalls.find(c => c.url.includes('/answers'))
    assert.ok(ack, 'ack request not found')
    assert.ok(ack.url.includes('callback_id=cb.1'))
    const prompt = fetchCalls.find(c => c.body?.text?.includes('✏️ Редактирование текста «vip»'))
    assert.ok(prompt, 'prompt not shown')
    const cancelBtn = prompt.body.attachments[0].payload.buttons[0][0]
    assert.equal(cancelBtn.payload, 'edit_cancel:vip')
  })

  it('edit_cancel clears pending and returns card in place', async () => {
    await setLink('vip', 'https://example.com', 'Old', 123)
    await setPendingEdit(123, 'vip', 1)
    await handleCallbackQuery(cbUpdate('edit_cancel:vip'))
    assert.equal(await getPendingEdit(123), null)
    const card = fetchCalls.find(c => c.body?.text?.includes('🔑 Ключ: vip'))
    assert.ok(card, 'card not returned')
  })

  it('any non-edit callback clears pending', async () => {
    await setPendingEdit(123, 'vip', 1)
    await handleCallbackQuery(cbUpdate('links'))
    assert.equal(await getPendingEdit(123), null)
  })

  it('non-admin creator can start editing', async () => {
    await setLink('own', 'https://example.com', 'Text', 999)
    await handleCallbackQuery(cbUpdate('edit_msg:own', 999))
    const pending = await getPendingEdit(999)
    assert.equal(pending?.key, 'own')
  })

  it('non-creator non-admin gets denied without flag', async () => {
    await setLink('vip', 'https://example.com', 'Text', 999)
    await handleCallbackQuery(cbUpdate('edit_msg:vip', 555))
    assert.equal(await getPendingEdit(555), null)
    const err = fetchCalls.find(c => c.body?.text?.includes('⛔'))
    assert.ok(err, 'denial message not sent')
  })

  it('shows error when setPendingEdit fails', async () => {
    await setLink('vip', 'https://example.com', 'Text', 123)
    const originalSet = kv.set
    kv.set = async () => { throw new Error('kv down') }
    try {
      await handleCallbackQuery(cbUpdate('edit_msg:vip'))
    } finally {
      kv.set = originalSet
    }
    const err = fetchCalls.find(c => c.body?.text?.includes('❌ Не удалось начать редактирование'))
    assert.ok(err, 'error message not shown')
    assert.equal(await getPendingEdit(123), null)
  })
})

describe('handleMessage — pending_edit', () => {
  beforeEach(() => { fetchCalls = []; kv._clear() })

  function msgUpdate (text, userId = 123) {
    return {
      chat_id: 1,
      message: text === undefined ? { body: {} } : { body: { text } },
      user: { user_id: userId, name: 'U' }
    }
  }

  it('saves new text, clears flag, shows card with notice', async () => {
    await setLink('vip', 'https://example.com', 'Old text', 123)
    await setPendingEdit(123, 'vip', 1)
    await handleMessage(msgUpdate('New text'))
    const link = await kv.get('link:vip')
    assert.equal(link.message, 'New text')
    assert.equal(await getPendingEdit(123), null)
    const card = fetchCalls.find(c => c.body?.text?.includes('✅ Текст обновлён!'))
    assert.ok(card, 'card with notice not found')
    assert.ok(card.body.text.includes('🔑 Ключ: vip'))
    assert.ok(card.body.text.includes('💬 Сообщение:\nNew text'))
  })

  it('command while pending: resets mode and runs command', async () => {
    await setLink('vip', 'https://example.com', 'Old', 123)
    await setPendingEdit(123, 'vip', 1)
    await handleMessage(msgUpdate('/links'))
    assert.equal(await getPendingEdit(123), null)
    const notice = fetchCalls.find(c => c.body?.text?.includes('⚠️ Режим редактирования сброшен.'))
    assert.ok(notice, 'reset notice not sent')
    const list = fetchCalls.find(c => c.body?.text?.includes('📋 Связки (1, стр. 1 из 1)'))
    assert.ok(list, 'command did not run after reset')
  })

  it('non-text message while pending: warns and keeps flag', async () => {
    await setPendingEdit(123, 'vip', 1)
    await handleMessage(msgUpdate(undefined))
    const warn = fetchCalls.find(c => c.body?.text?.includes('⚠️ Жду текстовое сообщение. Отправьте текст или нажмите «❌ Отмена».'))
    assert.ok(warn, 'warning not sent')
    assert.ok(await getPendingEdit(123), 'flag must stay active')
  })

  it('key deleted while pending: error and flag cleared', async () => {
    await setPendingEdit(123, 'ghost', 1)
    await handleMessage(msgUpdate('some text'))
    const err = fetchCalls.find(c => c.body?.text?.includes('❌ Ключ "ghost" не найден.'))
    assert.ok(err, 'error not sent')
    assert.equal(await getPendingEdit(123), null)
  })

  it('truncates incoming text to 4096', async () => {
    await setLink('vip', 'https://example.com', 'Old', 123)
    await setPendingEdit(123, 'vip', 1)
    await handleMessage(msgUpdate('а'.repeat(5000)))
    const link = await kv.get('link:vip')
    assert.equal(link.message.length, 4096)
  })

  it('denies non-creator non-admin and clears flag', async () => {
    await setLink('vip', 'https://example.com', 'Text', 999)
    await setPendingEdit(555, 'vip', 1)
    await handleMessage(msgUpdate('hijack attempt', 555))
    const err = fetchCalls.find(c => c.body?.text?.includes('⛔ Вы можете редактировать только свои ключи.'))
    assert.ok(err, 'denial not sent')
    assert.equal(await getPendingEdit(555), null)
    assert.equal((await kv.get('link:vip')).message, 'Text', 'link must stay untouched')
  })
})

describe('pending_edit clear failure surfaced', () => {
  beforeEach(() => { fetchCalls = []; kv._clear() })

  const WARN = '⚠️ Не удалось сбросить режим редактирования, попробуйте ещё раз.'

  function msgUpdate (text, userId = 123) {
    return {
      chat_id: 1,
      message: { body: { text } },
      user: { user_id: userId, name: 'U' }
    }
  }

  function cbUpdate (payload, userId = 123) {
    return {
      update_type: 'message_callback',
      callback: { payload, callback_id: 'cb.1', user: { user_id: userId } },
      message: { recipient: { chat_id: 1 }, body: { mid: 'mid.1' } }
    }
  }

  async function withDelFailure (fn) {
    const originalDel = kv.del
    kv.del = async () => { throw new Error('kv down') }
    try {
      await fn()
    } finally {
      kv.del = originalDel
    }
  }

  it('save path appends warning when flag clear fails', async () => {
    await setLink('vip', 'https://example.com', 'Old', 123)
    await setPendingEdit(123, 'vip', 1)
    await withDelFailure(() => handleMessage(msgUpdate('New text')))
    const card = fetchCalls.find(c => c.body?.text?.includes('✅ Текст обновлён!'))
    assert.ok(card, 'card with success notice not sent')
    assert.ok(card.body.text.includes(WARN), 'warning line must be appended to notice')
    assert.ok(await getPendingEdit(123), 'flag must stay set')
  })

  it('edit_cancel appends warning when flag clear fails', async () => {
    await setLink('vip', 'https://example.com', 'Old', 123)
    await setPendingEdit(123, 'vip', 1)
    await withDelFailure(() => handleCallbackQuery(cbUpdate('edit_cancel:vip')))
    const card = fetchCalls.find(c => c.body?.text?.includes('🔑 Ключ: vip'))
    assert.ok(card, 'card must still be rendered')
    assert.ok(card.body.text.includes(WARN), 'warning line must be appended to notice')
    assert.ok(await getPendingEdit(123), 'flag must stay set')
  })
})
