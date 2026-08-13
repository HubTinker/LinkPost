# Навигация «Один экран» (edit-in-place) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Переходы по inline-кнопкам бота перезаписывают сообщение-источник (правка на месте), а не шлют новые сообщения; работа с пользовательским контентом остаётся как сейчас.

**Architecture:** Три слоя: (1) примитивы MAX API — `editMessageWithKeyboard` (`PUT /messages`) и `deleteMessage` (`DELETE /messages`); (2) `renderScreen` — единая точка рендера навигационных экранов с цепочкой «edit source → delete source + send» и KV-фолбэком `nav_msg:{chatId}` только при отсутствии `message_id` в callback; (3) отдельное состояние рассылки `broadcast:{id}:status_msg` для асинхронного завершения статусного экрана из цепочки `process-broadcasts`.

**Tech Stack:** JavaScript (ESM), Hono, @vercel/kv (+ kv-mock для тестов), `node --test`.

**Spec:** `docs/superpowers/specs/2026-08-13-single-screen-nav-design.md`

## Global Constraints

- Правило роли сообщения: нажатие inline-кнопки → правка сообщения-источника; ответ на пользовательский ввод (текст, изображение, превью, диплинк, тест, прогресс, summary, команды) → новое сообщение.
- **Жёсткий инвариант:** если `editMsgId` передан, `nav_msg` не используется ни при каких обстоятельствах (в т.ч. после неудачного edit). После ошибки edit удаляем ровно тот target, который пытались редактировать.
- `renderScreen` вызывается только с непустым `buttons` (экраны без клавиатуры — `sendMessage`, как сегодня).
- `status_message_id` хранит только ID статусного экрана конкретного запуска рассылки («запущена…» → «завершена…»); не progress, не summary, не test.
- Ошибки без разбора кодов: edit fail → `alog('WARN', ...)` → best-effort `deleteMessage(target)` → `sendMessageWithKeyboard`. `renderScreen` не бросает наружу.
- TTL: `nav_msg:{chatId}` — 24 часа; `broadcast:{id}:status_msg` — 7 дней.
- Команды, контент-отправки, `handleBotStarted`, storage-слой — не трогаем.
- Запуск тестов: `npm test` (все), либо `node --test test/<файл>.test.js` (один файл).

---

### Task 1: Проверка payload `message_callback` (первый технический шаг, спека §10)

**Files:**
- Modify: `api/index.js:1130-1136` (временный лог в `/webhook`)

**Interfaces:**
- Consumes: —
- Produces: подтверждённое/опровергнутое наличие `update.message.message_id` в `message_callback`-обновлениях. Результат фиксируется в тексте коммита. Последующие задачи не зависят от результата (фолбэк `nav_msg` уже покрывает оба случая).

- [ ] **Step 1: Добавить временный лог полного update в `/webhook`**

```js
    } else if (update.update_type === 'message_callback') {
      console.log('[API] message_callback RAW:', JSON.stringify(update))
      await handleCallbackQuery(update)
    }
```

- [ ] **Step 2: Запустить локально или задеплоить**

- Локально: `npm run poll` (нужен `BOT_TOKEN` в `.env`).
- Либо: `npm run deploy` и открыть `https://<проект>.vercel.app/setup-webhook?secret=<SETUP_SECRET>` (или существующий webhook).

- [ ] **Step 3: Нажать любую inline-кнопку бота в MAX и проверить лог**

Ожидается строка вида:
```
[API] message_callback RAW: {"update_type":"message_callback","message":{"message_id":"<id>","recipient":{"chat_id":...},...},"callback":{...},...}
```

Вердикт: присутствует ли `message_id` у `update.message`?

- Если **да** — основной путь `editMsgId` работает как спроектировано.
- Если **нет** — основной путь будет через `nav_msg` (renderScreen уже это покрывает через `editMsgId ?? nav_msg`); пометить это в коммите.

- [ ] **Step 4: Удалить временный лог**

Убрать строку `console.log('[API] message_callback RAW:', ...)`, вернуть блок к исходному виду:

```js
    } else if (update.update_type === 'message_callback') {
      await handleCallbackQuery(update)
    }
```

- [ ] **Step 5: Коммит**

```bash
git add api/index.js
git commit -m "chore: verify message_callback payload shape"
```

---

### Task 2: Примитивы MAX API — `editMessageWithKeyboard` и `deleteMessage`

**Files:**
- Modify: `lib/max-api.js` (билдер клавиатуры + 2 функции)
- Test: `test/max-api.test.js`

**Interfaces:**
- Consumes: —
- Produces:
  - `buildKeyboardAttachment(buttons)` — внутренний экспорт: `{ type: 'inline_keyboard', payload: { buttons } }`, схема кнопки `{ type: 'callback', text, payload }`.
  - `editMessageWithKeyboard(chatId, messageId, text, buttons)` → `PUT /messages?chat_id=&message_id=` с телом `{ text, attachments: [buildKeyboardAttachment(buttons)] }`.
  - `deleteMessage(chatId, messageId)` → `DELETE /messages?chat_id=&message_id=` без тела.

- [ ] **Step 1: Написать падающие тесты** (добавить в конец `test/max-api.test.js`)

```js
const { sendMessage, sendMessageWithLink, editMessageWithKeyboard, deleteMessage } = await import('../lib/max-api.js')

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
```

- [ ] **Step 2: Запустить и убедиться, что падает**

Run: `node --test test/max-api.test.js`
Expected: FAIL — `editMessageWithKeyboard is not a function`

- [ ] **Step 3: Реализовать**

В `lib/max-api.js`: вынести билдер из `sendMessageWithKeyboard` и добавить две функции.

```js
export function buildKeyboardAttachment (buttons) {
  return {
    type: 'inline_keyboard',
    payload: {
      buttons: buttons.map(row =>
        row.map(btn => ({
          type: 'callback',
          text: btn.text,
          payload: btn.data
        }))
      )
    }
  }
}

export async function sendMessageWithKeyboard (chatId, text, buttons) {
  if (chatId == null) {
    console.error('[API] sendMessageWithKeyboard: chatId is required')
    throw new Error(`chatId is required, got ${chatId}`)
  }
  const payload = {
    text,
    attachments: [buildKeyboardAttachment(buttons)]
  }
  console.log('[API] sendMessageWithKeyboard payload:', JSON.stringify(payload, null, 2))
  return request('POST', `/messages?chat_id=${chatId}`, payload)
}

export async function editMessageWithKeyboard (chatId, messageId, text, buttons) {
  if (chatId == null) throw new Error(`chatId is required, got ${chatId}`)
  if (messageId == null) throw new Error(`messageId is required, got ${messageId}`)
  return request('PUT', `/messages?chat_id=${chatId}&message_id=${messageId}`, {
    text,
    attachments: [buildKeyboardAttachment(buttons)]
  })
}

export async function deleteMessage (chatId, messageId) {
  if (chatId == null) throw new Error(`chatId is required, got ${chatId}`)
  if (messageId == null) throw new Error(`messageId is required, got ${messageId}`)
  return request('DELETE', `/messages?chat_id=${chatId}&message_id=${messageId}`)
}
```

Проверить: тело запроса `sendMessageWithKeyboard` не изменилось (тот же `POST /messages?chat_id=` с `attachments[0].payload.buttons` вида `{ type: 'callback', text, payload }`).

- [ ] **Step 4: Запустить и убедиться, что проходит**

Run: `node --test test/max-api.test.js`
Expected: PASS (все describe)

- [ ] **Step 5: Коммит**

```bash
git add lib/max-api.js test/max-api.test.js
git commit -m "feat: add edit and delete message primitives"
```

---

### Task 3: `lib/nav.js` — KV-трекинг текущего экрана

**Files:**
- Create: `lib/nav.js`
- Test: `test/nav.test.js`

**Interfaces:**
- Consumes: kv-mock (тесты)
- Produces:
  - `setNavMessageId(chatId, messageId)` — ключ `nav_msg:{chatId}`, TTL 24ч.
  - `getNavMessageId(chatId)` → `messageId | null`.

- [ ] **Step 1: Написать падающие тесты** (создать `test/nav.test.js`)

```js
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { kv } from '../lib/kv-mock.js'
import { setNavMessageId, getNavMessageId } from '../lib/nav.js'

describe('nav message tracking', () => {
  beforeEach(async () => {
    await kv._clear()
  })

  it('should return null when nothing stored', async () => {
    assert.strictEqual(await getNavMessageId(1), null)
  })

  it('should roundtrip message id per chat', async () => {
    await setNavMessageId(1, 42)
    await setNavMessageId(2, 43)
    assert.strictEqual(await getNavMessageId(1), 42)
    assert.strictEqual(await getNavMessageId(2), 43)
  })

  it('should store under nav_msg:{chatId} prefix', async () => {
    await setNavMessageId(1, 42)
    assert.strictEqual(await kv.get('nav_msg:1'), 42)
  })

  it('should overwrite previous value', async () => {
    await setNavMessageId(1, 42)
    await setNavMessageId(1, 43)
    assert.strictEqual(await getNavMessageId(1), 43)
  })
})
```

- [ ] **Step 2: Запустить и убедиться, что падает**

Run: `node --test test/nav.test.js`
Expected: FAIL — cannot find module `../lib/nav.js`

- [ ] **Step 3: Реализовать `lib/nav.js`**

```js
const NAV_PREFIX = 'nav_msg:'
const NAV_TTL = 24 * 60 * 60

let _kv = null
async function getKv () {
  if (!_kv) {
    const useMock = !process.env.KV_URL && !process.env.KV_REST_API_URL
    const mod = useMock ? await import('./kv-mock.js') : await import('@vercel/kv')
    _kv = mod.kv
  }
  return _kv
}

export async function setNavMessageId (chatId, messageId) {
  const kv = await getKv()
  const key = `${NAV_PREFIX}${chatId}`
  await kv.set(key, messageId)
  await kv.expire(key, NAV_TTL)
}

export async function getNavMessageId (chatId) {
  const kv = await getKv()
  return kv.get(`${NAV_PREFIX}${chatId}`)
}
```

- [ ] **Step 4: Запустить и убедиться, что проходит**

Run: `node --test test/nav.test.js`
Expected: PASS

- [ ] **Step 5: Коммит**

```bash
git add lib/nav.js test/nav.test.js
git commit -m "feat: track current nav message id per chat"
```

---

### Task 4: `status_message_id` в `lib/broadcast.js`

**Files:**
- Modify: `lib/broadcast.js` (суффикс + 2 функции + очистка в 2 местах)
- Test: `test/broadcast.test.js`

**Interfaces:**
- Consumes: —
- Produces:
  - `setStatusMessageId(broadcastId, messageId)` — ключ `broadcast:{id}:status_msg`, TTL 7 дней.
  - `getStatusMessageId(broadcastId)` → `messageId | null`.
  - Очистка ключа в `deleteBroadcast(broadcastId)` и `resetBroadcastStats(broadcastId)`.

- [ ] **Step 1: Написать падающие тесты** (добавить в конец `test/broadcast.test.js`)

```js
describe('status message id', () => {
  beforeEach(async () => {
    await kv._clear()
  })

  it('should roundtrip status message id', async () => {
    const b = await createBroadcast({ text: 'X', created_by: 123 })
    assert.strictEqual(await getStatusMessageId(b.id), null)
    await setStatusMessageId(b.id, 90)
    assert.strictEqual(await getStatusMessageId(b.id), 90)
  })

  it('should store under broadcast:{id}:status_msg prefix', async () => {
    const b = await createBroadcast({ text: 'X', created_by: 123 })
    await setStatusMessageId(b.id, 90)
    assert.strictEqual(await kv.get(`broadcast:${b.id}:status_msg`), 90)
  })

  it('should delete status message id with broadcast', async () => {
    const b = await createBroadcast({ text: 'X', created_by: 123 })
    await setStatusMessageId(b.id, 90)
    await deleteBroadcast(b.id)
    assert.strictEqual(await kv.get(`broadcast:${b.id}:status_msg`), null)
  })

  it('should clear status message id on stats reset', async () => {
    const b = await createBroadcast({ text: 'X', created_by: 123 })
    await setStatusMessageId(b.id, 90)
    await resetBroadcastStats(b.id)
    assert.strictEqual(await kv.get(`broadcast:${b.id}:status_msg`), null)
  })
})
```

- [ ] **Step 2: Запустить и убедиться, что падает**

Run: `node --test test/broadcast.test.js`
Expected: FAIL — `getStatusMessageId is not a function`

- [ ] **Step 3: Реализовать**

В `lib/broadcast.js`:

```js
const STATUS_MSG_SUFFIX = ':status_msg'
```

Добавить рядом с `setProgressMessageId`/`getProgressMessageId`:

```js
export async function setStatusMessageId (broadcastId, messageId) {
  const kv = await getKv()
  const key = `${BR_PREFIX}${broadcastId}${STATUS_MSG_SUFFIX}`
  await kv.set(key, messageId)
  await kv.expire(key, 7 * 86400)
}

export async function getStatusMessageId (broadcastId) {
  const kv = await getKv()
  return kv.get(`${BR_PREFIX}${broadcastId}${STATUS_MSG_SUFFIX}`)
}
```

В `deleteBroadcast` в массив `keys` добавить строку:
```js
    `${BR_PREFIX}${id}${STATUS_MSG_SUFFIX}`,
```
(после `PROGRESS_MSG_SUFFIX`).

В `resetBroadcastStats` в `Promise.all([...])` добавить:
```js
    kv.del(`${prefix}${STATUS_MSG_SUFFIX}`),
```

- [ ] **Step 4: Запустить и убедиться, что проходит**

Run: `node --test test/broadcast.test.js`
Expected: PASS

- [ ] **Step 5: Коммит**

```bash
git add lib/broadcast.js test/broadcast.test.js
git commit -m "feat: track broadcast status message id"
```

---

### Task 5: `renderScreen` — единая точка рендера экранов

**Files:**
- Modify: `api/index.js` (импорты, `renderScreen`, экспорт)
- Test: `test/render-screen.test.js` (новый)

**Interfaces:**
- Consumes: `editMessageWithKeyboard`, `deleteMessage`, `sendMessageWithKeyboard` (Task 2); `setNavMessageId`, `getNavMessageId` (Task 3).
- Produces:
  - `renderScreen({ chatId, editMsgId, text, buttons })` → `{ message_id }` — правка source/`nav_msg` → фолбэк delete+send; не бросает наружу.
  - Экспорт `renderScreen` из `api/index.js` (добавить в существующую строку экспорта).

- [ ] **Step 1: Обновить мок fetch в `test/handler.test.js` (захват метода)**

Заменить мок (строки 8-18) на версию с `method`:

```js
let fetchCalls
global.fetch = async (url, opts) => {
  if (!fetchCalls) fetchCalls = []
  fetchCalls.push({ url, method: opts?.method || 'GET', body: JSON.parse(opts?.body || '{}') })
  return {
    ok: true,
    json: async () => ({ ok: true }),
    text: async () => '',
    status: 200
  }
}
```

- [ ] **Step 2: Написать падающие тесты** (создать `test/render-screen.test.js`)

```js
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
  return { ok: true, json: async () => ({ ok: true, message_id: 999 }), text: async () => '', status: 200 }
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

  it('should NOT use nav message after source edit failure (hard invariant)', async () => {
    await setNavMessageId(1, 77)
    global.fetchFailUrls = ['message_id=90']
    await renderScreen({ chatId: 1, editMsgId: 90, text: 'hello', buttons: BUTTONS })
    assert.ok(byUrl('message_id=90').some(c => c.method === 'PUT' && c.body.text), 'source edit attempted')
    assert.equal(byUrl('message_id=77').length, 0, 'nav must never be used after source edit failure')
    assert.ok(byUrl('message_id=90').some(c => c.method === 'DELETE'), 'delete source attempted')
    assert.ok(byUrl('chat_id=1').some(c => !c.url.includes('message_id')), 'send fallback expected')
  })

  it('should throw when buttons is empty', async () => {
    await assert.rejects(
      () => renderScreen({ chatId: 1, editMsgId: null, text: 'hello', buttons: [] }),
      /buttons required/
    )
  })
})
```

- [ ] **Step 3: Запустить и убедиться, что падает**

Run: `node --test test/render-screen.test.js`
Expected: FAIL — `renderScreen is not a function`

- [ ] **Step 4: Реализовать**

В `api/index.js`:

1) Добавить в импорт из `../lib/max-api.js`:
```js
import { sendMessage, sendMessageWithLink, sendMessageWithKeyboard, registerWebhook, markAsRead, sendBroadcastMessage, editMessage, editMessageWithKeyboard, deleteMessage } from '../lib/max-api.js'
```

2) Добавить импорт:
```js
import { setNavMessageId, getNavMessageId } from '../lib/nav.js'
```

3) Добавить функцию после `showAdminMenu` (перед комментарием `// ── Обработчики событий`):

```js
/** Единая точка рендера навигационных экранов: правка на месте, фолбэк delete+send */
async function renderScreen ({ chatId, editMsgId, text, buttons }) {
  if (!buttons?.length) throw new Error('renderScreen: buttons required')
  // target выбирается один раз: сообщение-источник, либо nav_msg (только если source отсутствует)
  const targetId = editMsgId ?? (await getNavMessageId(chatId))
  if (targetId != null) {
    try {
      await editMessageWithKeyboard(chatId, targetId, text, buttons)
      await setNavMessageId(chatId, targetId)
      return { message_id: targetId }
    } catch (e) {
      alog('WARN', 'renderScreen: edit failed for %s: %s', targetId, e.message)
      // Жёсткий инвариант: после ошибки edit конкретного target nav_msg не используется.
      // Удаляем ровно тот target, который пытались редактировать.
      try { await deleteMessage(chatId, targetId) } catch { /* best effort */ }
    }
  }
  const resp = await sendMessageWithKeyboard(chatId, text, buttons)
  if (resp?.message_id) await setNavMessageId(chatId, resp.message_id)
  return resp
}
```

4) Добавить `renderScreen` в экспорт:
```js
export { app, handleBotStarted, handleMessage, handleCallbackQuery, renderScreen }
```

- [ ] **Step 5: Запустить и убедиться, что проходит**

Run: `node --test test/render-screen.test.js`
Expected: PASS (6 тестов)

- [ ] **Step 6: Прогнать существующий набор**

Run: `npm test`
Expected: PASS — существующие тесты не должны сломаться (мок fetch дополнен полем `method`, существующие ассерты его не используют).

- [ ] **Step 7: Коммит**

```bash
git add api/index.js test/render-screen.test.js test/handler.test.js
git commit -m "feat: add renderScreen with edit-in-place fallback"
```

---

### Task 6: Проводка — все навигационные колбэки через `renderScreen`

**Files:**
- Modify: `api/index.js` (`handleCallbackQuery`, хелперы `showLinksList`/`showLinkCard`/`showAdminMenu`, вызовы из `handleMessage`)
- Test: `test/handler.test.js` (новые интеграционные тесты)

**Interfaces:**
- Consumes: `renderScreen` (Task 5).
- Produces: `showLinksList(chatId, userId, page, editMsgId)`, `showLinkCard(chatId, userId, key, editMsgId)`, `showAdminMenu(chatId, userId, editMsgId)`. В `handleCallbackQuery` — `const editMsgId = update.message?.message_id ?? null`.

- [ ] **Step 1: Написать падающие интеграционные тесты** (добавить новый describe в конец `test/handler.test.js`)

```js
describe('single-screen navigation', () => {
  beforeEach(() => {
    fetchCalls = []
    kv._clear()
  })

  it('should edit the callback source message in place', async () => {
    await kv.set('link:a', { url: 'https://a.com', message: 'A' })
    await kv.sadd('links_all', 'a')
    await handleCallbackQuery({
      callback: { payload: 'links', user: { user_id: 123 } },
      message: { recipient: { chat_id: 1 }, message_id: 90 }
    })
    const edits = fetchCalls.filter(c => c.url?.includes('message_id=90') && c.method === 'PUT')
    assert.equal(edits.length, 1, 'source message should be edited once')
    assert.ok(edits[0].body.text.includes('📋 Связки'), 'should render links list')
    const sends = fetchCalls.filter(c => c.url?.includes('chat_id=1') && !c.url.includes('message_id'))
    assert.equal(sends.length, 0, 'no new message should be sent')
  })

  it('should fall back to nav_msg when message_id is missing', async () => {
    const { setNavMessageId } = await import('../lib/nav.js')
    await setNavMessageId(1, 77)
    await kv.set('link:a', { url: 'https://a.com', message: 'A' })
    await kv.sadd('links_all', 'a')
    await handleCallbackQuery({
      callback: { payload: 'links', user: { user_id: 123 } },
      message: { recipient: { chat_id: 1 } }
    })
    const edits = fetchCalls.filter(c => c.url?.includes('message_id=77') && c.method === 'PUT')
    assert.equal(edits.length, 1, 'nav message should be edited')
  })

  it('should send new message when both ids are missing', async () => {
    await kv.set('link:a', { url: 'https://a.com', message: 'A' })
    await kv.sadd('links_all', 'a')
    await handleCallbackQuery({
      callback: { payload: 'links', user: { user_id: 123 } },
      message: { recipient: { chat_id: 1 } }
    })
    const sends = fetchCalls.filter(c => c.url?.includes('chat_id=1') && !c.url.includes('message_id'))
    assert.equal(sends.length, 1, 'should send new message')
  })

  it('should keep content sends as new messages (link_preview)', async () => {
    await kv.set('link:vip', { url: 'https://channel.com', message: 'Welcome!' })
    await handleCallbackQuery({
      callback: { payload: 'link_preview:vip', user: { user_id: 123 } },
      message: { recipient: { chat_id: 1 }, message_id: 90 }
    })
    // Preview — контент: новое сообщение, edit не используется
    const sends = fetchCalls.filter(c => c.url?.includes('chat_id=1') && !c.url.includes('message_id'))
    assert.equal(sends.length, 1, 'preview should be a new message')
    assert.equal(fetchCalls.filter(c => c.url?.includes('message_id')).length, 0, 'no edit expected')
  })
})
```

- [ ] **Step 2: Запустить и убедиться, что падает**

Run: `node --test test/handler.test.js`
Expected: FAIL — тест «should edit the callback source message in place» (сейчас edit не вызывается; сообщение уходит новым).

- [ ] **Step 3: Добавить `editMsgId` в начало `handleCallbackQuery`**

После `const userId = cb.user.user_id` (строка 484):

```js
  const editMsgId = update.message?.message_id ?? null
```

- [ ] **Step 4: Обновить сигнатуры хелперов и их внутренние отправки**

В `showLinksList(chatId, userId, page = 1)` добавить 4-й параметр `editMsgId = null`:

```js
async function showLinksList (chatId, userId, page = 1, editMsgId = null) {
```

- Пустой список админа (строки 104-108): заменить `sendMessageWithKeyboard(chatId, text, [...])` на:
```js
    if (isAdminUser) {
      return renderScreen({ chatId, editMsgId, text, buttons: [
        [{ type: 'callback', text: '🔙 Назад', data: 'back' }]
      ] })
    }
    return sendMessage(chatId, text)
```
- Финальная отправка списка (строка 133): заменить на:
```js
  return renderScreen({ chatId, editMsgId, text: out, buttons: rows })
```
- Ветку `if (!rows.length) return sendMessage(chatId, out)` (строка 130) НЕ трогать — экран без клавиатуры.

В `showLinkCard(chatId, userId, key)` добавить 4-й параметр `editMsgId = null` и заменить финальную отправку (строки 156-162) на:

```js
  return renderScreen({ chatId, editMsgId, text, buttons: [
    [
      { type: 'callback', text: '🗑 Удалить', data: `del:${key}` },
      { type: 'callback', text: '👁 Посмотреть', data: `link_preview:${key}` }
    ],
    [{ type: 'callback', text: '🔙 Назад', data: 'links' }]
  ] })
```

В `showAdminMenu(chatId, userId)` добавить 3-й параметр `editMsgId = null` и заменить `sendMessageWithKeyboard` (строки 170-180) на:

```js
  await renderScreen({ chatId, editMsgId, text:
    `👋 Привет, Админ! В базе ${count} пользователей.`,
    buttons: [
      [{ type: 'callback', text: '📋 Связки', data: 'links' },
       { type: 'callback', text: '➕ Создать', data: 'create' }],
      [{ type: 'callback', text: '👥 Пользователи', data: 'users' },
       { type: 'callback', text: '📊 Статистика', data: 'stats' }],
      [{ type: 'callback', text: '📨 Рассылка', data: 'broadcast_menu' }]
    ]
  })
```

Вызовы из `handleMessage` (команды — новый экран): `/links` (строка 350) → `return showLinksList(chatId, userId, page, null)`; `/link` (строка 358) → `return showLinkCard(chatId, userId, key, null)`.

- [ ] **Step 5: Перевести все навигационные колбэки на `renderScreen`**

Для каждого payload ниже заменить `return sendMessageWithKeyboard(chatId, <TEXT>, <BUTTONS>)` на `return renderScreen({ chatId, editMsgId, text: <TEXT>, buttons: <BUTTONS> })` — **текст и кнопки копируются без изменений** из текущего кода:

| Payload | Строки | Примечание |
|---|---|---|
| `create` | 529-534 | — |
| `users` | 539-541 | — |
| `broadcast_menu` | 554-567 | — |
| `broadcast_create` | 582-587 | — |
| `stats` | 592-598 | — |
| `stats_general` | 617-619 | — |
| `stats_by_key` (пусто) | 626-628 | — |
| `stats_by_key` (кнопки) | 639 | — |
| `stats_key:*` (не найден) | 647-649 | экран с кнопкой «К списку» |
| `stats_key:*` (детали) | 666-671 | — |
| `stats_top` (пусто) | 678-680 | — |
| `stats_top` | 687-689 | — |
| `stats_broadcasts_overall` | 712-714 | — |
| `broadcast_images_done:*` | 720-730 | — |
| `broadcast_buttons_done:*` | 738-745 | — |
| `broadcast_test:*` (успех) | 756-759 | только экран результата; тестовая отправка остаётся `sendBroadcastMessage` |
| `broadcast_restart:*` | 782-789 | — |
| `broadcast_list` (пусто) | 917-919 | — |
| `broadcast_list` | 925 | — |
| `broadcast_view:*` | 965 | — |
| `broadcast_stats:*` | 986-988 | — |
| `broadcast_delete:*` | 993-1001 | — |
| `broadcast_delete_confirm:*` | 1008-1010 | — |
| `broadcast_stop:*` | 1017-1019 | — |
| `broadcast_resume:*` | 1026-1028 | — |
| `broadcast_edit:*` | 1039-1044 | — |
| `broadcast_clear_stale` (пусто) | 1051-1053 | — |
| `broadcast_clear_stale` (готово) | 1060-1063 | — |
| `back` (админ) | 1066-1072 | `return showAdminMenu(chatId, userId, editMsgId)`; не-админская ветка `sendMessage` — без изменений |
| `del:*` | 1083-1092 | — |
| `confirm_del:*` | 1105-1107 | — |

**НЕ трогать** (контент/новые сообщения): `link_preview:*` (525), ошибки через `sendMessage` (521, 523, 761-763, 769, 795, 931, 971, 1034-1037 и т.п.), тестовая отправка `sendBroadcastMessage` (754), progress-сообщения (845-865, 1246-1269, 1394-1417), summary (888, 1288, 1434), `broadcast_confirm_now:*` (обрабатывается в Task 7).

- [ ] **Step 6: Запустить и убедиться, что проходит**

Run: `node --test test/handler.test.js`
Expected: PASS — новые интеграционные тесты + весь существующий набор (существующие колбэк-тесты без `message_id` и без `nav_msg` идут через фолбэк-отправку).

- [ ] **Step 7: Полный прогон**

Run: `npm test`
Expected: PASS

- [ ] **Step 8: Коммит**

```bash
git add api/index.js test/handler.test.js
git commit -m "feat: render navigation callbacks in place"
```

---

### Task 7: Поток рассылки — запуск и завершение статусного экрана

**Files:**
- Modify: `api/index.js` (`broadcast_confirm_now:*`, `/process-broadcasts`, `/cron-process-broadcasts`)
- Test: `test/handler.test.js` (интеграционные, через `handleCallbackQuery` и `app.request`)

**Interfaces:**
- Consumes: `renderScreen` (Task 5), `setStatusMessageId`/`getStatusMessageId` (Task 4).
- Produces: при запуске рассылки — `status_message_id` сохраняется до вызова цепочки; при завершении (инлайн и цепочка) — статусный экран правится на «завершена»; при мгновенном завершении первого батча `status_message_id` не сохраняется.

- [ ] **Step 1: Написать падающие тесты** (добавить в конец `test/handler.test.js`)

```js
describe('broadcast status screen', () => {
  beforeEach(() => {
    fetchCalls = []
    kv._clear()
  })

  async function seedUsers (n) {
    for (let i = 1; i <= n; i++) {
      await kv.sadd('users_all', String(i))
      await kv.set(`user:${i}`, { user_id: i, name: `U${i}` })
    }
  }

  it('should save status_message_id when first batch does not complete', async () => {
    // 21 пользователь: первый батч = 20, рассылка продолжается
    await seedUsers(21)
    const b = await createBroadcast({ text: 'Launch', created_by: 123 })
    await handleCallbackQuery({
      callback: { payload: `broadcast_confirm_now:${b.id}`, user: { user_id: 123 } },
      message: { recipient: { chat_id: 1 }, message_id: 90 }
    })
    // Экран «запущена» отредактирован на месте (message_id=90)
    const launched = fetchCalls.find(c => c.url?.includes('message_id=90') && c.method === 'PUT')
    assert.ok(launched, 'launched screen should be edited in place')
    assert.ok(launched.body.text.includes('запущена'), 'launched screen text expected')
    // status_message_id = id отредактированного экрана, сохранён до запуска цепочки
    assert.strictEqual(await kv.get(`broadcast:${b.id}:status_msg`), 90)
    // summary не должен уходить (рассылка не завершена)
    assert.equal(fetchCalls.filter(c => c.body?.text?.includes('Отправлено:')).length, 0)
  })

  it('should not save status_message_id when first batch completes', async () => {
    await seedUsers(2)
    const b = await createBroadcast({ text: 'Short', created_by: 123 })
    await handleCallbackQuery({
      callback: { payload: `broadcast_confirm_now:${b.id}`, user: { user_id: 123 } },
      message: { recipient: { chat_id: 1 }, message_id: 90 }
    })
    assert.strictEqual(await kv.get(`broadcast:${b.id}:status_msg`), null, 'no status id on immediate completion')
    const done = fetchCalls.find(c => c.url?.includes('message_id=90') && c.method === 'PUT')
    assert.ok(done, 'completion screen should be edited in place')
    assert.ok(done.body.text.includes('завершена'), 'completion text expected')
    // summary — отдельное новое сообщение
    const summaries = fetchCalls.filter(c => c.url?.includes('chat_id=1') && !c.url.includes('message_id') && c.body?.text?.includes('Отправлено:'))
    assert.equal(summaries.length, 1, 'summary should be one new message')
    // отдельного короткого «завершена»-сообщения больше нет
    const extraDone = fetchCalls.filter(c => c.url?.includes('chat_id=1') && !c.url.includes('message_id') && c.body?.text?.includes('сообщений'))
    assert.equal(extraDone.length, 0, 'no separate completion keyboard message')
  })

  it('should edit the stored status message on chain completion', async () => {
    process.env.SETUP_SECRET = 'test-secret'
    try {
      await seedUsers(2)
      const b = await createBroadcast({ text: 'Chain', created_by: 123 })
      await updateBroadcast(b.id, { status: 'scheduled', scheduled_at: Date.now(), created_by_chat_id: 1 })
      const { setStatusMessageId } = await import('../lib/broadcast.js')
      await setStatusMessageId(b.id, 90)

      const { app } = await import('../api/index.js')
      const res = await app.request('/process-broadcasts?secret=test-secret')

      assert.equal(res.status, 200)
      const statusEdit = fetchCalls.find(c => c.url?.includes('message_id=90') && c.method === 'PUT')
      assert.ok(statusEdit, 'status screen should be edited on completion')
      assert.ok(statusEdit.body.text.includes('завершена'), 'completion text expected')
      const summary = fetchCalls.find(c => c.url?.includes('chat_id=1') && !c.url.includes('message_id') && c.body?.text?.includes('Отправлено:'))
      assert.ok(summary, 'summary should be sent as new message')
    } finally {
      delete process.env.SETUP_SECRET
    }
  })

  it('should not use nav_msg for broadcast completion', async () => {
    process.env.SETUP_SECRET = 'test-secret'
    try {
      const { setNavMessageId } = await import('../lib/nav.js')
      await setNavMessageId(1, 999)
      await seedUsers(2)
      const b = await createBroadcast({ text: 'NoNav', created_by: 123 })
      await updateBroadcast(b.id, { status: 'scheduled', scheduled_at: Date.now(), created_by_chat_id: 1 })

      const { app } = await import('../api/index.js')
      await app.request('/process-broadcasts?secret=test-secret')

      const navEdits = fetchCalls.filter(c => c.url?.includes('message_id=999') && c.method === 'PUT')
      assert.equal(navEdits.length, 0, 'nav_msg must not be used for completion')
      const summary = fetchCalls.find(c => c.url?.includes('chat_id=1') && !c.url.includes('message_id') && c.body?.text?.includes('Отправлено:'))
      assert.ok(summary, 'summary still sent')
    } finally {
      delete process.env.SETUP_SECRET
    }
  })
})
```

- [ ] **Step 2: Запустить и убедиться, что падает**

Run: `node --test test/handler.test.js`
Expected: FAIL — «should save status_message_id when first batch does not complete» (статусного экрана нет, `status_msg` не сохраняется).

- [ ] **Step 3: Переписать `broadcast_confirm_now:*`**

Заменить блок «завершено» (строки 876-894):

```js
    if (cursor >= users.length) {
      await updateBroadcast(bid, { status: 'sent' })
      console.log(`[broadcast] ${bid}: completed (${users.length} users)`)
      const finalStats = await getBroadcastStats(bid)
      const totalUs = await getUserCount()
      const openPct = finalStats.sent ? Math.round(finalStats.opened / finalStats.sent * 100) : 0
      const unsubPct = finalStats.sent ? Math.round(finalStats.unsubbed / finalStats.sent * 100) : 0
      const summaryMsg = `✅ Рассылка #${bid} завершена!\n\n` +
        `📤 Отправлено: ${finalStats.sent} / ${totalUs}\n` +
        `👁 Открыто: ${finalStats.opened} (${openPct}%)\n` +
        `🚫 Отписалось: ${finalStats.unsubbed} (${unsubPct}%)\n` +
        `❌ Ошибок: ${finalStats.failed}`
      await sendMessage(chatId, summaryMsg).catch(e => console.warn('[broadcast] failed to send summary to creator:', e.message))
      alog('INFO', 'broadcast %s: sent summary, stats=%j', bid, finalStats)
      // Мгновенное завершение: status_message_id НЕ создаётся, экран подтверждения
      // сразу редактируется в финальный (спека §6.1)
      return renderScreen({
        chatId,
        editMsgId,
        text: `✅ Рассылка #${bid} завершена! Отправлено ${cursor} сообщений.`,
        buttons: [[{ type: 'callback', text: '🔙 Назад', data: 'broadcast_menu' }]]
      })
    }
```

Заменить блок «продолжить» (строки 896-911):

```js
    // Экран «запущена» — правка на месте; статусный id сохраняется ДО запуска цепочки (спека §6.1)
    const launched = await renderScreen({
      chatId,
      editMsgId,
      text: `📤 Рассылка #${bid} запущена! Отправлено ${sent} из ${users.length}. Продолжаю...` +
        `\nℹ️ Прогресс будет приходить каждые ${PROGRESS_INTERVAL} сообщений.`,
      buttons: [[{ type: 'callback', text: '🔙 Назад', data: 'broadcast_menu' }]]
    })
    if (launched?.message_id) {
      await setStatusMessageId(bid, launched.message_id)
    }

    const secret = process.env.SETUP_SECRET
    const chainPromise = secret
      ? fetch(`${APP_BASE_URL}/process-broadcasts?secret=${encodeURIComponent(secret)}`)
          .then(r => r.json()).then(r => alog('INFO', 'broadcast %s: chain call result: %j', bid, r))
          .catch(e => console.warn('[broadcast] chain call failed:', e.message))
      : Promise.resolve()

    await chainPromise
```

- [ ] **Step 4: Добавить правку статусного экрана при завершении в `/process-broadcasts`**

В блок завершения (после `sendMessage(summaryChatId, chainSummary)` на строке 1288, до `alog('INFO', ...)`):

```js
        const statusMsgId = await getStatusMessageId(b.id)
        if (statusMsgId && summaryChatId) {
          editMessageWithKeyboard(summaryChatId, statusMsgId,
            `✅ Рассылка #${b.id} завершена! Отправлено ${users.length} сообщений.`,
            [[{ type: 'callback', text: '🔙 Назад', data: 'broadcast_menu' }]]
          ).catch(e => console.warn('[broadcast] status screen edit failed:', e.message))
        }
```

- [ ] **Step 5: Добавить ту же правку в `/cron-process-broadcasts`**

В блок завершения (после `sendMessage(summaryChatId, summary)` на строке 1434, до закрывающей `}` блока `if (newCursor >= users.length)`):

```js
        const statusMsgId = await getStatusMessageId(b.id)
        if (statusMsgId && summaryChatId) {
          editMessageWithKeyboard(summaryChatId, statusMsgId,
            `✅ Рассылка #${b.id} завершена! Отправлено ${users.length} сообщений.`,
            [[{ type: 'callback', text: '🔙 Назад', data: 'broadcast_menu' }]]
          ).catch(e => console.warn('[broadcast] cron status screen edit failed:', e.message))
        }
```

- [ ] **Step 6: Обновить импорт в `api/index.js`**

Добавить `setStatusMessageId, getStatusMessageId` в импорт из `../lib/broadcast.js`.

- [ ] **Step 7: Запустить и убедиться, что проходит**

Run: `node --test test/handler.test.js`
Expected: PASS — 4 новых теста + существующие (в т.ч. «should send broadcast to all users», который теперь идёт через инлайн-завершение с фолбэк-отправкой).

- [ ] **Step 8: Полный прогон**

Run: `npm test`
Expected: PASS (все 6 файлов)

- [ ] **Step 9: Коммит**

```bash
git add api/index.js test/handler.test.js
git commit -m "feat: edit broadcast status screen on completion"
```

---

## Итоговая проверка

После выполнения всех задач:

1. `npm test` — весь набор зелёный.
2. Быстрый smoke-скрипт (ручной): `/start` → кнопка «📋 Связки» → «🔙 Назад» — в MAX-клиенте сообщения переписываются, новых не появляется.
3. Запуск рассылки на 25+ пользователей: экран «запущена» → по завершении «завершена» (правка), summary отдельным сообщением.
4. Проверить логи на `renderScreen: edit failed` — частота должна быть близка к нулю при штатной работе.
