# Редизайн раздела «Связки» — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Переделать раздел «Связки» бота в навигацию «список (постранично) → карточка связки», добавить предпросмотр сообщения «как видит пользователь» и открыть раздел создателям (не-админам) для их собственных связок.

**Architecture:** Все изменения — в одном файле `api/index.js`: новые helper'ы (`canManage`, `showLinksList`, `showLinkCard`), константы (`LINK_BUTTON_LABEL`, `LINKS_PAGE_SIZE`, whitelist payload'ов) и правки обработчиков `handleMessage` / `handleCallbackQuery`. Storage-слой (`lib/storage.js`) не трогаем. Тесты — поведенческие через мок fetch в `test/handler.test.js`.

**Tech Stack:** JavaScript (ESM), Hono.js, `node --test` + `node:assert/strict`, kv-mock, мок `global.fetch`.

**Спецификация:** `docs/superpowers/specs/2026-08-12-links-section-design.md`

## Global Constraints

- Единое сообщение для не-админа при «не найден» и «нет прав»: `⛔ Ключ "<ключ>" не найден или у вас нет прав.` — во всех проверках по ключу: `/link`, `del:`, `confirm_del:`, `link_preview:`
- Админу — раздельные сообщения: `❌ Ключ "<ключ>" не найден.` и страховочное `⛔ Вы можете открывать только свои ключи.`
- Проверка `canManage` выполняется ДО формирования любого текста с данными связки (`url`/`message`) — тексты отказа не содержат чужих данных
- `canManage(userId, link) = isAdmin(userId) || link.creator_id === userId`; `creator_id === null` → управляет только админ
- Точные матчи команд (не `startsWith('/link')` — это поймало бы `/links`): `text === '/links' || text.startsWith('/links ')`, `text === '/link' || text.startsWith('/link ')`
- Whitelist callback-фильтра для не-админов: payload'ы `links`, `back`; префиксы `links_page:`, `link_preview:`, `del:`, `confirm_del:`
- `LINK_BUTTON_LABEL = '👉 Перейти в канал'` — единая константа
- `LINKS_PAGE_SIZE = 20`; нумерация сквозная; «стр. P из M» в тексте сообщения
- Кнопки пагинации скрываются на границах (стр. 1 → только `[➡️]`, последняя → только `[⬅️]`)
- «🔙 Назад» в списке — только админам; создатель в списке: `[⬅️] [➡️]`; пустой список создателя и единственная страница без пагинации — `sendMessage` без клавиатуры (пустая inline_keyboard не отсылается; кнопка «Создать» создателю бесполезна — `/setlink` не-админам недоступен)
- Карточка: кнопки в два ряда `[🗑 Удалить] [👁 Посмотреть]` / `[🔙 Назад]`; message обрезается до 3000 символов (+«...»); пустой message → `(нет текста)`
- После удаления: `✅ Связка "<ключ>" удалена.` + кнопка `{ text: '🔙 К списку', data: 'links' }`
- `link_preview` НЕ вызывает `saveUser` / `addUserToLink` (админ не должен стать подписчиком)
- Сохранить экспорт в конце `api/index.js`: `export { app, handleBotStarted, handleMessage, handleCallbackQuery }`
- Не трогаем: статистику (`stats_key:` и подменю), рассылки, `lib/storage.js`, логику `handleBotStarted` (кроме замены хардкод-строки на `LINK_BUTTON_LABEL`)

## File Structure

| Файл | Роль |
|------|------|
| `api/index.js` | Все изменения логики: константы, helper'ы, обработчики |
| `test/handler.test.js` | Обновление 6 существующих тестов + ~20 новых поведенческих тестов |
| `docs/api.md` | Обновить таблицы «Команды бота», «Inline-кнопки», «Навигация» |
| `README.md` | Дополнить пример командами `/links` и `/link` |

---

### Task 1: Константа `LINK_BUTTON_LABEL`

**Files:**
- Modify: `api/index.js` — блок констант (~стр. 35) и `handleBotStarted` (~стр. 155-159)
- Test: `test/handler.test.js` — тест `should return link for valid payload` (стр. 68-75)

**Interfaces:**
- Consumes: — (существующая `sendMessageWithLink(chatId, text, { label, url })` из `lib/max-api.js`)
- Produces: `const LINK_BUTTON_LABEL = '👉 Перейти в канал'` — используется в Task 6

- [ ] **Step 1: Добавить ассерт в существующий тест**

В `test/handler.test.js`, тест `should return link for valid payload` (стр. 68-75), после `assert.ok(responseCall.body.text.includes('Welcome!'), 'should include message')` добавить:

```js
    const btn = responseCall.body.attachments[0].payload.buttons[0][0]
    assert.equal(btn.text, '👉 Перейти в канал', 'should use LINK_BUTTON_LABEL')
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run: `node --test test/handler.test.js`
Expected: FAIL — `should use LINK_BUTTON_LABEL` (assertion `btn.text` равен `undefined`).

- [ ] **Step 3: Реализовать константу**

В `api/index.js`, рядом с `const BOT_NICK = ...` (стр. 35):

```js
const LINK_BUTTON_LABEL = '👉 Перейти в канал'
```

В `handleBotStarted` (стр. 155-159) заменить:

```js
      await sendMessageWithLink(
        chat_id,
        data.message,
        { label: '👉 Перейти в канал', url: data.url }
      )
```

на:

```js
      await sendMessageWithLink(
        chat_id,
        data.message,
        { label: LINK_BUTTON_LABEL, url: data.url }
      )
```

- [ ] **Step 4: Запустить тесты**

Run: `node --test test/handler.test.js`
Expected: PASS (все тесты файла зелёные).

- [ ] **Step 5: Commit**

```bash
git add api/index.js test/handler.test.js
git commit -m "refactor: extract link button label constant"
```

---

### Task 2: Whitelist callback'ов для не-админов + guard `back` + guard `showAdminMenu`

**Files:**
- Modify: `api/index.js` — константы (~стр. 46), `showAdminMenu` (стр. 106-120), вызовы `showAdminMenu` (стр. 168, 1004), `handleCallbackQuery` (стр. 430, 1002-1005)
- Test: `test/handler.test.js` — тест `should silently ignore callback for non-admin` (стр. 441-448), добавить тест guard `back`

**Interfaces:**
- Produces: `showAdminMenu(chatId, userId)` — новая сигнатура с guard; whitelist-константы `ALLOWED_NON_ADMIN_PAYLOADS` / `ALLOWED_NON_ADMIN_PREFIXES` — используются во всех следующих задачах

- [ ] **Step 1: Переписать тест на фильтр + добавить тест guard `back`**

В `test/handler.test.js` заменить тест `should silently ignore callback for non-admin` (стр. 441-448):

```js
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
```

- [ ] **Step 2: Запустить тесты — убедиться, что падают**

Run: `node --test test/handler.test.js`
Expected: FAIL — `should show hint on back callback for non-admin` (сейчас `back` ведёт в админ-меню).

- [ ] **Step 3: Реализовать whitelist, guard `back`, guard `showAdminMenu`**

В `api/index.js`, после `const isAdmin = (userId) => ADMIN_IDS.includes(userId)` (стр. 46):

```js
// Callback-колбэки, доступные не-админам (с внутренней проверкой прав)
const ALLOWED_NON_ADMIN_PAYLOADS = ['links', 'back']
const ALLOWED_NON_ADMIN_PREFIXES = ['links_page:', 'link_preview:', 'del:', 'confirm_del:']
```

`showAdminMenu` (стр. 106) — новая сигнатура с guard:

```js
async function showAdminMenu (chatId, userId) {
  if (!isAdmin(userId)) return
  const count = await getUserCount()
  ...
}
```

Обновить оба вызова:
- стр. 168: `await showAdminMenu(chat_id)` → `await showAdminMenu(chat_id, user?.user_id)`
- стр. 1004 (handler `back`): `return showAdminMenu(chatId)` → `return showAdminMenu(chatId, userId)`

В `handleCallbackQuery`, заменить фильтр (стр. 430):

```js
  if (!isAdmin(userId)) return
```

на:

```js
  const isAllowedPayload = ALLOWED_NON_ADMIN_PAYLOADS.includes(cb.payload) ||
    ALLOWED_NON_ADMIN_PREFIXES.some(p => cb.payload.startsWith(p))
  if (!isAdmin(userId) && !isAllowedPayload) return
```

Хендлер `back` (стр. 1002-1005) — добавить guard:

```js
  if (cb.payload === 'back') {
    alog('DEBUG', ' callback: back → главное меню')
    if (!isAdmin(userId)) {
      return sendMessage(chatId, 'Используйте /links для просмотра ваших связок.')
    }
    return showAdminMenu(chatId, userId)
  }
```

- [ ] **Step 4: Запустить тесты**

Run: `node --test test/handler.test.js`
Expected: PASS. Существующие админ-тесты (`should show main menu on back callback`, `handleBotStarted ... admin panel`) должны остаться зелёными — guard не должен их сломать.

- [ ] **Step 5: Commit**

```bash
git add api/index.js test/handler.test.js
git commit -m "fix: whitelist callbacks for non-admins and guard back"
```

---

### Task 3: `canManage` + фикс прав в `del:` / `confirm_del:` / `/dellink`

**Files:**
- Modify: `api/index.js` — helper (~стр. 46), `handleMessage /dellink` (стр. 260-281), `handleCallbackQuery del:` (стр. 1007-1026), `confirm_del:` (стр. 1028-1041)
- Test: `test/handler.test.js` — тесты `should delete link on confirm_del` (стр. 348-359), `should handle confirm_del: with colon` (стр. 428-439), + 2 новых

**Interfaces:**
- Consumes: `ALLOWED_NON_ADMIN_PREFIXES` (Task 2)
- Produces: `canManage(userId, link)` — используется в Tasks 5-6

- [ ] **Step 1: Обновить 2 существующих теста + добавить 2 новых**

В `test/handler.test.js`:

Тест `should delete link on confirm_del: callback` (стр. 348-359): заменить поиск ответа и добавить ассерт кнопки:

```js
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
```

Тест `should handle confirm_del: with colon in key name` (стр. 428-439): заменить `includes('🗑')` на `includes('удалена')`:

```js
    const responseCall = fetchCalls.find(c => c.body?.text?.includes('удалена'))
```

Добавить в тот же `describe('callback_query handling')` два новых теста:

```js
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
```

- [ ] **Step 2: Запустить тесты — убедиться, что падают**

Run: `node --test test/handler.test.js`
Expected: FAIL — `should allow admin to delete foreign link` (старый код отклоняет админа через `creator_id !== userId`), `should deny del: for non-admin ...` (старый фильтр молча игнорит не-админа на `del:`).

- [ ] **Step 3: Реализовать `canManage` и правки хендлеров**

В `api/index.js`, после whitelist-констант (Task 2):

```js
const canManage = (userId, link) => isAdmin(userId) || link?.creator_id === userId
```

В `handleMessage`, хендлер `/dellink` (стр. 265-269): заменить

```js
    const isAdminUser = isAdmin(userId)
    if (!isAdminUser && existing.creator_id !== userId) {
      alog('DEBUG', ' /dellink: denied, key=%s, userId=%d, creator=%d', key, userId, existing.creator_id)
      return sendMessage(chat_id, '⛔ Вы можете удалять только свои ключи.')
    }
```

на

```js
    if (!canManage(userId, existing)) {
      alog('DEBUG', ' /dellink: denied, key=%s, userId=%d, creator=%d', key, userId, existing.creator_id)
      return sendMessage(chat_id, '⛔ Вы можете удалять только свои ключи.')
    }
```

В `handleCallbackQuery`, хендлер `del:` (стр. 1007-1026): заменить тело на:

```js
  if (cb.payload.startsWith('del:')) {
    const key = cb.payload.slice(4)
    const existing = await getLink(key)
    if (!isAdmin(userId) && (!existing || !canManage(userId, existing))) {
      return sendMessage(chatId, `⛔ Ключ "${key}" не найден или у вас нет прав.`)
    }
    if (!existing) return sendMessage(chatId, `❌ Ключ "${key}" не найден.`)
    alog('DEBUG', ' del: confirmation requested for key=%s, userId=%d', key, userId)
    return sendMessageWithKeyboard(
      chatId,
      `🗑 Удалить связку "${key}"?\n\n🔗 ${existing.url}\n\n💬 ${existing.message}`,
      [
        [
          { type: 'callback', text: '✅ Да, удалить', data: `confirm_del:${key}` },
          { type: 'callback', text: '❌ Нет', data: 'links' }
        ]
      ]
    )
  }
```

Хендлер `confirm_del:` (стр. 1028-1041): заменить тело на:

```js
  if (cb.payload.startsWith('confirm_del:')) {
    const key = cb.payload.slice('confirm_del:'.length)
    const existing = await getLink(key)
    if (!isAdmin(userId) && (!existing || !canManage(userId, existing))) {
      return sendMessage(chatId, `⛔ Ключ "${key}" не найден или у вас нет прав.`)
    }
    if (!existing) return sendMessage(chatId, `❌ Ключ "${key}" не найден.`)
    alog('DEBUG', ' confirm_del: deleted key=%s by userId=%d', key, userId)
    await delLink(key)
    return sendMessageWithKeyboard(chatId, `✅ Связка "${key}" удалена.`, [
      [{ type: 'callback', text: '🔙 К списку', data: 'links' }]
    ])
  }
```

- [ ] **Step 4: Запустить тесты**

Run: `node --test test/handler.test.js`
Expected: PASS. Существующий тест `should show confirmation on del: callback without deleting` (стр. 332-346) остаётся зелёным (кнопка `links` уже была в диалоге).

- [ ] **Step 5: Commit**

```bash
git add api/index.js test/handler.test.js
git commit -m "fix: unify link delete permissions with canManage"
```

---

### Task 4: `showLinksList` (пагинация) + `links` callback + `links_page:` + команда `/links`

**Files:**
- Modify: `api/index.js` — константа `LINKS_PAGE_SIZE` (~стр. 50), `buildLinksKeyboard` (стр. 97-103) → `showLinksList`, `handleMessage` фильтр (стр. 224) и хендлер `/links` (стр. 283-303), `handleCallbackQuery` `links` (стр. 450-462) + новый `links_page:`
- Test: `test/handler.test.js` — тесты `/links ...` (стр. 196-230), `should show links list with back button` (стр. 371-382), `non-admin commands ...` (стр. 451-467), + новые тесты пагинации/сортировки/`links_page:`

**Interfaces:**
- Consumes: `ALLOWED_NON_ADMIN_PAYLOADS` (Task 2), `getAllLinks` / `getLinksByCreator` (из `lib/storage.js`, уже импортированы)
- Produces: `showLinksList(chatId, userId, page = 1)` — используется в Task 5 («Назад» из карточки через payload `links`)

- [ ] **Step 1: Обновить существующие тесты списка**

В `test/handler.test.js`:

Тест `/links should list all links` (стр. 196-210): заменить на:

```js
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
```

Тест `/links should show empty state` (стр. 212-220): заменить на:

```js
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
```

Тест `/links for non-admin should be silently ignored` (стр. 222-230): заменить на:

```js
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
```

Тест `should show links list with back button` в callback-блоке (стр. 371-382): заменить на:

```js
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
```

Тест `/links should be silently ignored for non-admin` в блоке `non-admin commands` (стр. 457-467): заменить на:

```js
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
```

Заголовок блока `describe('non-admin commands are silently ignored')` (стр. 451) переименовать в `describe('non-admin command access')`.

- [ ] **Step 2: Добавить новые тесты пагинации, сортировки и `links_page:`**

В `describe('handleMessage commands')` добавить (после теста пустого состояния не-админа):

```js
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
```

В `describe('callback_query handling')` добавить:

```js
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
```

- [ ] **Step 3: Запустить тесты — убедиться, что падают**

Run: `node --test test/handler.test.js`
Expected: FAIL — новые тесты пагинации/сортировки (`стр. 1 из 2` не найдено), `should show own links for non-admin` (сейчас не-админ игнорируется), обновлённые тесты списка (старый формат «Активные связки» не совпадает).

- [ ] **Step 4: Реализовать `LINKS_PAGE_SIZE`, `showLinksList`, правки хендлеров**

В `api/index.js`, после `canManage` (Task 3):

```js
const LINKS_PAGE_SIZE = 20
```

Заменить `buildLinksKeyboard` (стр. 97-103) на `showLinksList` (ниже); **удалить ставшие мёртвыми** `formatLinksList` (стр. 87-94) и `buildLinksKeyboard` — единственные использования (стр. 293-302, 457-461) заменяются в этой же задаче:

```js
/** Показать список связок с пагинацией (админ — все, создатель — свои) */
async function showLinksList (chatId, userId, page = 1) {
  const isAdminUser = isAdmin(userId)
  const all = isAdminUser ? await getAllLinks() : await getLinksByCreator(userId)

  if (!all.length) {
    const text = isAdminUser
      ? '📭 Нет активных связок. Добавьте первую через /setlink.'
      : '📭 У вас пока нет связок.'
    if (isAdminUser) {
      return sendMessageWithKeyboard(chatId, text, [
        [{ type: 'callback', text: '🔙 Назад', data: 'back' }]
      ])
    }
    return sendMessage(chatId, text)
  }

  const sorted = [...all].sort((a, b) => a.key.localeCompare(b.key))
  const totalPages = Math.max(1, Math.ceil(sorted.length / LINKS_PAGE_SIZE))
  const safePage = Math.min(Math.max(1, page), totalPages)
  const start = (safePage - 1) * LINKS_PAGE_SIZE
  const slice = sorted.slice(start, start + LINKS_PAGE_SIZE)

  let out = (isAdminUser ? '📋 Связки' : '📋 Ваши связки')
  out += ` (${sorted.length}, стр. ${safePage} из ${totalPages})\n\n`
  out += slice.map((l, i) => `${start + i + 1}. 🔑 ${l.key} — /link ${l.key}`).join('\n')

  const rows = []
  const navRow = []
  if (safePage > 1) navRow.push({ type: 'callback', text: '⬅️', data: `links_page:${safePage - 1}` })
  if (safePage < totalPages) navRow.push({ type: 'callback', text: '➡️', data: `links_page:${safePage + 1}` })
  if (navRow.length) rows.push(navRow)
  if (isAdminUser) rows.push([{ type: 'callback', text: '🔙 Назад', data: 'back' }])

  // У создателя на единственной странице клавиатуры нет — пустую inline_keyboard не отправляем
  if (!rows.length) return sendMessage(chatId, out)

  alog('DEBUG', ' showLinksList: userId=%d, page=%d, total=%d, totalPages=%d', userId, safePage, sorted.length, totalPages)
  return sendMessageWithKeyboard(chatId, out, rows)
}
```

В `handleMessage` заменить фильтр (стр. 224):

```js
  // Не-админам разрешены только /links и /link — остальные команды молча игнорируем
  if (!isAdmin(userId) && text.startsWith('/')) {
    const isAllowedLinkCmd = text === '/links' || text.startsWith('/links ') ||
      text === '/link' || text.startsWith('/link ')
    if (!isAllowedLinkCmd) return
  }
```

Заменить хендлер `/links` (стр. 283-303) на:

```js
  if (text === '/links' || text.startsWith('/links ')) {
    const [pageArg] = parseArgs(text)
    const page = pageArg ? Math.max(1, parseInt(pageArg, 10) || 1) : 1
    return showLinksList(chat_id, userId, page)
  }
```

В `handleCallbackQuery` заменить хендлер `links` (стр. 450-462) на:

```js
  if (cb.payload === 'links') {
    return showLinksList(chatId, userId, 1)
  }

  if (cb.payload.startsWith('links_page:')) {
    const page = parseInt(cb.payload.slice('links_page:'.length), 10) || 1
    return showLinksList(chatId, userId, page)
  }
```

- [ ] **Step 5: Запустить тесты**

Run: `node --test test/handler.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add api/index.js test/handler.test.js
git commit -m "feat: paginate links list and open /links for creators"
```

---

### Task 5: Команда `/link` + карточка связки `showLinkCard`

**Files:**
- Modify: `api/index.js` — константа `MAX_LINK_MESSAGE_DISPLAY`, новая `showLinkCard` (после `showLinksList`), хендлер `/link` (в `handleMessage`, после хендлера `/links`)
- Test: `test/handler.test.js` — новый `describe('/link command')`

**Interfaces:**
- Consumes: `canManage` (Task 3), `showLinksList` (Task 4, кнопка «Назад» `data: 'links'`), `getLink` / `getLinksByCreator` (storage), whitelist slash-команд (Task 4)
- Produces: `showLinkCard(chatId, userId, key)` — используется только внутри `/link` хендлера

- [ ] **Step 1: Написать тесты карточки**

Добавить новый `describe` в `test/handler.test.js` (после `describe('handleMessage commands')`):

```js
describe('/link command', () => {
  beforeEach(() => {
    fetchCalls = []
    kv._clear()
  })

  it('should show card for admin', async () => {
    await kv.set('link:vip', { url: 'https://channel.com', message: 'Welcome!' })
    await handleMessage({
      chat_id: 1,
      message: { body: { text: '/link vip' } },
      user: { user_id: 123 }
    })
    const responseCall = fetchCalls.find(c => c.body?.text?.includes('🔑 Ключ: vip'))
    assert.ok(responseCall, 'card not found')
    assert.ok(responseCall.body.text.includes('Welcome!'), 'should show message')
    assert.ok(responseCall.body.text.includes('https://channel.com'), 'should show url')
    const expectedDeeplink = `https://max.ru/${process.env.BOT_NICK || 'YourBot'}?start=vip`
    assert.ok(responseCall.body.text.includes(expectedDeeplink), 'should show deeplink')
    assert.deepEqual(responseCall.body.attachments[0].payload.buttons, [
      [
        { type: 'callback', text: '🗑 Удалить', payload: 'del:vip' },
        { type: 'callback', text: '👁 Посмотреть', payload: 'link_preview:vip' }
      ],
      [{ type: 'callback', text: '🔙 Назад', payload: 'links' }]
    ])
  })

  it('should show usage when key is missing', async () => {
    await handleMessage({
      chat_id: 1,
      message: { body: { text: '/link' } },
      user: { user_id: 123 }
    })
    const responseCall = fetchCalls.find(c => c.body?.text?.includes('Формат: /link <ключ>'))
    assert.ok(responseCall, 'usage not found')
  })

  it('should show not found for missing key (admin)', async () => {
    await handleMessage({
      chat_id: 1,
      message: { body: { text: '/link nope' } },
      user: { user_id: 123 }
    })
    const responseCall = fetchCalls.find(c => c.body?.text?.includes('не найден'))
    assert.ok(responseCall, 'not found message expected')
    assert.ok(!responseCall.body.text.includes('или у вас нет прав'), 'admin should get distinct message')
  })

  it('should show card for non-admin own key', async () => {
    await setLinkFromStorage('own', 'https://own.com', 'Own msg', 999)
    await handleMessage({
      chat_id: 1,
      message: { body: { text: '/link own' } },
      user: { user_id: 999 }
    })
    const responseCall = fetchCalls.find(c => c.body?.text?.includes('🔑 Ключ: own'))
    assert.ok(responseCall, 'card not found for own link')
  })

  it('should deny foreign key for non-admin with unified message', async () => {
    await setLinkFromStorage('secret', 'https://secret.com', 'SECRET_TEXT', 123)
    await handleMessage({
      chat_id: 1,
      message: { body: { text: '/link secret' } },
      user: { user_id: 999 }
    })
    const responseCall = fetchCalls.find(c => c.body?.text)
    assert.ok(responseCall, 'response expected')
    assert.ok(responseCall.body.text.includes('не найден или у вас нет прав'), 'unified message expected')
    assert.ok(!responseCall.body.text.includes('SECRET_TEXT'), 'must not leak message')
  })

  it('should truncate long message in card', async () => {
    const longMsg = 'x'.repeat(3500)
    await kv.set('link:long', { url: 'https://l.com', message: longMsg })
    await handleMessage({
      chat_id: 1,
      message: { body: { text: '/link long' } },
      user: { user_id: 123 }
    })
    const responseCall = fetchCalls.find(c => c.body?.text?.includes('🔑 Ключ: long'))
    assert.ok(responseCall, 'card not found')
    assert.ok(responseCall.body.text.includes('...'), 'should show ellipsis')
    assert.ok(responseCall.body.text.length < 4000, 'card should be within message limits')
  })

  it('should show (нет текста) for empty message', async () => {
    await kv.set('link:empty', { url: 'https://e.com', message: '' })
    await handleMessage({
      chat_id: 1,
      message: { body: { text: '/link empty' } },
      user: { user_id: 123 }
    })
    const responseCall = fetchCalls.find(c => c.body?.text?.includes('(нет текста)'))
    assert.ok(responseCall, '(нет текста) not found')
  })
})
```

- [ ] **Step 2: Запустить тесты — убедиться, что падают**

Run: `node --test test/handler.test.js`
Expected: FAIL — `should show card for admin` («🔑 Ключ: vip» не найдено — команда не реализована).

- [ ] **Step 3: Реализовать `showLinkCard` и хендлер `/link`**

В `api/index.js`, после `showLinksList` (Task 4):

```js
const MAX_LINK_MESSAGE_DISPLAY = 3000

/** Показать карточку связки: текст, ссылка, диплинк + кнопки */
async function showLinkCard (chatId, userId, key) {
  const link = await getLink(key)
  if (!isAdmin(userId) && (!link || !canManage(userId, link))) {
    return sendMessage(chatId, `⛔ Ключ "${key}" не найден или у вас нет прав.`)
  }
  if (!link) return sendMessage(chatId, `❌ Ключ "${key}" не найден.`)

  const displayMessage = link.message?.length > 0
    ? (link.message.length > MAX_LINK_MESSAGE_DISPLAY ? `${link.message.slice(0, MAX_LINK_MESSAGE_DISPLAY)}...` : link.message)
    : '(нет текста)'

  const text =
    `🔑 Ключ: ${key}\n\n` +
    `💬 Сообщение:\n${displayMessage}\n\n` +
    `🔗 Ссылка: ${link.url}\n\n` +
    `🔗 Диплинк: https://max.ru/${BOT_NICK}?start=${key}`

  return sendMessageWithKeyboard(chatId, text, [
    [
      { type: 'callback', text: '🗑 Удалить', data: `del:${key}` },
      { type: 'callback', text: '👁 Посмотреть', data: `link_preview:${key}` }
    ],
    [{ type: 'callback', text: '🔙 Назад', data: 'links' }]
  ])
}
```

В `handleMessage`, сразу после хендлера `/links` (Task 4), добавить:

> **Позиция важна:** этот блок расположен ДО `// Broadcast draft flow` (стр. ~342) — активный черновик перехватывает любой текст админа, и `/link` за блоком не сработал бы:

```js
  if (text === '/link' || text.startsWith('/link ')) {
    const [key] = parseArgs(text)
    if (!key) {
      return sendMessage(chat_id, '⚠️ Формат: /link <ключ>\n\nПример:\n/link vip')
    }
    return showLinkCard(chat_id, userId, key)
  }
```

- [ ] **Step 4: Запустить тесты**

Run: `node --test test/handler.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add api/index.js test/handler.test.js
git commit -m "feat: add /link command with link card view"
```

---

### Task 6: Callback `link_preview:` — предпросмотр сообщения

**Files:**
- Modify: `api/index.js` — `handleCallbackQuery` (добавить хендлер `link_preview:` после `links_page:`)
- Test: `test/handler.test.js` — новый `describe('link_preview callback')`

**Interfaces:**
- Consumes: `canManage` (Task 3), `LINK_BUTTON_LABEL` (Task 1), whitelist-префикс `link_preview:` (Task 2), `sendMessageWithLink` (max-api)

- [ ] **Step 1: Написать тесты**

Добавить в `test/handler.test.js` (после `describe('callback_query handling')`):

```js
describe('link_preview callback', () => {
  beforeEach(() => {
    fetchCalls = []
    kv._clear()
  })

  it('should send message exactly as user sees it', async () => {
    await kv.set('link:vip', { url: 'https://channel.com', message: 'Welcome!' })
    await handleCallbackQuery({
      callback: { payload: 'link_preview:vip', user: { user_id: 123 } },
      message: { recipient: { chat_id: 1 } }
    })
    const responseCall = fetchCalls.find(c => c.body.attachments)
    assert.ok(responseCall, 'preview not found')
    assert.equal(responseCall.body.text, 'Welcome!')
    assert.equal(responseCall.body.attachments[0].type, 'inline_keyboard')
    const btn = responseCall.body.attachments[0].payload.buttons[0][0]
    assert.equal(btn.text, '👉 Перейти в канал')
    assert.equal(btn.url, 'https://channel.com')
    const subs = await kv.smembers('link_subs:vip')
    assert.equal(subs.length, 0, 'preview must not register subscriber')
  })

  it('should deny foreign key for non-admin with unified message', async () => {
    await kv.set('link:secret', { url: 'https://secret.com', message: 'SECRET_TEXT' })
    await handleCallbackQuery({
      callback: { payload: 'link_preview:secret', user: { user_id: 999 } },
      message: { recipient: { chat_id: 1 } }
    })
    const responseCall = fetchCalls.find(c => c.body?.text)
    assert.ok(responseCall, 'response expected')
    assert.ok(responseCall.body.text.includes('не найден или у вас нет прав'), 'unified message expected')
    assert.ok(!responseCall.body.text.includes('SECRET_TEXT'), 'must not leak message')
  })

  it('should show not found for missing key', async () => {
    await handleCallbackQuery({
      callback: { payload: 'link_preview:nope', user: { user_id: 123 } },
      message: { recipient: { chat_id: 1 } }
    })
    const responseCall = fetchCalls.find(c => c.body?.text?.includes('не найден'))
    assert.ok(responseCall, 'not found expected')
  })

  it('should work for non-admin own key', async () => {
    await setLinkFromStorage('own', 'https://own.com', 'Own msg', 999)
    await handleCallbackQuery({
      callback: { payload: 'link_preview:own', user: { user_id: 999 } },
      message: { recipient: { chat_id: 1 } }
    })
    const responseCall = fetchCalls.find(c => c.body.attachments)
    assert.ok(responseCall, 'preview not found')
    assert.equal(responseCall.body.text, 'Own msg')
  })
})
```

- [ ] **Step 2: Запустить тесты — убедиться, что падают**

Run: `node --test test/handler.test.js`
Expected: FAIL — «preview not found» (хендлер `link_preview:` отсутствует).

- [ ] **Step 3: Реализовать хендлер**

В `api/index.js`, в `handleCallbackQuery`, сразу после хендлера `links_page:` (Task 4), добавить:

```js
  if (cb.payload.startsWith('link_preview:')) {
    const key = cb.payload.slice('link_preview:'.length)
    const link = await getLink(key)
    if (!isAdmin(userId) && (!link || !canManage(userId, link))) {
      return sendMessage(chatId, `⛔ Ключ "${key}" не найден или у вас нет прав.`)
    }
    if (!link) return sendMessage(chatId, `❌ Ключ "${key}" не найден.`)
    alog('DEBUG', ' link_preview: key=%s, userId=%d', key, userId)
    return sendMessageWithLink(chatId, link.message, { label: LINK_BUTTON_LABEL, url: link.url })
  }
```

- [ ] **Step 4: Запустить тесты**

Run: `node --test test/handler.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add api/index.js test/handler.test.js
git commit -m "feat: add link preview as user message"
```

---

### Task 7: Документация + финальная валидация

**Files:**
- Modify: `docs/api.md` (таблицы «Команды бота», «Inline-кнопки (callback-колбэки)», «Навигация»), `README.md`

- [ ] **Step 1: Обновить `docs/api.md`**

Таблица «Команды бота» (стр. 44-52): строки `/dellink`, `/links` заменить и добавить `/link`:

```markdown
| `/dellink <key>` | Админ | Запрос на удаление связки (с подтверждением). Админы могут удалить любую, создатель — только свою |
| `/links [N]` | Все | Постраничный список связок (20 шт): админ — все, создатель — только свои. `N` — номер страницы |
| `/link <key>` | Все | Карточка связки: текст сообщения, ссылка, диплинк; кнопки «Удалить», «Посмотреть». Создатель — только свои |
```

Таблица «Inline-кнопки (callback-колбэки)» (стр. 57-66): заменить строки `del:`, `back`, `links` и добавить `links_page:`, `link_preview:`:

```markdown
| `del:<key>` | Кнопка `🗑 Удалить` в карточке | Показывает диалог подтверждения удаления |
| `confirm_del:<key>` | Кнопка `✅ Да, удалить` в диалоге | Удаляет связку; после — «🔙 К списку» |
| `links_page:<n>` | Кнопки `⬅️` / `➡️` в списке | Переход на страницу списка |
| `link_preview:<key>` | Кнопка `👁 Посмотреть` в карточке | Отправляет сообщение связки как видит пользователь |
| `back` | Кнопка `🔙 Назад` (только админ) | Возвращает в главное меню админа; не-админ получает подсказку |
| `links` | Кнопка `❌ Нет` в диалоге удаления, «🔙 К списку», «🔙 Назад» в карточке | Возвращает к списку связок |
| `create` | Кнопка `➕ Создать` в главном меню / пустом списке создателя | Показывает подсказку `/setlink` |
```

Раздел «Навигация» (стр. 69-70): переписать:

```markdown
Раздел «Связки»: главное меню → список (постранично, кнопки `⬅️`/`➡️`, «Назад» только у админа) → карточка через `/link <key>` или ввод команды. Карточка: текст сообщения, ссылка, диплинк, кнопки «🗑 Удалить», «👁 Посмотреть», «🔙 Назад» (к списку). У создателей (не-админов) список и карточки — только для своих связок.
```

- [ ] **Step 2: Обновить `README.md`**

В секцию «Пример» (стр. 28-31) после примера `/setlink` добавить:

```markdown
/links → список связок (постранично)
/link vip → карточка связки с кнопками «Удалить» и «Посмотреть»
```

- [ ] **Step 3: Финальная валидация**

Run: `npm test`
Expected: PASS — весь набор (`handler`, `storage`, `broadcast`, `max-api`, `migration`).

Run: `node --check api/index.js`
Expected: без вывода (синтаксис корректен).

- [ ] **Step 4: Commit**

```bash
git add docs/api.md README.md
git commit -m "docs: update api reference for links section"
```

---

## Self-Review (проведено)

- **Spec coverage:** пагинация/сортировка/границы (T4), карточка+диплинк+обрезка (T5), preview без подписки (T6), права `canManage`+унификация сообщений+порядок проверок (T3), whitelist slash/callback+guard `back`+guard `showAdminMenu` (T2, T4), константа label (T1), «✅ … К списку» после удаления (T3), тесты+доки (T1-T7). Не трогаемые области (статистика, рассылки, storage) в плане не фигурируют.
- **Placeholder scan:** весь код тестов и реализации приведён полностью, без «TBD»/«реализовать позже».
- **Type consistency:** `showLinksList(chatId, userId, page)` вызывается из `/links` (T4), `links`/`links_page:` (T4), «Назад» карточки через payload `links` (T5) — сигнатура единая. `showLinkCard(chatId, userId, key)` — только из `/link`. `canManage` и whitelist-константы объявлены до первого использования (T2/T3 → T4/T5/T6). Payload кнопок в fetch-body — поле `payload` (не `data`) — во всех тестах используется `b.payload`.
