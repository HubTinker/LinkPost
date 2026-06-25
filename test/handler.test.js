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
const { handleMessage, handleBotStarted } = await import('../api/index.js')
const { setLink: setLinkFromStorage } = await import('../lib/storage.js')

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
    assert.deepEqual(saved, { url: 'https://example.com', message: 'Hello!', creator_id: 123 })
    const responseCall = fetchCalls.find(c => c.body.text && c.body.text.includes('✅'))
    assert.ok(responseCall, 'success response not found')
  })

  it('/setlink should be denied for non-admin', async () => {
    await handleMessage({
      chat_id: 1,
      message: { body: { text: '/setlink test https://example.com Hello!' } },
      user: { user_id: 999 }
    })
    const saved = await kv.get('link:test')
    assert.equal(saved, null, 'link should not be saved')
    const responseCall = fetchCalls.find(c => c.body.text && c.body.text.includes('⛔'))
    assert.ok(responseCall, 'deny response not found')
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

  it('/dellink should be denied for non-admin (not owner)', async () => {
    await setLinkFromStorage('test', 'https://example.com', 'Msg', 123)
    await handleMessage({
      chat_id: 1,
      message: { body: { text: '/dellink test' } },
      user: { user_id: 999 }
    })
    const responseCall = fetchCalls.find(c => c.body.text && c.body.text.includes('удалять'))
    assert.ok(responseCall, 'ownership deny response not found')
  })

  it('/links should list all links', async () => {
    await kv.set('link:a', { url: 'https://a.com', message: 'A' })
    await kv.sadd('links_all', 'a')
    await kv.set('link:b', { url: 'https://b.com', message: 'B' })
    await kv.sadd('links_all', 'b')
    await handleMessage({
      chat_id: 1,
      message: { body: { text: '/links' } },
      user: { user_id: 123 }
    })
    const responseCall = fetchCalls.find(c => c.body.text && c.body.text.includes('Активные связки'))
    assert.ok(responseCall, 'links list not found')
    assert.ok(responseCall.body.text.includes('a.com'), 'should list first link')
    assert.ok(responseCall.body.text.includes('b.com'), 'should list second link')
  })

  it('/links should show empty state', async () => {
    await handleMessage({
      chat_id: 1,
      message: { body: { text: '/links' } },
      user: { user_id: 123 }
    })
    const responseCall = fetchCalls.find(c => c.body.text && c.body.text.includes('📭'))
    assert.ok(responseCall, 'empty state not found')
  })

  it('/links for non-admin should show empty list when no owned links', async () => {
    await handleMessage({
      chat_id: 1,
      message: { body: { text: '/links' } },
      user: { user_id: 999 }
    })
    const responseCall = fetchCalls.find(c => c.body.text && c.body.text.includes('📭'))
    assert.ok(responseCall, 'empty state not found for non-admin')
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

  it('/users should be denied for non-admin', async () => {
    await handleMessage({
      chat_id: 1,
      message: { body: { text: '/users' } },
      user: { user_id: 999 }
    })
    const responseCall = fetchCalls.find(c => c.body.text && c.body.text.includes('⛔'))
    assert.ok(responseCall, 'deny response not found')
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
    const responseCall = fetchCalls.find(c => c.body?.text?.includes('🗑'))
    assert.ok(responseCall, 'delete confirmation not found')
    assert.ok(responseCall.body.text.includes('test'), 'should mention key name')
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

  it('should show links list with back button', async () => {
    await kv.set('link:a', { url: 'https://a.com', message: 'A' })
    await kv.sadd('links_all', 'a')
    await handleCallbackQuery({
      callback: { payload: 'links', user: { user_id: 123 } },
      message: { recipient: { chat_id: 1 } }
    })
    const responseCall = fetchCalls.find(c => c.body?.text?.includes('Активные связки'))
    assert.ok(responseCall, 'links list not found')
    const buttons = responseCall.body.attachments[0].payload.buttons.flat()
    assert.ok(buttons.some(b => b.payload === 'back'), 'should have back button')
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

  it('should show broadcast placeholder with back button', async () => {
    await handleCallbackQuery({
      callback: { payload: 'broadcast', user: { user_id: 123 } },
      message: { recipient: { chat_id: 1 } }
    })
    const responseCall = fetchCalls.find(c => c.body?.text?.includes('Рассылка'))
    assert.ok(responseCall, 'broadcast response not found')
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
    const responseCall = fetchCalls.find(c => c.body?.text?.includes('🗑'))
    assert.ok(responseCall, 'delete response not found')
    assert.ok(responseCall.body.text.includes('key:sub'), 'should mention full key with colon')
  })

  it('should deny callback for non-admin', async () => {
    await handleCallbackQuery({
      callback: { payload: 'del:test', user: { user_id: 999 } },
      message: { recipient: { chat_id: 1 } }
    })
    const responseCall = fetchCalls.find(c => c.body?.text?.includes('⛔'))
    assert.ok(responseCall, 'deny response not found')
  })
})

describe('link creator ownership in handlers', () => {
  beforeEach(() => {
    fetchCalls = []
    kv._clear()
  })

  it('/links for non-admin should show only owned links', async () => {
    await setLinkFromStorage('a', 'https://a.com', 'A', 999)
    await setLinkFromStorage('b', 'https://b.com', 'B', 123)
    await handleMessage({
      chat_id: 1,
      message: { body: { text: '/links' } },
      user: { user_id: 999 }
    })
    const responseCall = fetchCalls.find(c => c.body.text && c.body.text.includes('a.com'))
    assert.ok(responseCall, 'should show owned link a.com')
    assert.ok(!responseCall.body.text.includes('b.com'), 'should NOT show link b.com owned by 123')
  })

  it('/dellink should allow non-admin to request delete of own key', async () => {
    await setLinkFromStorage('mykey', 'https://x.com', 'Msg', 999)
    await handleMessage({
      chat_id: 1,
      message: { body: { text: '/dellink mykey' } },
      user: { user_id: 999 }
    })
    const responseCall = fetchCalls.find(c => c.body.text && c.body.text.includes('🗑 Удалить'))
    assert.ok(responseCall, 'should show confirmation for own key deletion')
  })

  it('/dellink should deny non-admin from deleting others key', async () => {
    await setLinkFromStorage('adminkey', 'https://x.com', 'Msg', 123)
    await handleMessage({
      chat_id: 1,
      message: { body: { text: '/dellink adminkey' } },
      user: { user_id: 999 }
    })
    const responseCall = fetchCalls.find(c => c.body.text && c.body.text.includes('удалять'))
    assert.ok(responseCall, 'should deny deletion of others key')
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
