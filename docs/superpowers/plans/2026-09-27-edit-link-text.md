# Edit Link Text Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Кнопка «✏️» на карточке связки запускает режим редактирования текста: бот ждёт новый текст (KV-флаг `pending_edit:<userId>`, TTL 15 мин) и точечно обновляет поле `message` связки.

**Architecture:** Хранилище получает `updateLinkMessage` (точечная правка `message`) и три функции флага (`set/get/clearPendingEdit` с TTL). `api/index.js`: ack всех callback-кнопок через `answerCallback` (`POST /answers`), новые payload'ы `edit_msg:`/`edit_cancel:`, перехват текста в `handleMessage` **до** ранних `return` (пустой текст, `/start`, фильтр не-админов). Спека: `docs/superpowers/specs/2026-09-27-edit-link-text-design.md`.

**Tech Stack:** JavaScript ES Modules, Hono.js, Vercel KV / in-memory `kv-mock`, тесты `node --test`.

## Global Constraints

- Никаких новых зависимостей; проверка — только `npm test` (= `node --test test/*.test.js`); lint/typecheck в проекте нет.
- Тестовый стиль: `node:test` (`describe/it/beforeEach`) + `node:assert/strict`; env (`BOT_TOKEN`, `ADMIN_USER_IDS=123`, `BOT_NICK`) выставляется **до** импорта `api/index.js`.
- Точные пользовательские строки из спеки (§3): `⚠️ Жду текстовое сообщение. Отправьте текст или нажмите «❌ Отмена».` · `⚠️ Режим редактирования сброшен.` · `✅ Текст обновлён!` · `❌ Не удалось начать редактирование, попробуйте ещё раз.` · `⚠️ Не удалось сбросить режим редактирования, попробуйте ещё раз.` · `⛔ Ключ "..." не найден или у вас нет прав.` · `❌ Ключ "..." не найден.` · `⛔ Вы можете редактировать только свои ключи.`
- Лимит текста связки — `text.slice(0, 4096)`; TTL `pending_edit` — 900 секунд (15 * 60), без продления при чтении.
- Сообщения связок отправляются plain-text (не передавать `format`).
- Каждый таск заканчивается: зелёный полный `npm test` + commit.

---

### Task 1: `updateLinkMessage` в `lib/storage.js`

**Files:**
- Modify: `lib/storage.js` (новая функция после `getLink`, строки 58–66; константы вверху файла)
- Test: `test/storage.test.js` (дополнение импортов строки 5–14 и новый `describe` в конец файла)

**Interfaces:**
- Consumes: `getKv()`, `LINK_PREFIX`, `log()` — существующие в `lib/storage.js`.
- Produces: `updateLinkMessage(key: string, message: string): Promise<boolean>` — читает связку с фолбэком на исходный регистр (legacy), пишет `{ ...existing, message }` в тот же ключ; `false` если связка не найдена.

- [ ] **Step 1: Write the failing tests**

В `test/storage.test.js` расширить существующий импорт (строки 5–14) — добавить `updateLinkMessage`:

```js
const {
  setLink, getLink, delLink, getAllLinks, getLinksByCreator,
  updateLinkMessage,
  saveUser, getUserCount, getAllUsers,
  addUserToLink, getLinkSubs,
  markInactive, reactivateUser,
  getLinkAge, getLinkSubCount, getLinkCount,
  getDailyStat, getDailyTotal, getStatRange, getTotalRange,
  getLinksRankedBySubs,
  daysAgo
} = await import('../lib/storage.js')
```

В **конец** файла `test/storage.test.js` добавить:

```js
describe('updateLinkMessage', () => {
  beforeEach(() => kv._clear())

  it('should update only message, preserving url/creator_id/created_at', async () => {
    await setLink('vip', 'https://example.com', 'Old text', 123)
    const before = await kv.get('link:vip')
    const ok = await updateLinkMessage('vip', 'New text')
    assert.equal(ok, true)
    const link = await kv.get('link:vip')
    assert.equal(link.message, 'New text')
    assert.equal(link.url, 'https://example.com')
    assert.equal(link.creator_id, 123)
    assert.equal(link.created_at, before.created_at)
  })

  it('should return false for nonexistent key', async () => {
    assert.equal(await updateLinkMessage('ghost', 'text'), false)
  })

  it('should find legacy key stored in original case', async () => {
    await kv.set('link:VIP', { url: 'https://legacy.example', message: 'Old', creator_id: 1, created_at: 111 })
    const ok = await updateLinkMessage('VIP', 'New legacy')
    assert.equal(ok, true)
    assert.equal((await kv.get('link:VIP')).message, 'New legacy')
    assert.equal(await kv.get('link:vip'), null)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/storage.test.js`
Expected: FAIL — `ReferenceError: updateLinkMessage is not defined` (or import error).

- [ ] **Step 3: Write the implementation**

В `lib/storage.js`: в блоке констант (после строки 9 `const STATS_TTL = ...`) ничего не менять; функцию добавить **сразу после `getLink`** (после строки 66, перед `delLink`):

```js
export async function updateLinkMessage (key, message) {
  const kv = await getKv()
  const lowerKey = key.toLowerCase()
  let storeKey = `${LINK_PREFIX}${lowerKey}`
  let data = await kv.get(storeKey)
  if (!data && lowerKey !== key) {
    storeKey = `${LINK_PREFIX}${key}`
    data = await kv.get(storeKey)
  }
  if (!data) return false
  await kv.set(storeKey, { ...data, message })
  log('DEBUG', `updateLinkMessage: key=${key} updated`)
  return true
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/storage.test.js`
Expected: PASS (все describe, включая новый `updateLinkMessage`).

- [ ] **Step 5: Run full suite and commit**

Run: `npm test`
Expected: PASS, 0 fail.

```bash
git add lib/storage.js test/storage.test.js
git commit -m "Add updateLinkMessage for point edit of link text"
```

---

### Task 2: Флаг `pending_edit` в `lib/storage.js`

**Files:**
- Modify: `lib/storage.js` (константы сверху + новый блок функций)
- Test: `test/storage.test.js`

**Interfaces:**
- Consumes: `getKv()`, `log()` — существующие.
- Produces:
  - `setPendingEdit(userId: number, key: string, chatId: number|null): Promise<void>` — пишет `{ key, chat_id, set_at }` + `kv.expire(key, 900)`; бросает при сбое KV (вызывающий показывает ошибку).
  - `getPendingEdit(userId: number): Promise<{key, chat_id, set_at}|null>`
  - `clearPendingEdit(userId: number): Promise<void>` — `kv.del`; бросает при сбое KV.

- [ ] **Step 1: Write the failing tests**

Расширить импорт в `test/storage.test.js` (добавить три функции):

```js
const {
  setLink, getLink, delLink, getAllLinks, getLinksByCreator,
  updateLinkMessage,
  setPendingEdit, getPendingEdit, clearPendingEdit,
  saveUser, getUserCount, getAllUsers,
  addUserToLink, getLinkSubs,
  markInactive, reactivateUser,
  getLinkAge, getLinkSubCount, getLinkCount,
  getDailyStat, getDailyTotal, getStatRange, getTotalRange,
  getLinksRankedBySubs,
  daysAgo
} = await import('../lib/storage.js')
```

В **конец** файла `test/storage.test.js` добавить:

```js
describe('setPendingEdit / getPendingEdit / clearPendingEdit', () => {
  beforeEach(() => kv._clear())

  it('should roundtrip pending edit with structure', async () => {
    await setPendingEdit(123, 'vip', 555)
    const pending = await getPendingEdit(123)
    assert.equal(pending.key, 'vip')
    assert.equal(pending.chat_id, 555)
    assert.equal(typeof pending.set_at, 'number')
  })

  it('should return null after clear', async () => {
    await setPendingEdit(123, 'vip', 555)
    await clearPendingEdit(123)
    assert.equal(await getPendingEdit(123), null)
  })

  it('should return null when never set', async () => {
    assert.equal(await getPendingEdit(777), null)
  })

  it('should allow chat_id null', async () => {
    await setPendingEdit(123, 'vip', null)
    assert.equal((await getPendingEdit(123)).chat_id, null)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/storage.test.js`
Expected: FAIL — `setPendingEdit is not defined` / import error.

- [ ] **Step 3: Write the implementation**

В `lib/storage.js` — константы, в блок констант (после строки 9):

```js
const PENDING_EDIT_PREFIX = 'pending_edit:'
const PENDING_EDIT_TTL = 15 * 60 // сек; фиксированный — не продлевается при чтении
```

Новый блок **сразу после функции `delLink`** (после строки 78, перед `getAllLinks`):

```js
// ── Режим редактирования текста связки ────────────────────────────────────────

export async function setPendingEdit (userId, key, chatId) {
  const kv = await getKv()
  const k = `${PENDING_EDIT_PREFIX}${userId}`
  await kv.set(k, { key, chat_id: chatId ?? null, set_at: Date.now() })
  await kv.expire(k, PENDING_EDIT_TTL)
  log('DEBUG', `setPendingEdit: user=${userId}, key=${key}`)
}

export async function getPendingEdit (userId) {
  const kv = await getKv()
  return await kv.get(`${PENDING_EDIT_PREFIX}${userId}`)
}

export async function clearPendingEdit (userId) {
  const kv = await getKv()
  await kv.del(`${PENDING_EDIT_PREFIX}${userId}`)
  log('DEBUG', `clearPendingEdit: user=${userId}`)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/storage.test.js`
Expected: PASS.

- [ ] **Step 5: Run full suite and commit**

Run: `npm test`
Expected: PASS, 0 fail.

```bash
git add lib/storage.js test/storage.test.js
git commit -m "Add pending_edit KV flag with 15 min TTL"
```

---

### Task 3: `answerCallback` в `lib/max-api.js` + каркас `test/edit-link.test.js`

**Files:**
- Modify: `lib/max-api.js` (новый экспорт после `deleteMessage`, строка 187)
- Test: `test/edit-link.test.js` (создать)

**Interfaces:**
- Consumes: внутренний `request(method, path, body)` из `lib/max-api.js` (fetch-путь без `NODE_EXTRA_CA_CERTS` — именно его видит тестовый мок).
- Produces: `answerCallback(callbackId?: string): Promise<any>` — `POST /answers?callback_id=<id>`; при пустом `callbackId` возвращает `undefined` без запроса. Тестовый файл `test/edit-link.test.js` владеет фикстурой `fetchCalls`/`kv`/импортами хендлеров — последующие таски добавляют в него только новые `describe`.

- [ ] **Step 1: Write the failing test (новый файл)**

Создать `test/edit-link.test.js`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/edit-link.test.js`
Expected: FAIL — `answerCallback is not defined` (SyntaxError при импорте несуществующего именованного экспорта) или assertion «ack request not found».

- [ ] **Step 3: Write the implementation**

В `lib/max-api.js` — новый экспорт **сразу после `deleteMessage`** (после строки 187, перед `sendBroadcastMessage`):

```js
export async function answerCallback (callbackId) {
  if (!callbackId) return
  return request('POST', `/answers?callback_id=${encodeURIComponent(callbackId)}`, {})
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/edit-link.test.js`
Expected: PASS, 2 tests.

- [ ] **Step 5: Run full suite and commit**

Run: `npm test`
Expected: PASS, 0 fail.

```bash
git add lib/max-api.js test/edit-link.test.js
git commit -m "Add answerCallback and edit-link test fixture"
```

---

### Task 4: Кнопка «✏️» и параметр `notice` в `showLinkCard`

**Files:**
- Modify: `api/index.js:147-171` (`showLinkCard`)
- Test: `test/edit-link.test.js` (append)

**Interfaces:**
- Consumes: фикстура `fetchCalls`, `kv`, `handleMessage`, `setLink` из Task 3 (файл уже создан).
- Produces: `showLinkCard(chatId, userId, key, editMsgId = null, useNavFallback = true, notice = null)` — первый ряд кнопок начинается с `✏️` (`data: edit_msg:<key>`); `notice` префиксует текст карточки через `'\n\n'`. Существующие 5 вызовов не меняются (6-й параметр опциональный).

- [ ] **Step 1: Write the failing test (append to `test/edit-link.test.js`)**

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/edit-link.test.js`
Expected: FAIL в новом describe — `firstRow[0].text` равен `'🗑 Удалить'`, а не `'✏️'`.

- [ ] **Step 3: Write the implementation**

В `api/index.js` заменить функцию `showLinkCard` (строки 147–171) на:

```js
/** Показать карточку связки: текст, ссылка, диплинк + кнопки */
async function showLinkCard (chatId, userId, key, editMsgId = null, useNavFallback = true, notice = null) {
  const link = await getLink(key)
  if (!isAdmin(userId) && (!link || !canManage(userId, link))) {
    return sendMessage(chatId, `⛔ Ключ "${key}" не найден или у вас нет прав.`)
  }
  if (!link) return sendMessage(chatId, `❌ Ключ "${key}" не найден.`)

  const displayMessage = link.message?.length > 0
    ? (link.message.length > MAX_LINK_MESSAGE_DISPLAY ? `${link.message.slice(0, MAX_LINK_MESSAGE_DISPLAY)}...` : link.message)
    : '(нет текста)'

  const text = (notice ? `${notice}\n\n` : '') +
    `🔑 Ключ: ${key}\n\n` +
    `💬 Сообщение:\n${displayMessage}\n\n` +
    `🔗 Ссылка: ${link.url}\n\n` +
    `🔗 Диплинк: https://max.ru/${BOT_NICK}?start=${key}`

  return renderScreen({ chatId, editMsgId, useNavFallback, text, buttons: [
    [
      { type: 'callback', text: '✏️', data: `edit_msg:${key}` },
      { type: 'callback', text: '🗑 Удалить', data: `del:${key}` },
      { type: 'callback', text: '👁 Посмотреть', data: `link_preview:${key}` }
    ],
    [{ type: 'callback', text: '🔙 Назад', data: 'links' }]
  ] })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/edit-link.test.js`
Expected: PASS (answerCallback + новый describe).

- [ ] **Step 5: Run full suite and commit**

Run: `npm test`
Expected: PASS, 0 fail.

```bash
git add api/index.js test/edit-link.test.js
git commit -m "Add edit button and notice param to link card"
```

---

### Task 5: `handleCallbackQuery` — ack, снятие флага, `edit_msg:` / `edit_cancel:`

**Files:**
- Modify: `api/index.js`
  - строка 11 — импорт `answerCallback` из `../lib/max-api.js`
  - строки 13–19 — импорт `setPendingEdit, getPendingEdit, clearPendingEdit, updateLinkMessage` из `../lib/storage.js`
  - строка 54 — `ALLOWED_NON_ADMIN_PREFIXES`
  - после строки 268 (после `getAwaitingLimitBroadcast`) — хелпер `clearPendingEditQuietly`
  - строки 666–676 — `handleCallbackQuery`: ack + снятие флага перед проверкой прав
  - перед строкой 1161 (`if (cb.payload.startsWith('del:'))`) — новые обработчики
- Test: `test/edit-link.test.js` (append)

**Interfaces:**
- Consumes: `answerCallback` (Task 3), `setPendingEdit/getPendingEdit/clearPendingEdit` (Task 2), `updateLinkMessage` (Task 1, для импорта — используется в Task 6), `showLinkCard` с `notice` (Task 4), `getAwaitingLimitBroadcast` (`api/index.js:261`), `updateBroadcast`.
- Produces:
  - Callback payload `edit_msg:<key>` — ставит флаг, рендерит экран приглашения с кнопкой `edit_cancel:<key>`.
  - Callback payload `edit_cancel:<key>` — снимает флаг, возвращает карточку (edit на месте через `editMsgId`).
  - Хелпер `clearPendingEditQuietly(userId: number): Promise<void>` — снимает флаг, сбой KV только в лог (используется в Tasks 5–6).

- [ ] **Step 1: Write the failing tests (append to `test/edit-link.test.js`)**

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/edit-link.test.js`
Expected: FAIL в новом describe — флаг не устанавливается (нет обработчика `edit_msg:`), ack не вызывается, `clearPendingEditQuietly` не определён.

- [ ] **Step 3: Add imports and constants**

В `api/index.js`:

Строка 11 — расширить импорт `max-api` (добавить `answerCallback`):

```js
import { sendMessage, sendMessageWithLink, sendMessageWithKeyboard, registerWebhook, markAsRead, sendBroadcastMessage, editMessage, editMessageWithKeyboard, deleteMessage, extractMessageId, answerCallback } from '../lib/max-api.js'
```

Строки 13–19 — расширить импорт `storage` (добавить 4 функции):

```js
import {
  setLink, getLink, delLink, getAllLinks, getLinksByCreator,
  updateLinkMessage, setPendingEdit, getPendingEdit, clearPendingEdit,
  saveUser, getUserCount, getAllUsers, reactivateUser, markInactive, removeUser,
  getLinkSubCount, getLinkAge, getDailyStat, getDailyTotal, getStatRange, getTotalRange, getLinkCount,
  getLinksRankedBySubs,
  daysAgo
} from '../lib/storage.js'
```

Строка 54 — добавить оба префикса (без `edit_cancel:` не-админ-создатель не сможет нажать «❌ Отмена» — глушится проверкой прав):

```js
const ALLOWED_NON_ADMIN_PREFIXES = ['links_page:', 'link_preview:', 'del:', 'confirm_del:', 'edit_msg:', 'edit_cancel:']
```

- [ ] **Step 4: Add `clearPendingEditQuietly` helper**

В `api/index.js` — **сразу после** функции `getAwaitingLimitBroadcast` (после строки 268, перед `getActiveDraft`/комментарием «Маршруты»-блока обработчиков):

```js
/** Снятие pending_edit: сбой KV не должен ломать UX (флаг сам протухнет через 15 мин) */
async function clearPendingEditQuietly (userId) {
  try {
    await clearPendingEdit(userId)
  } catch (e) {
    alog('WARN', 'clearPendingEdit failed for user %d: %s', userId, e.message)
  }
}
```

- [ ] **Step 5: Add ack + flag clearing at `handleCallbackQuery` entry**

В `api/index.js`, внутри `handleCallbackQuery`, **после** строки 672 (`const editMsgId = ...`) и **до** блока проверки прав (строки 674–676), вставить:

```js
  // ACK: гасим спиннер MAX до любых проверок (лимит MAX — 2 ack/сек на диалог;
  // при ошибке только лог, обработка не блокируется)
  answerCallback(cb.callback_id).catch(e => alog('WARN', 'answerCallback failed: %s', e.message))

  // Любая кнопка вне edit-флоу выводит пользователя из режима редактирования
  if (!cb.payload.startsWith('edit_msg:') && !cb.payload.startsWith('edit_cancel:')) {
    await clearPendingEditQuietly(userId)
  }
```

- [ ] **Step 6: Add `edit_msg:` / `edit_cancel:` handlers**

В `api/index.js` — **перед** блоком `if (cb.payload.startsWith('del:')) {` (строка 1161) вставить:

```js
  if (cb.payload.startsWith('edit_msg:')) {
    const key = cb.payload.slice('edit_msg:'.length)
    const link = await getLink(key)
    if (!isAdmin(userId) && (!link || !canManage(userId, link))) {
      alog('DEBUG', ' edit_msg: denied, key=%s, userId=%d', key, userId)
      return sendMessage(chatId, `⛔ Ключ "${key}" не найден или у вас нет прав.`)
    }
    if (!link) return sendMessage(chatId, `❌ Ключ "${key}" не найден.`)

    // Взаимоисключение: режим «Свой вариант» рассылки не должен жить вместе с pending_edit
    try {
      const awaiting = await getAwaitingLimitBroadcast(userId)
      if (awaiting) await updateBroadcast(awaiting.id, { _awaiting_limit: false })
    } catch (e) {
      alog('WARN', 'edit_msg: failed to clear _awaiting_limit: %s', e.message)
    }

    try {
      await setPendingEdit(userId, key, chatId)
    } catch (e) {
      alog('WARN', 'edit_msg: setPendingEdit failed: %s', e.message)
      return sendMessage(chatId, '❌ Не удалось начать редактирование, попробуйте ещё раз.')
    }
    alog('DEBUG', ' edit_msg: pending set, key=%s, userId=%d', key, userId)
    return renderScreen({ chatId, editMsgId, text:
      `✏️ Редактирование текста «${key}»\n\n` +
      'Пришлите новый текст сообщения.\n' +
      'Ограничение: 4096 символов.\n' +
      'Ссылка и ключ не изменятся.',
      buttons: [
        [{ type: 'callback', text: '❌ Отмена', data: `edit_cancel:${key}` }]
      ]
    })
  }

  if (cb.payload.startsWith('edit_cancel:')) {
    const key = cb.payload.slice('edit_cancel:'.length)
    await clearPendingEditQuietly(userId)
    alog('DEBUG', ' edit_cancel: pending cleared, key=%s, userId=%d', key, userId)
    return showLinkCard(chatId, userId, key, editMsgId)
  }
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `node --test test/edit-link.test.js`
Expected: PASS (все описания: answerCallback, showLinkCard, edit_msg/edit_cancel).

- [ ] **Step 8: Run full suite and commit**

Run: `npm test`
Expected: PASS, 0 fail.

```bash
git add api/index.js test/edit-link.test.js
git commit -m "Add edit callbacks with ack and pending flag handling"
```

---

### Task 6: Перехват ввода в `handleMessage`

**Files:**
- Modify: `api/index.js:400-662` (`handleMessage` — две точки вставки, см. шаги)
- Test: `test/edit-link.test.js` (append)

**Interfaces:**
- Consumes: `getPendingEdit/clearPendingEdit/updateLinkMessage` (Tasks 1–2, импорт добавлен в Task 5), `clearPendingEditQuietly` (Task 5), `showLinkCard` с `notice` (Task 4), `canManage`/`getLink`/`sendMessage` — существующие.
- Produces: поведение перехвата по спеке §3.3–3.5: пустой текст → предупреждение; `/…` → сброс + роутинг; иначе → сохранение с TOCTOU-проверками и карточкой с `notice`.

- [ ] **Step 1: Write the failing tests (append to `test/edit-link.test.js`)**

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/edit-link.test.js`
Expected: FAIL в новом describe — текст не перехватывается (нет флага в `handleMessage`), сообщения-предупреждения не отправляются.

- [ ] **Step 3: Add pending read before the empty-text guard**

В `api/index.js` в `handleMessage` заменить (строки 413–415):

```js
  const text = (message?.body?.text ?? '').trim()

  if (!text) return
```

на:

```js
  const text = (message?.body?.text ?? '').trim()

  // Режим редактирования: читаем флаг ДО проверки пустого текста,
  // иначе медиа-сообщения в режиме молчат (спека §3.3, §3.5)
  let pending = null
  if (user?.user_id) {
    try {
      pending = await getPendingEdit(user.user_id)
    } catch (e) {
      alog('WARN', 'getPendingEdit failed: %s', e.message)
    }
  }

  if (!text) {
    if (pending) {
      return sendMessage(chat_id, '⚠️ Жду текстовое сообщение. Отправьте текст или нажмите «❌ Отмена».')
    }
    return
  }
```

- [ ] **Step 4: Add interception after `userId` assignment, before `/start`**

В `api/index.js` в `handleMessage` — **после** строки 441 (`const userId = user?.user_id`, блок сохранения пользователя/трекинга выше остаётся без изменений) и **до** комментария `// ── Команды` / `if (text.startsWith('/start'))` — вставить:

```js
  // ── Режим редактирования текста связки ──────────────────────────────────────
  if (pending) {
    if (text.startsWith('/')) {
      // Команда в режиме: сначала фиксируем сброс, иначе следующий текст
      // ошибочно запишется в связку; при сбое KV команду не выполняем
      try {
        await clearPendingEdit(userId)
      } catch (e) {
        alog('WARN', 'clearPendingEdit failed: %s', e.message)
        return sendMessage(chat_id, '⚠️ Не удалось сбросить режим редактирования, попробуйте ещё раз.')
      }
      await sendMessage(chat_id, '⚠️ Режим редактирования сброшен.')
      // обычный роутинг команды продолжается ниже
    } else {
      const pendingLink = await getLink(pending.key)
      if (!pendingLink) {
        await clearPendingEditQuietly(userId)
        return sendMessage(chat_id, `❌ Ключ "${pending.key}" не найден.`)
      }
      if (!canManage(userId, pendingLink)) {
        await clearPendingEditQuietly(userId)
        return sendMessage(chat_id, '⛔ Вы можете редактировать только свои ключи.')
      }
      const updated = await updateLinkMessage(pending.key, text.slice(0, 4096))
      if (!updated) {
        await clearPendingEditQuietly(userId)
        return sendMessage(chat_id, `❌ Ключ "${pending.key}" не найден.`)
      }
      await clearPendingEditQuietly(userId)
      alog('DEBUG', ' pending_edit: key=%s updated by userId=%d', pending.key, userId)
      return showLinkCard(chat_id, userId, pending.key, null, false, '✅ Текст обновлён!')
    }
  }
```

Проверить порядок: перехват должен стоять **до** `if (text.startsWith('/start'))` (строка 445 старой нумерации) и **до** фильтра `if (!isAdmin(userId)) return` (строка 661) — иначе не-админ-создатель не дойдёт до сохранения.

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/edit-link.test.js`
Expected: PASS — все describe (answerCallback, showLinkCard, edit callbacks, pending_edit).

- [ ] **Step 6: Run full suite and commit**

Run: `npm test`
Expected: PASS, 0 fail.

```bash
git add api/index.js test/edit-link.test.js
git commit -m "Intercept link text edit input in handleMessage"
```

---

### Task 7: Документация и финальная проверка

**Files:**
- Modify: `docs/api.md` (строки 50, 56–68, 72, 74–76)
- Modify: `README.md:34`

**Interfaces:**
- Consumes: готовая функциональность Tasks 1–6.
- Produces: обновлённая пользовательская документация.

- [ ] **Step 1: Update `docs/api.md` — таблица callback-колбэков**

В таблицу «Inline-кнопки (callback-колбэки)» после строки `link_preview:<key>` вставить:

```markdown
| `edit_msg:<key>` | Кнопка `✏️` в карточке | Режим редактирования текста связки: запрашивает новый текст (лимит 4096), ставит KV-флаг `pending_edit:<userId>` |
| `edit_cancel:<key>` | Кнопка `❌ Отмена` на экране приглашения | Снимает режим и возвращает карточку на месте |
```

- [ ] **Step 2: Update `docs/api.md` — описание карточки и режима (строка 72)**

Заменить абзац «Раздел „Связки“» на:

```markdown
Раздел «Связки»: главное меню → список (постранично, кнопки `⬅️`/`➡️`, «Назад» только у админа) → карточка через `/link <key>` или ввод команды. Карточка: текст сообщения, ссылка, диплинк, кнопки «✏️», «🗑 Удалить», «👁 Посмотреть», «🔙 Назад» (к списку). У создателей (не-админов) список и карточки — только для своих связок.

Режим редактирования текста: кнопка «✏️» → бот ждёт новый текст (KV-флаг `pending_edit:<userId>`, TTL 15 мин). Сообщение без текста — бот просит прислать текст; любая команда `/…` или чужая кнопка снимают режим («⚠️ Режим редактирования сброшен.»); текст, начинающийся с `/`, через режим не записать — используйте `/setlink`. Права (`canManage`) и существование ключа проверяются и при нажатии, и при сохранении. Успех — карточка с «✅ Текст обновлён!»; `url`, `creator_id`, `created_at`, статистика и подписчики не меняются.
```

- [ ] **Step 3: Update `docs/api.md` — ACK в разделе «Обработка событий» (строка 76)**

Заменить абзац на:

```markdown
В дополнение к `message_created`, бот обрабатывает `message_callback` для inline-кнопок и `bot_started` для глубоких ссылок. На каждую callback-кнопку бот отвечает `POST /answers?callback_id=…` (лимит MAX — не более 2 ответов в секунду на диалог; ошибка ack не блокирует обработку).
```

- [ ] **Step 4: Update `README.md:34`**

```markdown
/link vip → карточка связки с кнопками «Редактировать», «Удалить» и «Посмотреть»
```

- [ ] **Step 5: Run full suite**

Run: `npm test`
Expected: PASS, 0 fail.

- [ ] **Step 6: Commit**

```bash
git add docs/api.md README.md
git commit -m "Document link text editing flow and callback ack"
```
