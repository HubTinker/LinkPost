import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.BOT_TOKEN = 'test-token'
process.env.ADMIN_USER_IDS = '123'
process.env.BOT_NICK = 'TestBot'

let fetchCalls
global.fetch = async (url, opts) => {
  if (!fetchCalls) fetchCalls = []
  fetchCalls.push({ url, body: JSON.parse(opts?.body || '{}') })
  return {
    ok: true,
    json: async () => ({ ok: true }),
    text: async () => '',
    status: 200
  }
}

const { kv } = await import('../lib/kv-mock.js')
const {
  createBroadcast, getBroadcast, getBroadcastStats, getCursor,
  markSent, markFailed, setCursor, resetBroadcastStats
} = await import('../lib/broadcast.js')
const { handleMessage, handleBotStarted } = await import('../api/index.js')
const { setLink: setLinkFromStorage } = await import('../lib/storage.js')
const { daysAgo } = await import('../lib/storage.js')

describe('handleMessage guard', () => {
  beforeEach(() => {
    fetchCalls = []
  })

  it('should not throw when chat_id is undefined (guard works)', async () => {
    await assert.doesNotReject(
      () => handleMessage({ chat_id: undefined, message: { body: { text: 'test' } }, user: null })
    )
  })

  it('should not throw when chat_id is missing from object', async () => {
    await assert.doesNotReject(
      () => handleMessage({ message: { body: { text: 'test' } } })
    )
  })
})

describe('handleBotStarted', () => {
  beforeEach(() => {
    fetchCalls = []
    kv._clear()
  })

  it('should show admin panel for admin without payload', async () => {
    await handleBotStarted({ chat_id: 1, user: { user_id: 123 }, payload: null })
    const responseCall = fetchCalls.find(c => c.body.text && c.body.text.includes('Привет'))
    assert.ok(responseCall, 'response call not found')
    assert.ok(responseCall.body.text.includes('Админ'), 'should mention admin')
    assert.ok(responseCall.body.text.includes('пользователей'), 'should show user count')
  })

  it('should show welcome message for non-admin without payload', async () => {
    await handleBotStarted({ chat_id: 1, user: { user_id: 999 }, payload: null })
    const responseCall = fetchCalls.find(c => c.body.text && c.body.text.includes('Привет'))
    assert.ok(responseCall, 'response call not found')
    assert.ok(responseCall.body.text.includes('ключ'), 'should mention key')
  })

  it('should return link for valid payload', async () => {
    await kv.set('link:vipkey', { url: 'https://example.com', message: 'Welcome!' })
    await handleBotStarted({ chat_id: 1, user: { user_id: 999 }, payload: 'vipkey' })
    const responseCall = fetchCalls.find(c => c.body.attachments)
    assert.ok(responseCall, 'response with attachment not found')
    assert.equal(responseCall.body.attachments[0].type, 'inline_keyboard')
    assert.ok(responseCall.body.text.includes('Welcome!'), 'should include message')
    const btn = responseCall.body.attachments[0].payload.buttons[0][0]
    assert.equal(btn.text, '👉 Перейти в канал', 'should use LINK_BUTTON_LABEL')
  })

  it('should show error for invalid payload', async () => {
    await handleBotStarted({ chat_id: 1, user: { user_id: 999 }, payload: 'nonexistent' })
    const responseCall = fetchCalls.find(c => c.body.text && c.body.text.includes('❌'))
    assert.ok(responseCall, 'error response not found')
  })
})

describe('handleMessage commands', () => {
  beforeEach(() => {
    fetchCalls = []
    kv._clear()
  })

  it('/setlink should create a link for admin', async () => {
    await handleMessage({
      chat_id: 1,
      message: { body: { text: '/setlink test https://example.com Hello!' } },
      user: { user_id: 123 }
    })
    const saved = await kv.get('link:test')
    assert.equal(saved.url, 'https://example.com')
    assert.equal(saved.message, 'Hello!')
    assert.equal(saved.creator_id, 123)
    assert.ok(typeof saved.created_at === 'number')
    const responseCall = fetchCalls.find(c => c.body.text && c.body.text.includes('✅'))
    assert.ok(responseCall, 'success response not found')
  })

  it('/setlink should be silently ignored for non-admin', async () => {
    await handleMessage({
      chat_id: 1,
      message: { body: { text: '/setlink test https://example.com Hello!' } },
      user: { user_id: 999 }
    })
    const saved = await kv.get('link:test')
    assert.equal(saved, null, 'link should not be saved')
    const msgCalls = fetchCalls.filter(c => c.body.text)
    assert.equal(msgCalls.length, 0, 'non-admin should get no response')
  })

  it('/setlink should validate URL format', async () => {
    await handleMessage({
      chat_id: 1,
      message: { body: { text: '/setlink bad not-a-url msg' } },
      user: { user_id: 123 }
    })
    const responseCall = fetchCalls.find(c => c.body.text && c.body.text.includes('http'))
    assert.ok(responseCall, 'URL validation error not found')
  })

  it('/setlink should require all arguments', async () => {
    await handleMessage({
      chat_id: 1,
      message: { body: { text: '/setlink onlykey' } },
      user: { user_id: 123 }
    })
    const responseCall = fetchCalls.find(c => c.body.text && c.body.text.includes('Формат'))
    assert.ok(responseCall, 'format error not found')
  })

  it('/setlink should reject key longer than 50 characters', async () => {
    await handleMessage({
      chat_id: 1,
      message: { body: { text: `/setlink ${'a'.repeat(51)} https://example.com msg` } },
      user: { user_id: 123 }
    })
    const responseCall = fetchCalls.find(c => c.body.text && c.body.text.includes('слишком длинный'))
    assert.ok(responseCall, 'key length validation error not found')
  })

  it('/setlink should reject URL longer than 2048 characters', async () => {
    const longUrl = `https://x.com/${'a'.repeat(2035)}`
    await handleMessage({
      chat_id: 1,
      message: { body: { text: `/setlink k ${longUrl} msg` } },
      user: { user_id: 123 }
    })
    const responseCall = fetchCalls.find(c => c.body.text && c.body.text.includes('слишком длинный'))
    assert.ok(responseCall, 'URL length validation error not found')
  })

  it('/dellink should show confirmation instead of deleting', async () => {
    await kv.set('link:test', { url: 'https://example.com', message: 'Msg' })
    await handleMessage({
      chat_id: 1,
      message: { body: { text: '/dellink test' } },
      user: { user_id: 123 }
    })
    const saved = await kv.get('link:test')
    assert.ok(saved, 'link should NOT be deleted yet')
    const responseCall = fetchCalls.find(c => c.body.text && c.body.text.includes('🗑 Удалить'))
    assert.ok(responseCall, 'confirmation prompt not found')
    assert.ok(responseCall.body.attachments[0].type === 'inline_keyboard', 'should have keyboard')
    const buttons = responseCall.body.attachments[0].payload.buttons.flat()
    assert.ok(buttons.some(b => b.payload === 'confirm_del:test'), 'should have confirm_del button')
    assert.ok(buttons.some(b => b.payload === 'back'), 'should have back button')
  })

  it('/dellink should warn on missing key', async () => {
    await handleMessage({
      chat_id: 1,
      message: { body: { text: '/dellink nonexistent' } },
      user: { user_id: 123 }
    })
    const responseCall = fetchCalls.find(c => c.body.text && c.body.text.includes('не найден'))
    assert.ok(responseCall, 'not found warning not found')
  })

  it('/dellink should be silently ignored for non-admin (not owner)', async () => {
    await setLinkFromStorage('test', 'https://example.com', 'Msg', 123)
    await handleMessage({
      chat_id: 1,
      message: { body: { text: '/dellink test' } },
      user: { user_id: 999 }
    })
    const msgCalls = fetchCalls.filter(c => c.body.text)
    assert.equal(msgCalls.length, 0, 'non-admin should get no response')
  })

  it('/links should list links with commands', async () => {
    await kv.set('link:a', { url: 'https://a.com', message: 'A' })
    await kv.sadd('links_all', 'a')
    await kv.set('link:b', { url: 'https://b.com', message: 'B' })
    await kv.sadd('links_all', 'b')
    await handleMessage({
      chat_id: 1,
      message: { body: { text: '/links' } },
      user: { user_id: 123 }
    })
    const responseCall = fetchCalls.find(c => c.body.text && c.body.text.includes('📋 Связки'))
    assert.ok(responseCall, 'links list not found')
    assert.ok(responseCall.body.text.includes('/link a'), 'should show command for first link')
    assert.ok(responseCall.body.text.includes('/link b'), 'should show command for second link')
    const buttons = responseCall.body.attachments[0].payload.buttons.flat()
    assert.ok(buttons.some(b => b.payload === 'back'), 'admin should have back button')
  })

  it('/links should show empty state for admin', async () => {
    await handleMessage({
      chat_id: 1,
      message: { body: { text: '/links' } },
      user: { user_id: 123 }
    })
    const responseCall = fetchCalls.find(c => c.body.text && c.body.text.includes('📭'))
    assert.ok(responseCall, 'empty state not found')
    assert.ok(responseCall.body.text.includes('Нет активных связок'), 'admin empty text expected')
    const buttons = responseCall.body.attachments[0].payload.buttons.flat()
    assert.ok(buttons.some(b => b.payload === 'back'), 'admin should have back button')
  })

  it('/links should show empty state for non-admin without keyboard', async () => {
    await handleMessage({
      chat_id: 1,
      message: { body: { text: '/links' } },
      user: { user_id: 999 }
    })
    const responseCall = fetchCalls.find(c => c.body.text && c.body.text.includes('📭'))
    assert.ok(responseCall, 'empty state not found')
    assert.ok(responseCall.body.text.includes('У вас пока нет связок'), 'creator empty text expected')
    assert.ok(!responseCall.body.attachments, 'creator should get no keyboard')
  })

  it('/links should paginate 20 per page and clamp page number', async () => {
    for (let i = 1; i <= 21; i++) {
      const key = `key${String(i).padStart(2, '0')}`
      await kv.set(`link:${key}`, { url: `https://${key}.com`, message: 'M' })
      await kv.sadd('links_all', key)
    }
    await handleMessage({
      chat_id: 1,
      message: { body: { text: '/links' } },
      user: { user_id: 123 }
    })
    const page1 = fetchCalls.find(c => c.body?.text?.includes('стр. 1 из 2'))
    assert.ok(page1, 'page 1 header not found')
    assert.ok(page1.body.text.includes('/link key01'), 'should list first item')
    assert.ok(!page1.body.text.includes('/link key21'), 'page 1 should not contain item 21')
    const buttons1 = page1.body.attachments[0].payload.buttons.flat()
    assert.ok(buttons1.some(b => b.payload === 'links_page:2'), 'should have next button')
    assert.ok(!buttons1.some(b => b.payload === 'links_page:0'), 'should not have prev button on page 1')

    fetchCalls = []
    await handleMessage({
      chat_id: 1,
      message: { body: { text: '/links 2' } },
      user: { user_id: 123 }
    })
    const page2 = fetchCalls.find(c => c.body?.text?.includes('стр. 2 из 2'))
    assert.ok(page2, 'page 2 header not found')
    assert.ok(page2.body.text.includes('/link key21'), 'should list item 21 on page 2')
    assert.ok(!page2.body.text.includes('/link key01'), 'page 2 should not contain first item')
    const buttons2 = page2.body.attachments[0].payload.buttons.flat()
    assert.ok(!buttons2.some(b => b.payload === 'links_page:3'), 'should not have next button on last page')
    assert.ok(buttons2.some(b => b.payload === 'links_page:1'), 'should have prev button on page 2')

    fetchCalls = []
    await handleMessage({
      chat_id: 1,
      message: { body: { text: '/links 99' } },
      user: { user_id: 123 }
    })
    assert.ok(fetchCalls.find(c => c.body?.text?.includes('стр. 2 из 2')), 'should clamp to last page')

    fetchCalls = []
    await handleMessage({
      chat_id: 1,
      message: { body: { text: '/links abc' } },
      user: { user_id: 123 }
    })
    assert.ok(fetchCalls.find(c => c.body?.text?.includes('стр. 1 из 2')), 'non-numeric page should default to 1')
  })

  it('/links should sort links by key', async () => {
    await kv.set('link:b', { url: 'https://b.com', message: 'B' })
    await kv.sadd('links_all', 'b')
    await kv.set('link:a', { url: 'https://a.com', message: 'A' })
    await kv.sadd('links_all', 'a')
    await kv.set('link:c', { url: 'https://c.com', message: 'C' })
    await kv.sadd('links_all', 'c')
    await handleMessage({
      chat_id: 1,
      message: { body: { text: '/links' } },
      user: { user_id: 123 }
    })
    const responseCall = fetchCalls.find(c => c.body?.text?.includes('📋 Связки'))
    assert.ok(responseCall, 'list not found')
    const idxA = responseCall.body.text.indexOf('/link a')
    const idxB = responseCall.body.text.indexOf('/link b')
    const idxC = responseCall.body.text.indexOf('/link c')
    assert.ok(idxA < idxB && idxB < idxC, 'should be sorted a, b, c')
  })

  it('/users should return user count', async () => {
    await kv.sadd('users_all', '1')
    await kv.sadd('users_all', '2')
    await handleMessage({
      chat_id: 1,
      message: { body: { text: '/users' } },
      user: { user_id: 123 }
    })
    const responseCall = fetchCalls.find(c => c.body.text && c.body.text.includes('В базе'))
    assert.ok(responseCall, 'users response not found')
    assert.ok(
      responseCall.body.text.includes('3') || responseCall.body.text.includes('2'),
      'should show total user count'
    )
  })

  it('/users should be silently ignored for non-admin', async () => {
    await handleMessage({
      chat_id: 1,
      message: { body: { text: '/users' } },
      user: { user_id: 999 }
    })
    const msgCalls = fetchCalls.filter(c => c.body.text)
    assert.equal(msgCalls.length, 0, 'non-admin should get no response')
  })
})

describe('handleMessage key lookup (admin only)', () => {
  beforeEach(() => {
    fetchCalls = []
    kv._clear()
  })

  it('should ignore non-command text for non-admin users', async () => {
    await kv.set('link:mykey', { url: 'https://channel.com', message: 'Welcome!' })
    await handleMessage({
      chat_id: 1,
      message: { body: { text: 'mykey' } },
      user: { user_id: 999 }
    })
    // Should only have markAsRead call
    const msgCalls = fetchCalls.filter(c => c.body.text)
    assert.equal(msgCalls.length, 0, 'non-admin should not get key lookup response')
  })

  it('should ignore unknown commands starting with /', async () => {
    await handleMessage({
      chat_id: 1,
      message: { body: { text: '/unknown' } },
      user: { user_id: 123 }
    })
    assert.equal(fetchCalls.length, 1, 'only markAsRead should be called')
    assert.equal(fetchCalls[0].body?.action, 'mark_seen', 'should only mark as read')
  })

  it('/start should trigger handleBotStarted from handleMessage', async () => {
    await handleMessage({
      chat_id: 1,
      message: { body: { text: '/start' } },
      user: { user_id: 123 }
    })
    const responseCall = fetchCalls.find(c => c.body.text && c.body.text.includes('Привет'))
    assert.ok(responseCall, 'start response not found')
    assert.ok(responseCall.body.text.includes('Админ'), 'should show admin panel')
  })
})

describe('subscribed_key on bot_started', () => {
  beforeEach(() => {
    fetchCalls = []
    kv._clear()
  })

  it('should save user with subscribed_key and add to link_subs', async () => {
    await kv.set('link:vipkey', { url: 'https://example.com', message: 'Welcome!' })
    await handleBotStarted({ chat_id: 1, user: { user_id: 999, name: 'User' }, payload: 'vipkey' })
    const user = await kv.get('user:999')
    assert.equal(user.subscribed_key, 'vipkey')
    const subs = await kv.smembers('link_subs:vipkey')
    assert.ok(subs.includes('999'))
  })

  it('should reactivate inactive user on bot_started', async () => {
    await kv.set('user:999', { user_id: 999, name: 'User', inactive: true })
    await kv.sadd('users_all', '999')
    await kv.set('link:key', { url: 'https://x.com', message: 'Welcome!' })
    await handleBotStarted({ chat_id: 1, user: { user_id: 999, name: 'User' }, payload: 'key' })
    const user = await kv.get('user:999')
    assert.equal(user.inactive, false)
  })
})

const { handleCallbackQuery } = await import('../api/index.js')

describe('callback_query handling', () => {
  beforeEach(() => {
    fetchCalls = []
    kv._clear()
  })

  it('should show confirmation on del: callback without deleting', async () => {
    await kv.set('link:test', { url: 'https://x.com', message: 'Msg', creator_id: 123 })
    await handleCallbackQuery({
      callback: { payload: 'del:test', user: { user_id: 123 } },
      message: { recipient: { chat_id: 1 } }
    })
    const saved = await kv.get('link:test')
    assert.ok(saved, 'link should NOT be deleted yet')
    const responseCall = fetchCalls.find(c => c.body?.text?.includes('🗑 Удалить'))
    assert.ok(responseCall, 'confirmation prompt not found')
    assert.equal(responseCall.body.attachments[0].type, 'inline_keyboard')
    const buttons = responseCall.body.attachments[0].payload.buttons.flat()
    assert.ok(buttons.some(b => b.payload === 'confirm_del:test'), 'should have confirm_del button')
    assert.ok(buttons.some(b => b.payload === 'links'), 'should have links button')
  })

  it('should delete link on confirm_del: callback', async () => {
    await kv.set('link:test', { url: 'https://x.com', message: 'Msg', creator_id: 123 })
    await handleCallbackQuery({
      callback: { payload: 'confirm_del:test', user: { user_id: 123 } },
      message: { recipient: { chat_id: 1 } }
    })
    const saved = await kv.get('link:test')
    assert.equal(saved, null)
    const responseCall = fetchCalls.find(c => c.body?.text?.includes('удалена'))
    assert.ok(responseCall, 'success message not found')
    assert.ok(responseCall.body.text.includes('test'), 'should mention key name')
    const buttons = responseCall.body.attachments[0].payload.buttons.flat()
    const backBtn = buttons.find(b => b.payload === 'links')
    assert.ok(backBtn, 'should have back-to-list button')
    assert.equal(backBtn.text, '🔙 К списку')
  })

  it('should show main menu on back callback', async () => {
    await handleCallbackQuery({
      callback: { payload: 'back', user: { user_id: 123 } },
      message: { recipient: { chat_id: 1 } }
    })
    const responseCall = fetchCalls.find(c => c.body?.text?.includes('Привет'))
    assert.ok(responseCall, 'menu response not found')
    assert.ok(responseCall.body.text.includes('Админ'), 'should show admin menu')
  })

  it('should show links list via links callback', async () => {
    await kv.set('link:a', { url: 'https://a.com', message: 'A' })
    await kv.sadd('links_all', 'a')
    await handleCallbackQuery({
      callback: { payload: 'links', user: { user_id: 123 } },
      message: { recipient: { chat_id: 1 } }
    })
    const responseCall = fetchCalls.find(c => c.body?.text?.includes('📋 Связки'))
    assert.ok(responseCall, 'links list not found')
    assert.ok(responseCall.body.text.includes('/link a'), 'should show link command')
    const buttons = responseCall.body.attachments[0].payload.buttons.flat()
    assert.ok(buttons.some(b => b.payload === 'back'), 'should have back button')
    assert.ok(!buttons.some(b => b.payload?.startsWith('del:')), 'list should not have delete buttons')
  })

  it('should show empty links state with back button', async () => {
    await handleCallbackQuery({
      callback: { payload: 'links', user: { user_id: 123 } },
      message: { recipient: { chat_id: 1 } }
    })
    const responseCall = fetchCalls.find(c => c.body?.text?.includes('📭'))
    assert.ok(responseCall, 'empty state not found')
    const buttons = responseCall.body.attachments[0].payload.buttons.flat()
    assert.ok(buttons.some(b => b.payload === 'back'), 'should have back button')
  })

  it('should show create help with back button', async () => {
    await handleCallbackQuery({
      callback: { payload: 'create', user: { user_id: 123 } },
      message: { recipient: { chat_id: 1 } }
    })
    const responseCall = fetchCalls.find(c => c.body?.text?.includes('/setlink'))
    assert.ok(responseCall, 'create help not found')
    const buttons = responseCall.body.attachments[0].payload.buttons.flat()
    assert.ok(buttons.some(b => b.payload === 'back'), 'should have back button')
  })

  it('should show users count with back button', async () => {
    await handleCallbackQuery({
      callback: { payload: 'users', user: { user_id: 123 } },
      message: { recipient: { chat_id: 1 } }
    })
    const responseCall = fetchCalls.find(c => c.body?.text?.includes('В базе'))
    assert.ok(responseCall, 'users response not found')
    const buttons = responseCall.body.attachments[0].payload.buttons.flat()
    assert.ok(buttons.some(b => b.payload === 'back'), 'should have back button')
  })

  it('should show broadcast menu with back button', async () => {
    await handleCallbackQuery({
      callback: { payload: 'broadcast_menu', user: { user_id: 123 } },
      message: { recipient: { chat_id: 1 } }
    })
    const responseCall = fetchCalls.find(c => c.body?.text?.includes('Рассылки'))
    assert.ok(responseCall, 'broadcast_menu response not found')
    const buttons = responseCall.body.attachments[0].payload.buttons.flat()
    assert.ok(buttons.some(b => b.payload === 'back'), 'should have back button')
  })

  it('should handle confirm_del: with colon in key name', async () => {
    await kv.set('link:key:sub', { url: 'https://x.com', message: 'Msg', creator_id: 123 })
    await handleCallbackQuery({
      callback: { payload: 'confirm_del:key:sub', user: { user_id: 123 } },
      message: { recipient: { chat_id: 1 } }
    })
    const saved = await kv.get('link:key:sub')
    assert.equal(saved, null)
    const responseCall = fetchCalls.find(c => c.body?.text?.includes('удалена'))
    assert.ok(responseCall, 'delete response not found')
    assert.ok(responseCall.body.text.includes('key:sub'), 'should mention full key with colon')
  })

  it('should allow admin to delete foreign link', async () => {
    await kv.set('link:foreign', { url: 'https://x.com', message: 'Msg', creator_id: 999 })
    await handleCallbackQuery({
      callback: { payload: 'del:foreign', user: { user_id: 123 } },
      message: { recipient: { chat_id: 1 } }
    })
    assert.ok(await kv.get('link:foreign'), 'link should NOT be deleted at del: step')
    const confirmCall = fetchCalls.find(c => c.body?.text?.includes('🗑 Удалить'))
    assert.ok(confirmCall, 'confirmation prompt not found')
    await handleCallbackQuery({
      callback: { payload: 'confirm_del:foreign', user: { user_id: 123 } },
      message: { recipient: { chat_id: 1 } }
    })
    assert.equal(await kv.get('link:foreign'), null)
  })

  it('should deny del: for non-admin with unified message without leaking data', async () => {
    await kv.set('link:secret', { url: 'https://secret.com', message: 'SECRET_TEXT', creator_id: 123 })
    await handleCallbackQuery({
      callback: { payload: 'del:secret', user: { user_id: 999 } },
      message: { recipient: { chat_id: 1 } }
    })
    const responseCall = fetchCalls.find(c => c.body?.text)
    assert.ok(responseCall, 'response expected')
    assert.ok(responseCall.body.text.includes('не найден или у вас нет прав'), 'unified message expected')
    assert.ok(!responseCall.body.text.includes('SECRET_TEXT'), 'must not leak message')
    assert.ok(!responseCall.body.text.includes('secret.com'), 'must not leak url')
  })

  it('should ignore disallowed callback for non-admin', async () => {
    await handleCallbackQuery({
      callback: { payload: 'users', user: { user_id: 999 } },
      message: { recipient: { chat_id: 1 } }
    })
    const msgCalls = fetchCalls.filter(c => c.body.text)
    assert.equal(msgCalls.length, 0, 'non-admin should get no response')
  })

  it('should show hint on back callback for non-admin', async () => {
    await handleCallbackQuery({
      callback: { payload: 'back', user: { user_id: 999 } },
      message: { recipient: { chat_id: 1 } }
    })
    const responseCall = fetchCalls.find(c => c.body?.text?.includes('/links'))
    assert.ok(responseCall, 'hint not found')
    assert.ok(!responseCall.body.text.includes('Админ'), 'should not show admin menu')
  })

  it('should navigate via links_page callback', async () => {
    for (let i = 1; i <= 21; i++) {
      const key = `key${String(i).padStart(2, '0')}`
      await kv.set(`link:${key}`, { url: `https://${key}.com`, message: 'M' })
      await kv.sadd('links_all', key)
    }
    await handleCallbackQuery({
      callback: { payload: 'links_page:2', user: { user_id: 123 } },
      message: { recipient: { chat_id: 1 } }
    })
    assert.ok(fetchCalls.find(c => c.body?.text?.includes('стр. 2 из 2')), 'page 2 not found')
  })

  it('should show own links on links_page for non-admin', async () => {
    await setLinkFromStorage('own', 'https://own.com', 'Own', 999)
    await setLinkFromStorage('admin', 'https://admin.com', 'Admin', 123)
    await handleCallbackQuery({
      callback: { payload: 'links_page:1', user: { user_id: 999 } },
      message: { recipient: { chat_id: 1 } }
    })
    const responseCall = fetchCalls.find(c => c.body?.text?.includes('Ваши связки'))
    assert.ok(responseCall, 'own links not found')
    assert.ok(responseCall.body.text.includes('/link own'), 'should list own link')
    assert.ok(!responseCall.body.text.includes('/link admin'), 'should not list foreign link')
  })
})

describe('non-admin command access', () => {
  beforeEach(() => {
    fetchCalls = []
    kv._clear()
  })

  it('/links should show own links for non-admin', async () => {
    await setLinkFromStorage('own', 'https://own.com', 'Own', 999)
    await setLinkFromStorage('admin', 'https://admin.com', 'Admin', 123)
    await handleMessage({
      chat_id: 1,
      message: { body: { text: '/links' } },
      user: { user_id: 999 }
    })
    const responseCall = fetchCalls.find(c => c.body?.text?.includes('Ваши связки'))
    assert.ok(responseCall, 'own links list not found')
    assert.ok(responseCall.body.text.includes('/link own'), 'should list own link')
    assert.ok(!responseCall.body.text.includes('/link admin'), 'should NOT list foreign link')
  })

  it('/dellink should be silently ignored for non-admin (own key)', async () => {
    await setLinkFromStorage('mykey', 'https://x.com', 'Msg', 999)
    await handleMessage({
      chat_id: 1,
      message: { body: { text: '/dellink mykey' } },
      user: { user_id: 999 }
    })
    const msgCalls = fetchCalls.filter(c => c.body.text)
    assert.equal(msgCalls.length, 0, 'non-admin should get no response')
  })

  it('/dellink should be silently ignored for non-admin (others key)', async () => {
    await setLinkFromStorage('adminkey', 'https://x.com', 'Msg', 123)
    await handleMessage({
      chat_id: 1,
      message: { body: { text: '/dellink adminkey' } },
      user: { user_id: 999 }
    })
    const msgCalls = fetchCalls.filter(c => c.body.text)
    assert.equal(msgCalls.length, 0, 'non-admin should get no response')
  })

  it('/setlink for admin should store creator_id', async () => {
    await handleMessage({
      chat_id: 1,
      message: { body: { text: '/setlink newkey https://new.com Hello!' } },
      user: { user_id: 123 }
    })
    const saved = await kv.get('link:newkey')
    assert.equal(saved.creator_id, 123)
    const userLinks = await kv.smembers('user_links:123')
    assert.ok(userLinks.includes('newkey'))
  })
})

describe('/stats command', () => {
  beforeEach(() => {
    fetchCalls = []
    kv._clear()
  })

  it('/stats for admin with existing key should show statistics', async () => {
    await kv.set('link:testkey', { url: 'https://x.com', message: 'Msg', created_at: Date.now() - 86400000 * 2 })
    await kv.sadd('links_all', 'testkey')
    await kv.sadd('link_subs:testkey', '100')
    await kv.sadd('link_subs:testkey', '200')
    await kv.incr('stats:new:testkey:' + daysAgo(0))
    await kv.incr('stats:new:testkey:' + daysAgo(0))
    await kv.incr('stats:new:testkey:' + daysAgo(1))

    await handleMessage({
      chat_id: 1,
      message: { body: { text: '/stats testkey' } },
      user: { user_id: 123 }
    })
    const responseCall = fetchCalls.find(c => c.body.text && c.body.text.includes('📊'))
    assert.ok(responseCall, 'stats response not found')
    assert.ok(responseCall.body.text.includes('testkey'), 'should mention key name')
    assert.ok(responseCall.body.text.includes('Всего:'), 'should show total')
  })

  it('/stats should be silently ignored for non-admin', async () => {
    await kv.set('link:testkey', { url: 'https://x.com', message: 'Msg', created_at: Date.now() })
    await handleMessage({
      chat_id: 1,
      message: { body: { text: '/stats testkey' } },
      user: { user_id: 999 }
    })
    const msgCalls = fetchCalls.filter(c => c.body.text)
    assert.equal(msgCalls.length, 0, 'non-admin should get no response')
  })

  it('/stats without key should show format help', async () => {
    await handleMessage({
      chat_id: 1,
      message: { body: { text: '/stats' } },
      user: { user_id: 123 }
    })
    const responseCall = fetchCalls.find(c => c.body.text && c.body.text.includes('Формат'))
    assert.ok(responseCall, 'format help not found')
  })

  it('/stats with nonexistent key should show error', async () => {
    await handleMessage({
      chat_id: 1,
      message: { body: { text: '/stats nonexistent' } },
      user: { user_id: 123 }
    })
    const responseCall = fetchCalls.find(c => c.body.text && c.body.text.includes('не найден'))
    assert.ok(responseCall, 'not found error not found')
  })

  it('callback stats should show submenu with three buttons', async () => {
    const { handleCallbackQuery } = await import('../api/index.js')
    await handleCallbackQuery({
      callback: { payload: 'stats', user: { user_id: 123 } },
      message: { recipient: { chat_id: 1 } }
    })
    const responseCall = fetchCalls.find(c => c.body.text && c.body.text.includes('Статистика'))
    assert.ok(responseCall, 'stats submenu response not found')
    const buttons = responseCall.body.attachments[0].payload.buttons.flat()
    assert.ok(buttons.some(b => b.payload === 'stats_general'), 'should have stats_general button')
    assert.ok(buttons.some(b => b.payload === 'stats_by_key'), 'should have stats_by_key button')
    assert.ok(buttons.some(b => b.payload === 'stats_top'), 'should have stats_top button')
    assert.ok(buttons.some(b => b.payload === 'back'), 'should have back button')
  })

  it('callback stats_general should show general statistics', async () => {
    await kv.sadd('users_all', '1')
    await kv.sadd('users_all', '2')
    await kv.incr('stats:new:total:' + daysAgo(0))
    await kv.incr('stats:new:total:' + daysAgo(0))
    await kv.incr('stats:new:total:' + daysAgo(1))

    const { handleCallbackQuery } = await import('../api/index.js')
    await handleCallbackQuery({
      callback: { payload: 'stats_general', user: { user_id: 123 } },
      message: { recipient: { chat_id: 1 } }
    })
    const responseCall = fetchCalls.find(c => c.body.text && c.body.text.includes('Общая статистика'))
    assert.ok(responseCall, 'general stats response not found')
    assert.ok(responseCall.body.text.includes('пользователей'), 'should show total users')
    const buttons = responseCall.body.attachments[0].payload.buttons.flat()
    assert.ok(buttons.some(b => b.payload === 'back'), 'should have back button')
  })

  it('callback stats_by_key should show key buttons', async () => {
    await kv.set('link:a', { url: 'https://a.com', message: 'A' })
    await kv.sadd('links_all', 'a')
    await kv.set('link:b', { url: 'https://b.com', message: 'B' })
    await kv.sadd('links_all', 'b')

    const { handleCallbackQuery } = await import('../api/index.js')
    await handleCallbackQuery({
      callback: { payload: 'stats_by_key', user: { user_id: 123 } },
      message: { recipient: { chat_id: 1 } }
    })
    const responseCall = fetchCalls.find(c => c.body.text && c.body.text.includes('Выберите ключ'))
    assert.ok(responseCall, 'stats_by_key response not found')
    const buttons = responseCall.body.attachments[0].payload.buttons.flat()
    assert.ok(buttons.some(b => b.payload === 'stats_key:a'), 'should have stats_key:a button')
    assert.ok(buttons.some(b => b.payload === 'stats_key:b'), 'should have stats_key:b button')
    assert.ok(buttons.some(b => b.payload === 'back'), 'should have back button')
  })

  it('callback stats_by_key without links should show empty state', async () => {
    const { handleCallbackQuery } = await import('../api/index.js')
    await handleCallbackQuery({
      callback: { payload: 'stats_by_key', user: { user_id: 123 } },
      message: { recipient: { chat_id: 1 } }
    })
    const responseCall = fetchCalls.find(c => c.body.text && c.body.text.includes('📭'))
    assert.ok(responseCall, 'empty state not found')
    const buttons = responseCall.body.attachments[0].payload.buttons.flat()
    assert.ok(buttons.some(b => b.payload === 'back'), 'should have back button')
  })

  it('callback stats_key:xxx should show detailed key stats', async () => {
    await kv.set('link:vip', { url: 'https://vip.com', message: 'VIP', created_at: Date.now() - 86400000 * 2 })
    await kv.sadd('links_all', 'vip')
    await kv.sadd('link_subs:vip', '100')
    await kv.sadd('link_subs:vip', '200')
    await kv.incr('stats:new:vip:' + daysAgo(0))
    await kv.incr('stats:new:vip:' + daysAgo(0))
    await kv.incr('stats:new:vip:' + daysAgo(1))

    const { handleCallbackQuery } = await import('../api/index.js')
    await handleCallbackQuery({
      callback: { payload: 'stats_key:vip', user: { user_id: 123 } },
      message: { recipient: { chat_id: 1 } }
    })
    const responseCall = fetchCalls.find(c => c.body.text && c.body.text.includes('vip'))
    assert.ok(responseCall, 'stats_key response not found')
    assert.ok(responseCall.body.text.includes('Всего:'), 'should show total')
    assert.ok(responseCall.body.text.includes('Сегодня:'), 'should show today')
    const buttons = responseCall.body.attachments[0].payload.buttons.flat()
    assert.ok(buttons.some(b => b.payload === 'del:vip'), 'should have delete button')
    assert.ok(buttons.some(b => b.payload === 'stats_by_key'), 'should have back to list button')
  })

  it('callback stats_key:nonexistent should show error', async () => {
    const { handleCallbackQuery } = await import('../api/index.js')
    await handleCallbackQuery({
      callback: { payload: 'stats_key:ghost', user: { user_id: 123 } },
      message: { recipient: { chat_id: 1 } }
    })
    const responseCall = fetchCalls.find(c => c.body.text && c.body.text.includes('не найден'))
    assert.ok(responseCall, 'not found error not found')
    assert.ok(responseCall.body.text.includes('ghost'), 'should mention key name')
  })

  it('callback stats_top should show ranked keys', async () => {
    await kv.set('link:a', { url: 'https://a.com', message: 'A', created_at: Date.now() })
    await kv.sadd('links_all', 'a')
    await kv.set('link:b', { url: 'https://b.com', message: 'B', created_at: Date.now() })
    await kv.sadd('links_all', 'b')
    await kv.sadd('link_subs:a', '1')
    await kv.sadd('link_subs:a', '2')
    await kv.sadd('link_subs:a', '3')
    await kv.sadd('link_subs:b', '10')

    const { handleCallbackQuery } = await import('../api/index.js')
    await handleCallbackQuery({
      callback: { payload: 'stats_top', user: { user_id: 123 } },
      message: { recipient: { chat_id: 1 } }
    })
    const responseCall = fetchCalls.find(c => c.body.text && c.body.text.includes('Топ ключей'))
    assert.ok(responseCall, 'stats_top response not found')
    assert.ok(responseCall.body.text.includes('a'), 'should list key a')
    assert.ok(responseCall.body.text.includes('b'), 'should list key b')
    const buttons = responseCall.body.attachments[0].payload.buttons.flat()
    assert.ok(buttons.some(b => b.payload === 'back'), 'should have back button')
  })

  it('callback stats_top without links should show empty state', async () => {
    const { handleCallbackQuery } = await import('../api/index.js')
    await handleCallbackQuery({
      callback: { payload: 'stats_top', user: { user_id: 123 } },
      message: { recipient: { chat_id: 1 } }
    })
    const responseCall = fetchCalls.find(c => c.body.text && c.body.text.includes('📭'))
    assert.ok(responseCall, 'empty state not found')
  })
})

describe('broadcast_test callback', () => {
  beforeEach(() => {
    fetchCalls = []
    kv._clear()
  })

  it('should send test message to admin chat', async () => {
    const b = await createBroadcast({ text: 'Test broadcast', created_by: 123 })
    await handleCallbackQuery({
      callback: { payload: `broadcast_test:${b.id}`, user: { user_id: 123 } },
      message: { recipient: { chat_id: 1 } }
    })
    const sendCalls = fetchCalls.filter(c => c.url?.includes('chat_id=1'))
    assert.ok(sendCalls.length >= 1, 'should send message to admin chat')
    assert.ok(sendCalls.some(c => c.body.text === 'Test broadcast'), 'should include broadcast text')
  })

  it('should show error for nonexistent broadcast', async () => {
    await handleCallbackQuery({
      callback: { payload: 'broadcast_test:nonexistent', user: { user_id: 123 } },
      message: { recipient: { chat_id: 1 } }
    })
    const responseCall = fetchCalls.find(c => c.body?.text?.includes('не найдена'))
    assert.ok(responseCall, 'should show not found error')
  })
})

describe('broadcast_restart callback', () => {
  beforeEach(() => {
    fetchCalls = []
    kv._clear()
  })

  it('should reset stats and show confirmation screen', async () => {
    const b = await createBroadcast({ text: 'Restart me', created_by: 123 })
    await markSent(b.id, 100)
    await markFailed(b.id, 200)
    await setCursor(b.id, 15)

    await handleCallbackQuery({
      callback: { payload: `broadcast_restart:${b.id}`, user: { user_id: 123 } },
      message: { recipient: { chat_id: 1 } }
    })

    const stats = await getBroadcastStats(b.id)
    assert.strictEqual(stats.sent, 0, 'sent should be reset')
    assert.strictEqual(stats.failed, 0, 'failed should be reset')

    const cursor = await getCursor(b.id)
    assert.strictEqual(cursor, 0, 'cursor should be reset')

    const updated = await getBroadcast(b.id)
    assert.strictEqual(updated.status, 'draft', 'status should be draft')

    const responseCall = fetchCalls.find(c => c.body?.text?.includes('Отправить сейчас'))
    assert.ok(responseCall, 'should show send confirmation')
  })

  it('should show error for nonexistent broadcast', async () => {
    await handleCallbackQuery({
      callback: { payload: 'broadcast_restart:nonexistent', user: { user_id: 123 } },
      message: { recipient: { chat_id: 1 } }
    })
    const responseCall = fetchCalls.find(c => c.body?.text?.includes('не найдена'))
    assert.ok(responseCall, 'should show not found error')
  })
})

describe('broadcast_confirm_now flow', () => {
  beforeEach(() => {
    fetchCalls = []
    kv._clear()
  })

  it('should send broadcast to all users', async () => {
    await kv.sadd('users_all', '100')
    await kv.sadd('users_all', '200')
    await kv.set('user:100', { user_id: 100, name: 'Alice' })
    await kv.set('user:200', { user_id: 200, name: 'Bob' })

    const b = await createBroadcast({ text: 'Hi everyone', created_by: 123 })

    await handleCallbackQuery({
      callback: { payload: `broadcast_confirm_now:${b.id}`, user: { user_id: 123 } },
      message: { recipient: { chat_id: 1 } }
    })

    const sendToUser100 = fetchCalls.filter(c => c.url?.includes('chat_id=100'))
    const sendToUser200 = fetchCalls.filter(c => c.url?.includes('chat_id=200'))
    assert.strictEqual(sendToUser100.length, 1, 'should send to user 100')
    assert.strictEqual(sendToUser200.length, 1, 'should send to user 200')
  })

  it('should continue sending despite errors on individual users', async () => {
    await kv.sadd('users_all', '100')
    await kv.sadd('users_all', '200')
    await kv.set('user:100', { user_id: 100, name: 'Alice' })
    await kv.set('user:200', { user_id: 200, name: 'Bob' })

    const b = await createBroadcast({ text: 'Error test', created_by: 123 })

    const originalFetch = global.fetch
    global.fetch = async (url, opts) => {
      if (typeof url === 'string' && url.includes('chat_id=100')) {
        throw new Error('Network error for user 100')
      }
      return { ok: true, json: async () => ({ ok: true }), text: async () => '', status: 200 }
    }

    try {
      await handleCallbackQuery({
        callback: { payload: `broadcast_confirm_now:${b.id}`, user: { user_id: 123 } },
        message: { recipient: { chat_id: 1 } }
      })
    } finally {
      global.fetch = originalFetch
    }

    const stats = await getBroadcastStats(b.id)
    assert.strictEqual(stats.failed, 1, 'first user should be marked failed')
    assert.strictEqual(stats.sent, 1, 'second user should be marked sent')
  })
})
