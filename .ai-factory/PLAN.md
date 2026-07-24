# План: Исправление рассылки и UX-улучшения

Branch: main (create_branches: false)
Created: 2026-07-24

## Settings
- Testing: yes
- Logging: verbose
- Docs: no

## Research Context
Source: .ai-factory/RESEARCH.md (текущая сессия explore)

Проблемы найдены в explore-режиме:

1. **break вместо continue** (`api/index.js:701`) — при ошибке отправки любому пользователю цикл прерывается целиком, `sent = 0`, рассылка застревает
2. **Относительный URL в fetch** (`api/index.js:730`) — `fetch('/process-broadcasts?...')` падает в Node.js 20.x (undici), цепочка батчей обрывается
3. **Нет тестовой отправки** — нельзя проверить рассылку не беспокоя подписчиков
4. **Нет перезапуска** — отправленную рассылку нельзя отправить заново

## Tasks

- [ ] Task 1: Исправить `break` → `continue` в `broadcast_confirm_now`
- [ ] Task 2: Исправить относительный URL в fetch chain
- [ ] Task 3: Добавить кнопку «🔍 Тест» на экран подтверждения
- [ ] Task 4: Добавить кнопку «🔄 Перезапустить» для отправленных рассылок
- [ ] Task 5: Написать тесты

---

### Task 1: Исправить break → continue в broadcast_confirm_now

**Файл:** `api/index.js:696-702`

**Что сейчас:** При ошибке отправки пользователю цикл прерывается `break`, останавливая всю рассылку.

**Что нужно:** Заменить `break` на `continue` — пропускать упавшего пользователя, но продолжать отправку остальным.

```javascript
// Было:
} catch (err) {
  console.error(...)
  await markFailed(bid, user.user_id).catch(() => {})
  break  // ← ВСЁ
}
cursor++

// Стало:
} catch (err) {
  console.error(...)
  await markFailed(bid, user.user_id).catch(() => {})
  // continue — cursor не двигается, failed пользователь будет пропущен при следующем проходе
}
cursor++
```

**Важно:** `cursor++` после try-catch уже не выполнится при ошибке, так как `continue` переходит к следующей итерации. Нужно переписать цикл так, чтобы `cursor` увеличивался ТОЛЬКО при успехе или when alreadySent. При ошибке курсор остаётся на месте (для ретрая), но цикл продолжается.

**Лучшее решение:** Переписать на `for...of` с явным управлением cursor:

```javascript
for (const user of batch) {
  try {
    const alreadySent = await isSent(bid, user.user_id)
    if (alreadySent) { cursor++; continue }
    await sendBroadcastMessage(user.user_id, b)
    await markSent(bid, user.user_id)
    await markDelivered(bid, user.user_id)
    sent++
    cursor++
  } catch (err) {
    console.error(`[broadcast] ${bid}: ERROR for userId=${user.user_id}: ${err.message}`)
    await markFailed(bid, user.user_id).catch(() => {})
    // cursor НЕ двигаем — будет ретрай
    continue  // ← продолжаем следующих пользователей
  }
}
```

**Дополнительно:** Применить ту же логику и в `/process-broadcasts` (строки ~988-1008) — там уже используется `continue`, но нужно проверить что `cursor` и `processedInBatch` корректно считаются.

---

### Task 2: Исправить относительный URL в fetch chain

**Файл:** `api/index.js:728-732`

**Что сейчас:** `fetch('/process-broadcasts?secret=...')` — относительный URL, не работает в Node.js 20.

**Что нужно:** Заменить на абсолютный URL, используя `process.env.VERCEL_URL` (устанавливается Vercel автоматически) или baseUrl из env.

Добавить вспомогательную функцию получения base URL:

```javascript
function getBaseUrl (c) {
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`
  if (c?.req?.header('host')) {
    const scheme = c.req.header('x-forwarded-proto') || 'https'
    return `${scheme}://${c.req.header('host')}`
  }
  return process.env.BASE_URL || 'http://localhost:3000'
}
```

В `broadcast_confirm_now` (вызывается из `handleCallbackQuery` без доступа к `c`):

```javascript
const secret = process.env.SETUP_SECRET
if (secret) {
  const baseUrl = getBaseUrl()
  fetch(`${baseUrl}/process-broadcasts?secret=${encodeURIComponent(secret)}`)
    .catch(e => console.warn('[broadcast] chain call failed:', e.message))
}
```

**Dependency:** Функция `getBaseUrl` должна быть доступна из `handleCallbackQuery`.

---

### Task 3: Добавить кнопку «🔍 Тест» на экран подтверждения

**Файл:** `api/index.js`

**Контекст:** Сейчас после шага 3 (кнопки) или после нажатия «Готово» показывается экран подтверждения с кнопками:
- `✅ Отправить` → `broadcast_confirm_now`
- `🔙 Назад` → `broadcast_menu`

**Что добавить:** Третью кнопку `🔍 Тест` → `broadcast_test:{bid}`

**Обработчик `broadcast_test:{bid}`:**

1. Получить broadcast по id
2. Получить chat_id админа из контекста вызова
3. Вызвать `sendBroadcastMessage(adminChatId, broadcast)` — отправляет рассылку только админу
4. Показать результат: «✅ Тестовая отправка выполнена!» или «❌ Ошибка: ...»

**Где добавить:**

1. После сохранения кнопок (step 3), в экране подтверждения — добавить кнопку `broadcast_test` в клавиатуру:

```javascript
// В строке ~394
[[{ type: 'callback', text: '✅ Отправить', data: `broadcast_confirm_now:${draft.id}` }],
 [{ type: 'callback', text: '🔍 Тест', data: `broadcast_test:${draft.id}` }],
 [{ type: 'callback', text: '🔙 Назад', data: 'broadcast_menu' }]]
```

2. После `broadcast_buttons_done` (строка ~664) — там тоже экран подтверждения:

```javascript
[[{ type: 'callback', text: '✅ Отправить', data: `broadcast_confirm_now:${bid}` }],
 [{ type: 'callback', text: '🔍 Тест', data: `broadcast_test:${bid}` }],
 [{ type: 'callback', text: '🔙 Назад', data: 'broadcast_menu' }]]
```

3. Добавить обработчик в `handleCallbackQuery`:

```javascript
if (cb.payload.startsWith('broadcast_test:')) {
  const bid = cb.payload.slice('broadcast_test:'.length)
  const b = await getBroadcast(bid)
  if (!b) return sendMessage(chatId, '❌ Рассылка не найдена.')

  try {
    await sendBroadcastMessage(chatId, b)  // chatId админа
    return sendMessageWithKeyboard(chatId,
      '✅ Тестовая отправка выполнена!\n\n' +
      formatBroadcastPreview(b),
      [[{ type: 'callback', text: '🔙 Назад', data: 'broadcast_menu' }]]
    )
  } catch (err) {
    console.error(`[broadcast] test ${bid}: ${err.message}`)
    return sendMessage(chatId, `❌ Ошибка тестовой отправки: ${err.message}`)
  }
}
```

---

### Task 4: Добавить кнопку «🔄 Перезапустить» для отправленных рассылок

**Файл:** `api/index.js`

**Контекст:** В `broadcast_view` для статуса `sent` сейчас нет кнопки действия (только статистика и удаление).

**Что добавить:** Кнопку `🔄 Перезапустить` → `broadcast_restart:{bid}` для статусов `sent` и `cancelled`.

**Обработчик `broadcast_restart:{bid}`:**

1. Получить broadcast по id
2. Сбросить статус в `draft`: `updateBroadcast(bid, { status: 'draft', scheduled_at: null })`
3. Сбросить статистику: удалить сеты sent/delivered/opened/unsubbed/failed, сбросить cursor в 0
4. Показать экран подтверждения с кнопками Отправить/Редактировать/Тест/Назад

> **Почему `draft`, а не `scheduled`:** После перезапуска пользователь должен подтвердить отправку на экране подтверждения, а не уходить сразу в рассылку. Это даёт контроль перед отправкой сотням подписчиков.

**Где добавить кнопку:** В `broadcast_view`, для `sent` и `cancelled`:

```javascript
if (b.status === 'sent' || b.status === 'cancelled') {
  btnRows.push([{ type: 'callback', text: '🔄 Перезапустить', data: `broadcast_restart:${bid}` }])
}
```

**Нужна вспомогательная функция** для очистки статистических сетов (или использовать `deleteBroadcast`-подобную логику без удаления самого broadcast). Добавить в `lib/broadcast.js`:

```javascript
export async function resetBroadcastStats (id) {
  const kv = await getKv()
  const keys = [
    `${BR_PREFIX}${id}${SENT_SUFFIX}`,
    `${BR_PREFIX}${id}${DELIVERED_SUFFIX}`,
    `${BR_PREFIX}${id}${OPENED_SUFFIX}`,
    `${BR_PREFIX}${id}${UNSUBBED_SUFFIX}`,
    `${BR_PREFIX}${id}${FAILED_SUFFIX}`,
    `${BR_PREFIX}${id}${CURSOR_SUFFIX}`
  ]
  for (const key of keys) {
    await kv.del(key)
  }
}
```

---

### Task 5: Написать тесты

**Файлы:** `test/broadcast.test.js` (новые тесты), `test/handler.test.js` (новые тесты)

**Существующие тесты:** `broadcast.test.js` тестирует CRUD, tracking, cursor, scheduled. `handler.test.js` тестирует handleMessage, handleBotStarted, handleCallbackQuery (но не broadcast-колбеки).

**Что добавить:**

1. **Тест `broadcast_confirm_now` с падающим пользователем — должен пропустить и продолжить**
   - Мокаем `sendBroadcastMessage` чтобы кидал ошибку для первого пользователя
   - Вызываем `handleCallbackQuery` с `broadcast_confirm_now:...`
   - Проверяем что `markFailed` был вызван для упавшего
   - Проверяем что остальным пользователям сообщение было отправлено
   - Проверяем что статус рассылки не `sent` (если не все отправлены)

2. **Тест тестовой отправки `broadcast_test`**
   - Создаём broadcast в KV
   - Вызываем `handleCallbackQuery` с `broadcast_test:...`
   - Проверяем что `sendBroadcastMessage` вызван с chat_id админа
   - Проверяем ответ об успехе

3. **Тест перезапуска `broadcast_restart`**
   - Создаём broadcast со статусом `sent`
   - Вызываем `handleCallbackQuery` с `broadcast_restart:...`
   - Проверяем что курсор сброшен в 0
   - Проверяем что статус стал `scheduled`
   - Проверяем что сеты статистики удалены

4. **Тест `sendBroadcastMessage` с разными форматами**
   - С текстом
   - С текстом + изображениями
   - С текстом + кнопками
   - Без текста (только изображения)

**Паттерн тестирования:** Использовать `kv._clear()` в `beforeEach`, мокать `global.fetch`, проверять через `fetchCalls` что было отправлено.
