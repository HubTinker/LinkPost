import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.BOT_TOKEN = 'test-token'

let fetchCalls
global.fetch = async (url, opts) => {
  if (!fetchCalls) fetchCalls = []
  fetchCalls.push({ url: String(url), method: opts?.method || 'GET', body: JSON.parse(opts?.body || '{}') })
  if (global.fetchFailUrls?.some(part => String(url).includes(part))) {
    throw new Error('fetch failed (mocked)')
  }
  return { ok: true, json: async () => ({ ok: true, message: { body: { mid: 999 } } }), text: async () => '', status: 200 }
}

const { kv } = await import('../lib/kv-mock.js')
const { setNavMessageId } = await import('../lib/nav.js')
const { renderScreen } = await import('../api/index.js')

const BUTTONS = [[{ type: 'callback', text: '🔙', data: 'back' }]]

function byUrl (part) {
  return fetchCalls.filter(c => c.url.includes(part))
}

describe('renderScreen', () => {
  beforeEach(() => {
    fetchCalls = []
    global.fetchFailUrls = []
    kv._clear()
  })

  it('should edit source message when editMsgId present (no send/delete)', async () => {
    await renderScreen({ chatId: 1, editMsgId: 90, text: 'hello', buttons: BUTTONS })
    const edits = byUrl('message_id=90')
    assert.equal(edits.length, 1)
    assert.equal(edits[0].method, 'PUT')
    assert.equal(edits[0].body.text, 'hello')
    assert.equal(edits[0].body.attachments[0].type, 'inline_keyboard')
    assert.equal(byUrl('chat_id=1').filter(c => !c.url.includes('message_id')).length, 0, 'send must not be called')
    assert.equal(byUrl('message_id=90').filter(c => c.method === 'DELETE').length, 0, 'delete must not be called')
    assert.strictEqual(await kv.get('nav_msg:1'), 90, 'nav id should be stored')
  })

  it('should delete source and send new when edit fails', async () => {
    global.fetchFailUrls = ['message_id=90']
    await renderScreen({ chatId: 1, editMsgId: 90, text: 'hello', buttons: BUTTONS })
    assert.ok(byUrl('message_id=90').some(c => c.method === 'PUT' && c.body.text), 'edit attempt expected')
    assert.ok(byUrl('message_id=90').some(c => c.method === 'DELETE'), 'delete attempt expected')
    const send = byUrl('chat_id=1').find(c => !c.url.includes('message_id'))
    assert.ok(send, 'send fallback expected')
    assert.equal(send.body.text, 'hello')
    assert.strictEqual(await kv.get('nav_msg:1'), 999, 'new message id stored')
  })

  it('should edit nav message when message_id missing but nav id exists', async () => {
    await setNavMessageId(1, 77)
    await renderScreen({ chatId: 1, editMsgId: null, text: 'hello', buttons: BUTTONS })
    const edits = byUrl('message_id=77')
    assert.equal(edits.length, 1)
    assert.equal(edits[0].method, 'PUT')
    assert.equal(byUrl('chat_id=1').filter(c => !c.url.includes('message_id')).length, 0, 'send must not be called')
  })

  it('should send new message when neither message_id nor nav id exist', async () => {
    await renderScreen({ chatId: 1, editMsgId: null, text: 'hello', buttons: BUTTONS })
    assert.equal(byUrl('message_id').length, 0)
    const send = byUrl('chat_id=1').find(c => !c.url.includes('message_id'))
    assert.ok(send, 'send expected')
    assert.equal(send.body.text, 'hello')
    assert.strictEqual(await kv.get('nav_msg:1'), 999)
  })

  it('should send new message when useNavFallback is false even if nav id exists', async () => {
    await setNavMessageId(1, 77)
    await renderScreen({ chatId: 1, editMsgId: null, text: 'hello', buttons: BUTTONS, useNavFallback: false })
    const send = byUrl('chat_id=1').find(c => !c.url.includes('message_id'))
    assert.ok(send, 'send expected')
    assert.equal(send.method, 'POST')
    assert.equal(send.body.text, 'hello')
    assert.equal(byUrl('message_id=77').length, 0, 'nav message must not be edited')
    assert.strictEqual(await kv.get('nav_msg:1'), 999, 'new message id stored as nav')
  })

  it('should NOT use nav message after source edit failure (hard invariant)', async () => {
    await setNavMessageId(1, 77)
    global.fetchFailUrls = ['message_id=90']
    await renderScreen({ chatId: 1, editMsgId: 90, text: 'hello', buttons: BUTTONS })
    assert.ok(byUrl('message_id=90').some(c => c.method === 'PUT' && c.body.text), 'source edit attempted')
    assert.equal(byUrl('message_id=77').length, 0, 'nav must never be used after source edit failure')
    assert.ok(byUrl('message_id=90').some(c => c.method === 'DELETE'), 'delete source attempted')
    assert.ok(byUrl('chat_id=1').some(c => !c.url.includes('message_id')), 'send fallback expected')
  })

  it('should not delete or resend when nav persistence fails after successful edit', async () => {
    // Правка плана №1: сбой KV не должен превращать успешный edit в fallback
    const origSet = kv.set
    kv.set = async () => { throw new Error('kv down') }
    try {
      await renderScreen({ chatId: 1, editMsgId: 90, text: 'hello', buttons: BUTTONS })
    } finally {
      kv.set = origSet
    }
    const edits = byUrl('message_id=90')
    assert.equal(edits.length, 1, 'edit should be attempted once')
    assert.equal(edits[0].method, 'PUT')
    assert.equal(byUrl('message_id=90').filter(c => c.method === 'DELETE').length, 0, 'no delete after successful edit')
    assert.equal(byUrl('chat_id=1').filter(c => !c.url.includes('message_id')).length, 0, 'no fallback send')
  })

  it('should throw when buttons is empty', async () => {
    await assert.rejects(
      () => renderScreen({ chatId: 1, editMsgId: null, text: 'hello', buttons: [] }),
      /buttons required/
    )
  })
})
