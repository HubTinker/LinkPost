# Спецификация: Навигация «Один экран» (edit-in-place)

**Дата:** 2026-08-13
**Статус:** Согласовано (brainstorming session + review, 3 правки приняты)
**Файлы:** `api/index.js`, `lib/max-api.js`, `lib/nav.js` (новый), `lib/broadcast.js`, `test/handler.test.js`, `test/max-api.test.js`, `test/nav.test.js` (новый), `test/broadcast.test.js`

---

## 1. Цель

Убрать «растягивание» ленты при навигации по разделам бота: переходы по inline-кнопкам должны перезаписывать сообщение, на котором нажата кнопка (правка на месте), а не отправлять новое. Работа с пользовательским контентом (ввод текста, изображения, превью, диплинки, прогресс и сводки рассылок, команды) остаётся как сейчас — новые сообщения.

---

## 2. Правило роли сообщения

Изменяется не «тип события», а **роль сообщения**:

- **Навигационный экран** — сообщение с inline-клавиатурой, предназначенное для перехода между состояниями UI. При нажатии его кнопки это сообщение становится источником `message_callback` → **редактируется на месте**. Определение ориентировано на фактическую реализацию: экран = сообщение с клавиатурой.
- **Контент** — сообщение, созданное в ответ на пользовательский ввод или как результат работы (текст, изображение, превью связки, диплинк, тестовая отправка, прогресс, сводка). Оно создаётся **новым сообщением** и больше не переписывается (кроме существующего самокорректирующегося прогресса рассылки).

Переход роли: сообщение «Текст сохранён! Нажмите Готово» создано после ввода текста → контент (новое). После нажатия «Готово» это же сообщение становится источником navigation callback → его можно редактировать (шаг 3/4).

---

## 3. Матрица поведения (инвариант)

| Ситуация | Поведение |
|---|---|
| Нажата inline-кнопка навигации, id сообщения (`body.mid`) есть | Edit сообщения-источника |
| id сообщения (`body.mid`) отсутствует | Фолбэк через `nav_msg:{chatId}`, затем новый message |
| Edit source завершился ошибкой | **Не переходить к `nav_msg`**; delete source (best-effort) + send new |
| Пользователь отправил текст | Новое сообщение |
| Пользователь отправил изображение | Новое сообщение |
| `/start`, `/links`, `/stats`, остальные команды | Как сейчас, новые сообщения |
| Preview (`link_preview`) / диплинк (`?start=`) | Новое сообщение |
| Progress рассылки | Как сейчас, отдельное самокорректирующееся сообщение |
| Summary рассылки | Новое сообщение |
| Статус «Рассылка запущена» | Навигационный экран (edit source) + сохранить `status_message_id` для рассылки |
| Статус «Рассылка завершена» | Edit **конкретного** `status_message_id` рассылки |
| Сообщение без inline-клавиатуры (нет кнопок) | Новое сообщение — по определению не является навигационным экраном; edit без новой клавиатуры оставил бы старые кнопки (см. §5.4) |

---

## 4. Архитектура

### 4.1. `lib/max-api.js`

- Вынести из `sendMessageWithKeyboard` билдер `buildKeyboardAttachment(buttons)` — та же схема: `attachments: [{ type: 'inline_keyboard', payload: { buttons } }]`. Используется send- и edit-вариантами.
- **`editMessageWithKeyboard(chatId, messageId, text, buttons)`** — `PUT /messages?chat_id=&message_id=` с текстом и клавиатурой.
- **`extractMessageId(response)`** — нормализация id из ответа MAX API: `message.body.mid` (реальный формат) или `message_id`.
- **`deleteMessage(chatId, messageId)`** — `DELETE /messages?chat_id=&message_id=`.
- Существующий `editMessage` (текст без клавиатуры) остаётся для прогресса рассылок.

### 4.2. `lib/nav.js` (новый модуль)

- `setNavMessageId(chatId, messageId)` / `getNavMessageId(chatId)`.
- Ключ `nav_msg:{chatId}`, TTL 24 часа. Паттерн `getKv()` + kv-mock как в `storage.js`.
- **Ответственность — одна:** фолбэк-цель правки, когда в callback-обновлении нет `message_id`. Никакого использования для состояния рассылок.

### 4.3. `lib/broadcast.js` — статусное сообщение рассылки

- `STATUS_MSG_SUFFIX = ':status_msg'`, `setStatusMessageId(broadcastId, messageId)` / `getStatusMessageId(broadcastId)` — тот же паттерн, что `progress_msg` (TTL 7 дней).
- Очистка: добавить ключ в `deleteBroadcast` и в `resetBroadcastStats` (рядом с `PROGRESS_MSG_SUFFIX`).
- Связь: `broadcastId ↔ статусный экран` — естественный идентификатор; `chatId` не подходит (несколько запусков, повторные запуски).
- **Семантика `status_message_id`:** хранит ТОЛЬКО ID навигационного статусного экрана конкретного запуска рассылки — экран «📤 Рассылка #X запущена...», который затем правкой становится «✅ Рассылка #X завершена...». Не progress message, не summary, не test send, не confirmation и не «последнее сообщение».

### 4.4. `renderScreen` в `api/index.js`

Единая точка рендера навигационных экранов. Экспортируется для тестов.

```js
// text: string, buttons: массив рядов (всегда непустой — см. §5.4)
// useNavFallback: разрешает fallback на nav_msg при отсутствии editMsgId.
// Команды (/links, /link, /start) передают false — их ответ всегда новое сообщение.
async function renderScreen ({ chatId, editMsgId, text, buttons, useNavFallback = true }) {
  if (!buttons?.length) throw new Error('renderScreen: buttons required')
  // target — единственное сообщение, которое пытаемся перезаписать
  let targetId = editMsgId
  if (targetId == null && useNavFallback) {
    try {
      targetId = await getNavMessageId(chatId)
    } catch (e) {
      alog('WARN', 'renderScreen: getNavMessageId failed: %s', e.message)
    }
  }
  if (targetId != null) {
    let edited = false
    try {
      await editMessageWithKeyboard(chatId, targetId, text, buttons)
      edited = true
    } catch (e) {
      alog('WARN', 'renderScreen: edit failed for %s: %s', targetId, e.message)
      // Жёсткий инвариант: после ошибки edit конкретного target nav_msg не используется.
      // Удаляем ровно тот target, который пытались редактировать.
      try { await deleteMessage(chatId, targetId) } catch (de) {
        alog('WARN', 'renderScreen: delete failed for %s: %s', targetId, de.message)
      }
    }
    // KV-запись выполняется ТОЛЬКО после успешного edit и вне edit-try
    if (edited) {
      await saveNavMessageIdSafely(chatId, targetId)
      return { message_id: targetId }
    }
  }
  try {
    const resp = await sendMessageWithKeyboard(chatId, text, buttons)
    const respMid = extractMessageId(resp)
    if (respMid != null) await saveNavMessageIdSafely(chatId, respMid)
    return resp
  } catch (e) {
    alog('WARN', 'renderScreen: send failed: %s', e.message)
    return null
  }
}

/** Best-effort запись nav_msg: сбой KV не должен ломать UI */
async function saveNavMessageIdSafely (chatId, messageId) {
  try {
    await setNavMessageId(chatId, messageId)
  } catch (e) {
    alog('WARN', 'renderScreen: failed to save nav message id: %s', e.message)
  }
}
```

Инварианты алгоритма:

1. `target` выбирается ОДИН раз: `editMsgId`, либо (только если `editMsgId` отсутствует и `useNavFallback` истинно) `nav_msg`.
2. **Жёсткий инвариант:** если `editMsgId` был передан, `nav_msg` не используется ни при каких обстоятельствах — в том числе после неудачного edit. После ошибки edit удаляем ровно тот target, который пытались редактировать. Никогда не редактируем/удаляем другой экран из KV.
3. **Разделение операций:** try/catch охватывает ТОЛЬКО `editMessageWithKeyboard`; запись `nav_msg` — best-effort (`saveNavMessageIdSafely`), сбой KV никогда не превращает успешный edit в фолбэк delete+send.
4. Non-throwing при ошибках API/KV: edit fail → WARN → delete (best-effort) → send; send fail → WARN + `null`; `getNavMessageId` fail → WARN. Единственный throw — guard непустых `buttons` (программистская ошибка).
5. В худшем случае (всё упало) — новое сообщение: поведение как сегодня.
6. При любом успешном исходе актуальный `message_id` пишется в `nav_msg:{chatId}` (только через `renderScreen`; `sendMessage`, preview, summary, progress его не меняют).
7. **Команды не используют `nav_msg`:** `/start`, `/links`, `/link` вызывают хелперы/`renderScreen` с `useNavFallback: false` → ответ всегда новое сообщение (матрица §3).

---

## 5. Проводка в `api/index.js`

### 5.1. `handleCallbackQuery`

- В начале: `const editMsgId = update.message?.body?.mid ?? update.message?.message_id ?? null` (реальный формат — `body.mid`, подтверждён на живом webhook 2026-08-13).
- **Все рендер-ответы** (экраны с клавиатурой) → `renderScreen({ chatId, editMsgId, ... })` вместо `sendMessageWithKeyboard`:
  `links`, `links_page:*`, `create`, `users`, `broadcast_menu`, `broadcast_create`, `stats`, `stats_general`, `stats_by_key`, `stats_key:*`, `stats_top`, `stats_broadcasts_overall`, `broadcast_images_done:*`, `broadcast_buttons_done:*`, `broadcast_test:*` (только экран результата), `broadcast_restart:*`, `broadcast_confirm_now:*` (см. §6), `broadcast_list`, `broadcast_view:*`, `broadcast_stats:*`, `broadcast_delete:*`, `broadcast_delete_confirm:*`, `broadcast_stop:*`, `broadcast_resume:*`, `broadcast_edit:*`, `broadcast_clear_stale`, `back` (админская ветка → `showAdminMenu`; не-админская подсказка без клавиатуры — как сейчас, `sendMessage`), `del:*`, `confirm_del:*`.
- **Контент-отправки остаются как есть** (новые сообщения): `link_preview` (`sendMessageWithLink`), тестовая отправка рассылки (`sendBroadcastMessage`), progress-сообщения, summary, все plain-ошибки (`❌ ...` через `sendMessage`).

### 5.2. Хелперы экранов

- `showLinksList(chatId, userId, page, editMsgId)`, `showLinkCard(chatId, userId, key, editMsgId)`, `showAdminMenu(chatId, userId, editMsgId)` — добавляется параметр, внутренние отправки → `renderScreen`.
- Вызовы из `handleMessage` (команды `/links`, `/link`) передают `editMsgId = null` — команды не трогаем.

### 5.3. Правки при ошибках «не найдено»

Плейн-ошибки (`❌ Ключ не найден`, `⛔ нет прав`) внутри callback-веток остаются `sendMessage` — новое сообщение (контекст исходного экрана сохраняется).

### 5.4. Экран без клавиатуры

`showLinksList` для не-админа на единственной странице (`rows.length === 0`) остаётся `sendMessage` без клавиатуры. Исключение из правила A: edit без новой клавиатуры оставил бы старые кнопки на переписанном экране. `renderScreen` вызывается только с непустым `buttons`.

---

## 6. Поток рассылки

### 6.1. Запуск (`broadcast_confirm_now:*`)

```
batch 1 отправлен
  ├─ завершена (cursor >= users.length):
  │     updateBroadcast(status: 'sent')
  │     renderScreen(editMsgId) → «✅ Рассылка #X завершена! Отправлено N сообщений.» + [🔙 Назад]
  │     summary (детальные цифры) → новое сообщение (как сегодня)
  │     (отдельное короткое сообщение «завершена» больше не шлём — экран правки его заменяет)
  │     status_message_id НЕ создаётся/не сохраняется: финальный экран терминальный,
  │     записывать id нечему и незачем
  └─ не завершена:
        result = renderScreen(editMsgId) → «📤 Рассылка #X запущена! … Продолжаю...» + [🔙 Назад]
        if (result?.message_id) setStatusMessageId(bid, result.message_id)   // ДО запуска цепочки
        chain call (fetch /process-broadcasts)
```

Сохранение `status_message_id` происходит строго до вызова цепочки — гонки с завершением нет. Жизненный цикл ключа: создаётся только на ветке «не завершена» при запуске, перезаписывается при каждом новом запуске, читается при завершении в цепочке, удаляется вместе с рассылкой (§4.3).

### 6.2. Завершение в цепочке (`/process-broadcasts` и cron)

```
statusMsgId = getStatusMessageId(b.id)
if (statusMsgId) →
    editMessageWithKeyboard(b.created_by_chat_id, statusMsgId,
        «✅ Рассылка #X завершена! …», [[🔙 Назад]])
    // best-effort: при ошибке только WARN — summary уже содержит все цифры
summary → новое сообщение (как сегодня, без изменений)
```

`nav_msg` для завершения рассылки **не используется** — только `status_message_id` конкретной рассылки. Если `status_message_id` отсутствует — поведение как сегодня (только summary).

---

## 7. Обработка ошибок

Без различения кодов (404/400/429/5xx) — без отдельного retry/error-слоя:

```
edit
  ↓ ошибка
log WARN
  ↓
best-effort delete target
  ↓
send new
```

`renderScreen` не бросает исключения наружу. Ошибки edit/delete логируются, но не роняют webhook-обработку.

---

## 8. Тесты

### 8.1. `renderScreen` (через `handleCallbackQuery` с моками max-api)

1. Source ID есть + edit успешен → вызван `editMessageWithKeyboard(chatId, sourceId, text, buttons)`; `sendMessageWithKeyboard` и `deleteMessage` не вызывались.
2. Source ID есть + edit падает → вызван `deleteMessage(sourceId)` и `sendMessageWithKeyboard`.
3. Source ID отсутствует + nav ID есть → вызван `editMessageWithKeyboard(chatId, navId, ...)`.
4. Source ID отсутствует + nav ID нет → `sendMessageWithKeyboard`.
5. Source edit упал → **nav ID не используется** (edit вызван ровно один раз, с sourceId; затем delete(sourceId), затем send).

### 8.2. Broadcast

6. При запуске (`broadcast_confirm_now`, неполный первый батч) сохраняется `status_message_id` именно статусного экрана.
7. При завершении (цепочка) редактируется именно сохранённый `status_message_id`.
8. `nav_msg` не используется для завершения broadcast (завершение без `status_message_id` → только summary, без edit-попыток).
9. Немедленное завершение на первом батче (`broadcast_confirm_now`): экран подтверждения правкой → финальный экран «завершена», отправляется summary, `status_message_id` **не сохраняется**.

### 8.3. Единичные

- `max-api.test.js`: `editMessageWithKeyboard` (PUT, query `chat_id`/`message_id`, payload с inline_keyboard) и `deleteMessage` (DELETE).
- `nav.test.js`: set/get roundtrip, ключ `nav_msg:{chatId}`, TTL.
- `broadcast.test.js`: `setStatusMessageId`/`getStatusMessageId`, очистка в `deleteBroadcast` и `resetBroadcastStats`.
- Существующие тесты `handler.test.js` проходят без изменений: в них `message: { recipient: { chat_id: 1 } }` без `message_id` и без `nav_msg` в KV → фолбэк `sendMessageWithKeyboard`.

---

## 9. Вне зоны изменений

- Команды в `handleMessage` (`/start`, `/setlink`, `/dellink`, `/links`, `/link`, `/users`, `/stats`, черновики) — новые сообщения.
- `link_preview`, диплинки, тестовые отправки, progress и summary рассылок — новые сообщения (кроме описанного в §6).
- `handleBotStarted` — без изменений.
- Storage-слой связок/пользователей/статистики — без изменений.

---

## 10. Проверка payload (Task 1) — ВЫПОЛНЕНА

Проверено на живом webhook (Amvera, 2026-08-13):

- `update.message.message_id` **отсутствует** в `message_callback`-обновлениях.
- Реальный идентификатор сообщения — `update.message.body.mid` (строка вида `mid.00000000167b21dd019ffa40a8604932`).
- Ответы MAX API (`POST /messages`) тоже содержат `message.body.mid`, а не `message_id` — нормализация через `extractMessageId` (§4.1) обязательна для сохранения `nav_msg`/progress-сообщений.
- `PUT /messages` и `DELETE /messages` принимают `message_id=<mid>` (проверено: PUT → `{"success":true}`, навигация переписывает одно и то же сообщение).
- Основной путь — `editMsgId = update.message.body.mid`; фолбэк `nav_msg:{chatId}` остаётся страховкой на случай отсутствия id.
