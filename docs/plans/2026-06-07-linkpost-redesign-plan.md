# LinkPost Redesign Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Refactor LinkPost bot to associate users with specific keys, add admin inline buttons with delete confirmation, remove text-key input for non-admins, and add inactive user tracking via send errors.

**Architecture:** Horizontal expansion of existing layered architecture (Hono → storage/max-api). New KV Sets `link_subs:<key>` track key→users. Admin panel adds inline keyboard with callback handling. Inactive flag toggled on send errors / re-entry.

**Tech Stack:** Hono.js, Vercel KV (Redis), MAX Bot API, Node test runner

**Design Doc:** `docs/plans/2026-06-07-linkpost-redesign-design.md`

---

### Task 1: Update storage layer — key subscriptions and inactive flag [x]

**Files:**
- Modify: `lib/storage.js`
- Test: `test/storage.test.js` (new)

**Step 1: Write failing tests for new storage methods**

Create `test/storage.test.js`:

```js
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

const { kv } = await import('../lib/kv-mock.js')
const {
  setLink, getLink, delLink, getAllLinks,
  saveUser, getUserCount, getAllUsers,
  addUserToLink, getLinkSubs,
  markInactive, reactivateUser
} = await import('../lib/storage.js')

describe('addUserToLink / getLinkSubs', () => {
  beforeEach(() => kv._clear())

  it('should add user to link subscription set', async () => {
    await addUserToLink('vip', 123)
    await addUserToLink('vip', 456)
    const subs = await getLinkSubs('vip')
    assert.deepEqual(subs.sort(), [123, 456])
  })

  it('should return empty array for nonexistent key', async () => {
    const subs = await getLinkSubs('nonexistent')
    assert.deepEqual(subs, [])
  })
})

describe('markInactive / reactivateUser', () => {
  beforeEach(() => kv._clear())

  it('should mark user as inactive', async () => {
    await saveUser({ user_id: 123, name: 'Test' })
    await markInactive(123)
    const user = await kv.get('user:123')
    assert.equal(user.inactive, true)
  })

  it('should reactivate user', async () => {
    await saveUser({ user_id: 123, name: 'Test' })
    await markInactive(123)
    await reactivateUser(123)
    const user = await kv.get('user:123')
    assert.equal(user.inactive, false)
  })
})

describe('saveUser with subscribed_key', () => {
  beforeEach(() => kv._clear())

  it('should save user with subscribed_key', async () => {
    await saveUser({ user_id: 123, name: 'Test', username: '@test' }, 'vip')
    const user = await kv.get('user:123')
    assert.equal(user.subscribed_key, 'vip')
    assert.equal(user.inactive, false)
  })

  it('should add user to link_subs set when subscribed_key provided', async () => {
    await saveUser({ user_id: 123, name: 'Test' }, 'vip')
    const subs = await getLinkSubs('vip')
    assert.ok(subs.includes(123))
  })
})
```

**Step 2: Run tests to verify they fail**

Run: `node --test test/storage.test.js`
Expected: FAIL — methods not defined

**Step 3: Implement new storage methods**

Edit `lib/storage.js`:

Add constants:
```js
const LINK_SUBS_PREFIX = 'link_subs:'
```

Add after `getAllLinks()`:

```js
export async function addUserToLink (key, userId) {
  await kv.sadd(`${LINK_SUBS_PREFIX}${key}`, String(userId))
}

export async function getLinkSubs (key) {
  const ids = await kv.smembers(`${LINK_SUBS_PREFIX}${key}`)
  return ids?.map(Number) ?? []
}

export async function markInactive (userId) {
  const user = await kv.get(`${USER_PREFIX}${userId}`)
  if (user) {
    user.inactive = true
    user.updated_at = Date.now()
    await kv.set(`${USER_PREFIX}${userId}`, user)
  }
}

export async function reactivateUser (userId) {
  const user = await kv.get(`${USER_PREFIX}${userId}`)
  if (user) {
    user.inactive = false
    user.updated_at = Date.now()
    await kv.set(`${USER_PREFIX}${userId}`, user)
  }
}
```

Update `saveUser` to accept optional `subscribedKey`:
```js
export async function saveUser ({ user_id, name, username }, subscribedKey) {
  const user = {
    user_id,
    name,
    username: username ?? null,
    inactive: false,
    subscribed_key: subscribedKey ?? null,
    updated_at: Date.now()
  }
  await kv.set(`${USER_PREFIX}${user_id}`, user)
  await kv.sadd(USERS_SET, String(user_id))
  if (subscribedKey) {
    await addUserToLink(subscribedKey, user_id)
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `node --test test/storage.test.js`
Expected: PASS

**Step 5: Commit**

```bash
git add lib/storage.js test/storage.test.js
git commit -m "feat: add key subscriptions and inactive flag to storage layer"
```

---

### Task 2: Add callback_query handling and inline keyboard admin panel [x]

**Files:**
- Modify: `api/index.js`
- Modify: `lib/max-api.js` (add sendCallbackMessage or reuse sendMessage)
- Test: `test/handler.test.js`

**Step 1: Write failing tests for callback and admin panel**

Add to `test/handler.test.js`:

```js
describe('callback_query handling', () => {
  beforeEach(() => {
    fetchCalls = []
    kv._clear()
  })

  it('should delete link on del: callback', async () => {
    await kv.set('link:test', { url: 'https://x.com', message: 'Msg' })
    await handleCallbackQuery({
      callback_query: {
        id: 'cb1',
        chat_id: 1,
        user: { user_id: 123 },
        data: 'del:test'
      }
    })
    const saved = await kv.get('link:test')
    assert.equal(saved, null)
    const responseCall = fetchCalls.find(c => c.body?.text?.includes('🗑'))
    assert.ok(responseCall, 'delete confirmation not found')
  })

  it('should deny delete callback for non-admin', async () => {
    await handleCallbackQuery({
      callback_query: {
        id: 'cb1',
        chat_id: 1,
        user: { user_id: 999 },
        data: 'del:test'
      }
    })
    const responseCall = fetchCalls.find(c => c.body?.text?.includes('⛔'))
    assert.ok(responseCall, 'deny response not found')
  })
})
```

**Step 2: Run test to verify failure**

Run: `node --test test/handler.test.js --test-name-pattern callback_query`
Expected: FAIL — handleCallbackQuery not found

**Step 3: Implement callback handler + admin inline keyboard**

In `api/index.js`, add after `handleMessage`:

```js
async function handleCallbackQuery (update) {
  const { callback_query: cb } = update
  if (!cb?.data || !cb?.chat_id || !cb?.user?.user_id) return

  const chatId = cb.chat_id
  const userId = cb.user.user_id

  if (!isAdmin(userId)) {
    return sendMessage(chatId, '⛔ Эта команда доступна только администратору.')
  }

  if (cb.data === 'links') {
    // Trigger /links logic inline
    const links = await getAllLinks()
    if (!links.length) {
      return sendMessage(chatId, '📭 Нет активных связок.')
    }
    const list = links.map((l, i) =>
      `${i + 1}. 🔑 ${l.key}\n   🔗 ${l.url}`
    ).join('\n\n')
    return sendMessage(chatId, `📋 Активные связки (${links.length}):\n\n${list}`)
  }

  if (cb.data === 'create') {
    return sendMessage(chatId,
      '➕ Создание связки:\n\n' +
      '/setlink <ключ> <url> <сообщение>\n\n' +
      'Пример:\n/setlink vip https://max.ru/channel/xxx Добро пожаловать! 🎉'
    )
  }

  if (cb.data === 'users') {
    const count = await getUserCount()
    return sendMessage(chatId, `👥 В базе ${count} пользователей.`)
  }

  if (cb.data === 'broadcast') {
    return sendMessage(chatId, '📨 Рассылка пока не реализована.')
  }

  if (cb.data === 'cancel_del') {
    return sendMessage(chatId, '❌ Удаление отменено.')
  }

  if (cb.data.startsWith('del:')) {
    const key = cb.data.slice(4)
    const existing = await getLink(key)
    if (!existing) return sendMessage(chatId, `❌ Ключ "${key}" не найден.`)
    await delLink(key)
    return sendMessage(chatId, `🗑 Связка "${key}" удалена.`)
  }

  if (cb.data.startsWith('confirm_del:')) {
    const key = cb.data.slice(11)
    return handleCallbackQuery({
      callback_query: { ...cb, data: `del:${key}` }
    })
  }
}
```

Update admin `/start` to show inline keyboard. In `handleBotStarted` admin branch, change to:

```js
const count = await getUserCount()
await sendMessageWithKeyboard(
  chat_id,
  `👋 Привет, Админ! В базе ${count} пользователей.`,
  [
    [{ type: 'callback', text: '📋 Связки', data: 'links' },
     { type: 'callback', text: '➕ Создать', data: 'create' }],
    [{ type: 'callback', text: '👥 Пользователи', data: 'users' },
     { type: 'callback', text: '📨 Рассылка', data: 'broadcast' }]
  ]
)
```

Add `sendMessageWithKeyboard` in `lib/max-api.js`:

```js
export async function sendMessageWithKeyboard (chatId, text, buttons) {
  if (chatId == null) {
    throw new Error(`chatId is required, got ${chatId}`)
  }
  return request('POST', `/messages?chat_id=${chatId}`, {
    text,
    attachments: [
      {
        type: 'inline_keyboard',
        payload: {
          buttons: buttons.map(row =>
            row.map(btn => ({
              type: 'callback',
              text: btn.text,
              payload: { data: btn.data }
            }))
          )
        }
      }
    ]
  })
}
```

Update `/links` to show buttons with delete option. In the `/links` handler, change:

```js
if (!links.length) {
  return sendMessage(chat_id, '📭 Нет активных связок.')
}
const list = links.map((l, i) =>
  `${i + 1}. 🔑 ${l.key}\n   🔗 ${l.url}\n   💬 ${l.message}`
).join('\n\n')
// Send with inline keyboard — each key gets a delete button
const buttons = links.map(l => [
  { type: 'callback', text: `🗑 ${l.key}`, data: `del:${l.key}` }
])
await sendMessageWithKeyboard(
  chat_id,
  `📋 Активные связки (${links.length}):\n\n${list}`,
  buttons
)
```

Handle `callback_query` in the webhook route:

```js
} else if (update.update_type === 'callback_query') {
  await handleCallbackQuery(update)
}
```

Also add import for `sendMessageWithKeyboard` at the top.

**Step 4: Run tests to verify they pass**

Run: `node --test test/handler.test.js`
Expected: PASS (add callback tests)

**Step 5: Commit**

```bash
git add api/index.js lib/max-api.js test/handler.test.js
git commit -m "feat: add callback query handling, inline keyboard admin panel"
```

---

### Task 3: Remove text key input for non-admins, save subscribed_key on bot_started [x]

**Files:**
- Modify: `api/index.js`
- Test: `test/handler.test.js`

**Step 1: Write tests for the new behavior**

In `test/handler.test.js`:

```js
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
})
```

**Step 2: Run test to verify it fails (if not yet implemented)**

Run: `node --test test/handler.test.js --test-name-pattern "subscribed_key"`
Expected: test may pass if previous tasks covered this

**Step 3: Update handleBotStarted in api/index.js**

In `handleBotStarted`, when there's a payload (`?start=<key>`):

```js
// Пришёл диплинк ?start=<key>
if (payload) {
  const data = await getLink(payload)
  if (data) {
    // Save user with subscribed_key
    if (user?.user_id) {
      await saveUser(
        { user_id: user.user_id, name: user.name, username: user.username },
        payload
      )
    }
    await sendMessageWithLink(
      chat_id,
      data.message,
      { label: '👉 Перейти в канал', url: data.url }
    )
  } else {
    await sendMessage(chat_id, '❌ Ссылка не найдена или устарела.')
  }
  return
}
```

**Step 4: Remove text key input for non-admins**

In `handleMessage`, after the admin commands (the line `if (text.startsWith('/')) return`), remove the generic key lookup block — non-admin users should only enter via deep link. Replace the key lookup block with:

```js
// Игнорируем всё, кроме команд, для не-админов
if (!isAdmin(userId)) return
```

**Step 5: Run all tests**

Run: `node --test test/handler.test.js test/max-api.test.js test/storage.test.js`
Expected: PASS

**Step 6: Commit**

```bash
git add api/index.js test/handler.test.js
git commit -m "feat: save subscribed_key on bot_started, remove text key input for non-admins"
```

---

### Task 4: Reactivate user on re-entry [x]

**Files:**
- Modify: `api/index.js`
- Test: `test/handler.test.js`

**Step 1: Write tests**

```js
it('should reactivate inactive user on bot_started', async () => {
  await saveUser({ user_id: 999, name: 'User' })
  await markInactive(999)
  await kv.set('link:key', { url: 'https://x.com', message: 'Welcome!' })
  await handleBotStarted({ chat_id: 1, user: { user_id: 999, name: 'User' }, payload: 'key' })
  const user = await kv.get('user:999')
  assert.equal(user.inactive, false)
})
```

**Step 2: Run test to verify it fails**

**Step 3: Implement reactivation**

In `handleBotStarted`, after saving the user (when payload is present), add:

```js
await reactivateUser(user.user_id)
```

Also in `handleMessage`, after saving user (at the top), add:

```js
if (user?.user_id) {
  await reactivateUser(user.user_id)
}
```

**Step 4: Run tests**

Run: `node --test test/handler.test.js test/storage.test.js`
Expected: PASS

**Step 5: Commit**

```bash
git add api/index.js test/handler.test.js
git commit -m "feat: reactivate inactive users on re-entry"
```

---

### Task 5: Update kv-mock with srem if missing, verify all tests pass [x]

**Files:**
- Modify: `lib/kv-mock.js` (if needed)
- Run: all tests

**Step 1: Check kv-mock has all needed methods**

Read `lib/kv-mock.js` — ensure `srem` exists (from previous patch it should).

**Step 2: Run full test suite**

Run: `node --test test/*.test.js`
Expected: ALL PASS

**Step 3: Commit**

```bash
git add lib/kv-mock.js
git commit -m "chore: ensure kv-mock supports all operations"
```
