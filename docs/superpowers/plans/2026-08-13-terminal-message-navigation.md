# Terminal Message Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Добавить inline-кнопки навигации в 9 терминальных сообщений команд (`/setlink` успех и ошибки, `/dellink` ошибки, «Изображение добавлено» в рассылке) через единую утилиту `sendCommandResult`.

**Architecture:** Вводим один хелпер `sendCommandResult(chatId, text, actions, backData)`, который собирает inline_keyboard из ряда действий + строки «Назад» и отправляет через существующий `sendMessageWithKeyboard`. Все изменения — только в `api/index.js`; `renderScreen`, `lib/nav.js`, KV-логика не трогаются. Кнопки используют только существующие payload'ы колбэков (`links`, `create`, `back`, `broadcast_menu`, `broadcast_images_done`).

**Tech Stack:** JavaScript (ES Modules), Hono.js, node:test (`npm test` → `node --test test/*.test.js`), мок KV (`lib/kv-mock.js`), мок fetch в тестах.

**Спека:** `docs/superpowers/specs/2026-08-13-terminal-message-navigation-design.md`

## Global Constraints

- **Команды всегда отправляют новые сообщения** — никогда не редактируем `nav_msg` из команд (коммит `1d28e6e`). Хелпер использует `sendMessageWithKeyboard`, не `renderScreen`.
- **Новых колбэков не добавляем** — только существующие: `links`, `create`, `back`, `broadcast_menu`, `broadcast_images_done:<id>`.
- **Никаких веток для не-админов** в изменяемых местах: `/setlink` и `/dellink` не-админами молча игнорируются на L345–348, рассылка — только админ.
- **Форма кнопки в коде:** `{ type: 'callback', text, data }` — `buildKeyboardAttachment` в `lib/max-api.js` сам мапит `data` → `payload` в исходящем запросе.
- **Не изменять:** `renderScreen`, `lib/nav.js`, `lib/max-api.js` (включая `console.log` в `sendMessageWithKeyboard`), `lib/storage.js`, `lib/broadcast.js`.
- **Не трогаем вне скоупа:** `/stats`, `/users`, `/links` пустой список не-админа, `/link` команда, подтверждение `/dellink` (уже с кнопками), шаг 1 рассылки, предпросмотр, `confirm_del`, `broadcast_clear_stale`.
- Тестовые окружения: `ADMIN_USER_IDS='123'` (админ `user_id: 123`, не-админ `999`), `BOT_NICK='TestBot'` — уже заданы в шапке `test/handler.test.js`.

---

### Task 1: Хелпер `sendCommandResult` + кнопки на «✅ Связка сохранена!»

**Files:**
- Modify: `api/index.js` — вставить хелпер после `const DENY = ...` (~L94–95); заменить `sendMessage` на `sendCommandResult` в блоке успеха `/setlink` (~L375–382)
- Test: `test/handler.test.js` — обновить тест `/setlink should create a link for admin` (L92–105)

**Interfaces:**
- Consumes: `sendMessageWithKeyboard(chatId, text, buttons)` из `lib/max-api.js` (уже импортирован), `BOT_NICK` (уже есть), `LINK_BUTTON_LABEL` не нужен.
- Produces: `async function sendCommandResult (chatId, text, actions = [], backData = 'back')` — отправляет `sendMessageWithKeyboard` с двумя рядами: `actions` (если непустой) + `[🔙 Назад]`. Используется задачами 2–4.

- [ ] **Step 1: Обновить тест — требование кнопок на сообщении успеха**

В `test/handler.test.js` заменить тест `/setlink should create a link for admin` (L92–105) на:

```js
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
    assert.equal(responseCall.body.attachments[0].type, 'inline_keyboard', 'should have keyboard')
    const keyboard = responseCall.body.attachments[0].payload.buttons
    assert.equal(keyboard.length, 2, 'should have two rows')
    assert.deepEqual(keyboard[0].map(b => b.payload), ['links', 'create'], 'actions row should be links/create')
    assert.deepEqual(keyboard[1].map(b => b.payload), ['back'], 'back row should be back')
    assert.equal(keyboard[0][0].text, '📋 Связки')
    assert.equal(keyboard[0][1].text, '➕ Создать ещё')
    assert.equal(keyboard[1][0].text, '🔙 Назад')
  })
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run: `node --test --test-name-pattern="setlink should create a link" test/handler.test.js`

Expected: FAIL — `responseCall.body.attachments` undefined (сообщение без клавиатуры) или `TypeError: Cannot read properties of undefined`.

- [ ] **Step 3: Добавить хелпер `sendCommandResult`**

В `api/index.js` сразу после `const DENY = (chatId) => ...` (L94–95) вставить:

```js
/** Терминальное сообщение команды: ряд действий + строка «Назад» */
async function sendCommandResult (chatId, text, actions = [], backData = 'back') {
  const rows = []
  if (actions.length) rows.push(actions.map(a => ({ type: 'callback', ...a })))
  rows.push([{ type: 'callback', text: '🔙 Назад', data: backData }])
  return sendMessageWithKeyboard(chatId, text, rows)
}
```

- [ ] **Step 4: Перевести сообщение успеха `/setlink` на хелпер**

В `api/index.js` заменить блок (~L375–382):

```js
    return sendMessage(
      chat_id,
      '✅ Связка сохранена!\n\n' +
      `🔑 Ключ: ${key}\n` +
      `🔗 Ссылка: ${url}\n` +
      `💬 Сообщение: ${msg}\n\n` +
      `Диплинк:\nhttps://max.ru/${BOT_NICK}?start=${key}`
    )
```

на:

```js
    return sendCommandResult(
      chat_id,
      '✅ Связка сохранена!\n\n' +
      `🔑 Ключ: ${key}\n` +
      `🔗 Ссылка: ${url}\n` +
      `💬 Сообщение: ${msg}\n\n` +
      `Диплинк:\nhttps://max.ru/${BOT_NICK}?start=${key}`,
      [
        { text: '📋 Связки', data: 'links' },
        { text: '➕ Создать ещё', data: 'create' }
      ]
    )
```

- [ ] **Step 5: Запустить тест — убедиться, что проходит**

Run: `node --test --test-name-pattern="setlink should create a link" test/handler.test.js`

Expected: PASS. Затем полный прогон: `npm test` — все тесты зелёные (остальные тесты `/setlink` ищут ответ по `body.text`, клавиатура их не ломает).

- [ ] **Step 6: Коммит**

```bash
git add api/index.js test/handler.test.js
git commit -m "feat: add nav buttons to setlink success message"
```

---

### Task 2: Кнопки «🔙 Назад» на ошибках `/setlink` (4 места)

**Files:**
- Modify: `api/index.js` — 4 ошибки `/setlink` (~L354–370): неверный формат, невалидный URL, длинный ключ, длинный URL
- Test: `test/handler.test.js` — обновить 4 теста ошибок (L119–158)

**Interfaces:**
- Consumes: `sendCommandResult(chatId, text, actions = [], backData = 'back')` из Task 1 — здесь вызывается с дефолтным `backData`, без `actions`.
- Produces: ничего нового.

- [ ] **Step 1: Обновить 4 теста — требование кнопки `back`**

В `test/handler.test.js` дополнить каждый из 4 тестов (`/setlink should validate URL format`, `/setlink should require all arguments`, `/setlink should reject key longer than 50 characters`, `/setlink should reject URL longer than 2048 characters`) блоком проверки клавиатуры перед закрывающей `})`:

```js
    assert.equal(responseCall.body.attachments[0].type, 'inline_keyboard', 'should have keyboard')
    const buttons = responseCall.body.attachments[0].payload.buttons.flat()
    assert.ok(buttons.some(b => b.payload === 'back'), 'should have back button')
```

Пример полного обновлённого теста (`/setlink should validate URL format`):

```js
  it('/setlink should validate URL format', async () => {
    await handleMessage({
      chat_id: 1,
      message: { body: { text: '/setlink bad not-a-url msg' } },
      user: { user_id: 123 }
    })
    const responseCall = fetchCalls.find(c => c.body.text && c.body.text.includes('http'))
    assert.ok(responseCall, 'URL validation error not found')
    assert.equal(responseCall.body.attachments[0].type, 'inline_keyboard', 'should have keyboard')
    const buttons = responseCall.body.attachments[0].payload.buttons.flat()
    assert.ok(buttons.some(b => b.payload === 'back'), 'should have back button')
  })
```

- [ ] **Step 2: Запустить тесты — убедиться, что падают**

Run: `node --test --test-name-pattern="setlink should (validate|require|reject)" test/handler.test.js`

Expected: FAIL — `Cannot read properties of undefined (reading 'type')`.

- [ ] **Step 3: Перевести 4 ошибки `/setlink` на хелпер**

В `api/index.js` заменить 4 вызова `sendMessage(chat_id, ...)` в блоке `/setlink` (L354–370):

1. Формат (L354–357):
```js
      return sendCommandResult(chat_id,
        '⚠️ Формат: /setlink <ключ> <url> <сообщение>\n\n' +
        'Пример:\n/setlink vip https://max.ru/channel/xxx Добро пожаловать! 🎉'
      )
```
2. Невалидный URL (L363):
```js
      return sendCommandResult(chat_id, '⚠️ URL должен быть валидным и начинаться с http:// или https://')
```
3. Длинный ключ (L366):
```js
      return sendCommandResult(chat_id, '⚠️ Ключ слишком длинный (максимум 50 символов).')
```
4. Длинный URL (L369):
```js
      return sendCommandResult(chat_id, '⚠️ URL слишком длинный (максимум 2048 символов).')
```

- [ ] **Step 4: Запустить тесты — убедиться, что проходят**

Run: `node --test --test-name-pattern="setlink should (validate|require|reject)" test/handler.test.js`

Expected: PASS. Затем `npm test` — полный прогон зелёный.

- [ ] **Step 5: Коммит**

```bash
git add api/index.js test/handler.test.js
git commit -m "feat: add nav buttons to setlink error messages"
```

---

### Task 3: Кнопки «🔙 Назад» на ошибках `/dellink` (3 места)

> **Дополнение к спеке (отмечено для ревьюера):** спека фиксирует 8 точек (для `/dellink` — «ключ не найден» и «нет прав»). В план добавлен 9-й вызов — `⚠️ Укажи ключ: /dellink <ключ>` (L387): тот же класс ошибки той же команды, одна строка тем же хелпером. Если ревьюер против — пропустить этот вызов.

**Files:**
- Modify: `api/index.js` — 3 ошибки `/dellink` (~L386–393): ключ не указан, ключ не найден, нет прав
- Test: `test/handler.test.js` — обновить `/dellink should warn on missing key` (L177–185), добавить тест «ключ не указан»

**Interfaces:**
- Consumes: `sendCommandResult` из Task 1 (дефолтный `backData`).
- Produces: ничего нового.

- [ ] **Step 1: Обновить тест `warn on missing key` + добавить тест «ключ не указан»**

В `test/handler.test.js` заменить тест `/dellink should warn on missing key` (L177–185) на:

```js
  it('/dellink should warn on missing key', async () => {
    await handleMessage({
      chat_id: 1,
      message: { body: { text: '/dellink nonexistent' } },
      user: { user_id: 123 }
    })
    const responseCall = fetchCalls.find(c => c.body.text && c.body.text.includes('не найден'))
    assert.ok(responseCall, 'not found warning not found')
    assert.equal(responseCall.body.attachments[0].type, 'inline_keyboard', 'should have keyboard')
    const buttons = responseCall.body.attachments[0].payload.buttons.flat()
    assert.ok(buttons.some(b => b.payload === 'back'), 'should have back button')
  })

  it('/dellink should warn when key omitted', async () => {
    await handleMessage({
      chat_id: 1,
      message: { body: { text: '/dellink' } },
      user: { user_id: 123 }
    })
    const responseCall = fetchCalls.find(c => c.body.text && c.body.text.includes('Укажи ключ'))
    assert.ok(responseCall, 'missing key argument warning not found')
    assert.equal(responseCall.body.attachments[0].type, 'inline_keyboard', 'should have keyboard')
    const buttons = responseCall.body.attachments[0].payload.buttons.flat()
    assert.ok(buttons.some(b => b.payload === 'back'), 'should have back button')
  })
```

- [ ] **Step 2: Запустить тесты — убедиться, что падают**

Run: `node --test --test-name-pattern="dellink should warn" test/handler.test.js`

Expected: FAIL — отсутствие клавиатуры/`Cannot read properties of undefined`. (Тест «нет прав» не пишем — ветка недостижима через команды, см. примечание в спеке к строке 7 таблицы.)

- [ ] **Step 3: Перевести 3 ошибки `/dellink` на хелпер**

В `api/index.js` заменить в блоке `/dellink` (~L386–393):

```js
    if (!key) return sendMessage(chat_id, '⚠️ Укажи ключ: /dellink <ключ>')
    const existing = await getLink(key)
    if (!existing) return sendMessage(chat_id, `❌ Ключ "${key}" не найден.`)
    if (!canManage(userId, existing)) {
      alog('DEBUG', ' /dellink: denied, key=%s, userId=%d, creator=%d', key, userId, existing.creator_id)
      return sendMessage(chat_id, '⛔ Вы можете удалять только свои ключи.')
    }
```

на:

```js
    if (!key) return sendCommandResult(chat_id, '⚠️ Укажи ключ: /dellink <ключ>')
    const existing = await getLink(key)
    if (!existing) return sendCommandResult(chat_id, `❌ Ключ "${key}" не найден.`)
    if (!canManage(userId, existing)) {
      alog('DEBUG', ' /dellink: denied, key=%s, userId=%d, creator=%d', key, userId, existing.creator_id)
      return sendCommandResult(chat_id, '⛔ Вы можете удалять только свои ключи.')
    }
```

- [ ] **Step 4: Запустить тесты — убедиться, что проходят**

Run: `node --test --test-name-pattern="dellink" test/handler.test.js`

Expected: PASS. Затем `npm test` — полный прогон зелёный.

- [ ] **Step 5: Коммит**

```bash
git add api/index.js test/handler.test.js
git commit -m "feat: add nav buttons to dellink error messages"
```

---

### Task 4: Кнопки «✅ Готово» + «🔙 Назад» на «📷 Изображение добавлено»

**Files:**
- Modify: `api/index.js` — сообщение «Изображение добавлено» в draft-флоу рассылки (~L482–484)
- Test: `test/handler.test.js` — новый describe `broadcast draft flow` (в конец файла)

**Interfaces:**
- Consumes: `sendCommandResult(chatId, text, actions, backData)` из Task 1 — здесь с `backData: 'broadcast_menu'`; `createBroadcast({ text, created_by })` из `lib/broadcast.js` (уже импортирован в тесте, L21–24).
- Produces: ничего нового.

- [ ] **Step 1: Написать падающий тест**

В конец `test/handler.test.js` добавить:

```js
describe('broadcast draft flow', () => {
  beforeEach(() => {
    fetchCalls = []
    kv._clear()
  })

  it('should send nav buttons on image added message', async () => {
    const draft = await createBroadcast({ text: 'Hello', created_by: 123 })
    await handleMessage({
      chat_id: 1,
      message: {
        body: { text: 'ignore' },
        attachments: [{ type: 'image', payload: { file_id: 'FILE1' } }]
      },
      user: { user_id: 123 }
    })
    const responseCall = fetchCalls.find(c => c.body.text && c.body.text.includes('Изображение добавлено'))
    assert.ok(responseCall, 'image added message not found')
    assert.equal(responseCall.body.attachments[0].type, 'inline_keyboard', 'should have keyboard')
    const keyboard = responseCall.body.attachments[0].payload.buttons
    assert.deepEqual(keyboard[0].map(b => b.payload), [`broadcast_images_done:${draft.id}`], 'actions row should be done button')
    assert.equal(keyboard[0][0].text, '✅ Готово')
    assert.deepEqual(keyboard[1].map(b => b.payload), ['broadcast_menu'], 'back row should be broadcast_menu')
    assert.equal(keyboard[1][0].text, '🔙 Назад')
  })
})
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run: `node --test --test-name-pattern="image added message" test/handler.test.js`

Expected: FAIL — `responseCall.body.attachments` undefined.

- [ ] **Step 3: Реализовать**

В `api/index.js` заменить (~L482–484):

```js
            return sendMessage(chat_id, `📷 Изображение добавлено (${images.length}). Отправьте ещё или нажмите «Готово».`)
```

на:

```js
            return sendCommandResult(
              chat_id,
              `📷 Изображение добавлено (${images.length}). Отправьте ещё или нажмите «Готово».`,
              [{ text: '✅ Готово', data: `broadcast_images_done:${draft.id}` }],
              'broadcast_menu'
            )
```

- [ ] **Step 4: Запустить тест — убедиться, что проходит**

Run: `node --test --test-name-pattern="image added message" test/handler.test.js`

Expected: PASS. Затем `npm test` — полный прогон зелёный (включая `render-screen.test.js`, `nav.test.js` — не должны быть затронуты).

- [ ] **Step 5: Коммит**

```bash
git add api/index.js test/handler.test.js
git commit -m "feat: add nav buttons to broadcast image message"
```

---

## Финальная проверка

- [ ] `npm test` — весь набор зелёный
- [ ] В `api/index.js` не осталось `sendMessage` в изменённых флоу (grep: `grep -n "sendMessage(" api/index.js` — только вне скоупа: `/links` пустой список не-админа, `/stats`, `/users`, `/link`, deep-link `/start`)
- [ ] `renderScreen`, `lib/nav.js`, `lib/max-api.js`, `lib/storage.js`, `lib/broadcast.js` — без изменений (`git diff --stat`)
- [ ] Спека `docs/superpowers/specs/2026-08-13-terminal-message-navigation-design.md` покрыта: точки 1–8 таблицы + утилита + тесты (плюс задокументированное дополнение Task 3)
