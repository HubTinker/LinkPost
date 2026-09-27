# Спецификация: Редактирование текста связки по кнопке

Дата: 2026-09-27 · Статус: дизайн согласован, готов к плану реализации

## 1. Цель

Админ или создатель связки может исправить приветственное сообщение ключа, не пересоздавая связку: на карточке связки появляется кнопка «✏️», после нажатия бот ждёт новый текст и сохраняет его. Ключ (`key`), ссылка (`url`), создатель и дата создания не меняются; статистика и подписчики не затрагиваются.

Не входит в объём: редактирование URL, переименование ключа, Markdown-разметка (сообщения связок отправляются plain-текстом — `sendMessageWithLink` вызывается без `format`).

## 2. Ключевые решения

| Решение | Выбор |
|---|---|
| Объём правки | Только `message` связки |
| Способ запуска | Кнопка «✏️» на карточке связки (команда `/editlink` не вводится) |
| Хранение режима | KV-ключ `pending_edit:<userId>` + TTL 15 мин (stateless-окружение Vercel Edge / Amvera; in-memory отклонён) |
| После ввода текста | Сразу сохранить, без предпросмотра; показать карточку с `notice` «✅ Текст обновлён!» |
| Отмена | Кнопка «❌ Отмена» на экране приглашения |
| Лимит текста | 4096 символов (как в `/setlink`) |
| Права | `canManage` (админ или создатель), проверяется дважды: при нажатии и при сохранении (TOCTOU) |
| ACK callback | `POST /answers` на входе в `handleCallbackQuery` для **всех** кнопок (первый вызов ack в проекте) |

## 3. UX-поток

### 3.1 Карточка связки

`showLinkCard` — первый ряд кнопок:

```
[✏️] [🗑 Удалить] [👁 Посмотреть]
[🔙 Назад]
```

Payload: `edit_msg:<key>` — добавляется в `ALLOWED_NON_ADMIN_PREFIXES` (карточку видят создатели-не-админы).

### 3.2 Экран приглашения

По нажатию (после проверок, см. 5.2) KV-флаг + `renderScreen`:

```
✏️ Редактирование текста «vip»

Пришлите новый текст сообщения.
Ограничение: 4096 символов.
Ссылка и ключ не изменятся.

[❌ Отмена]        ← edit_cancel:<key>
```

Про `Markdown` на экране не упоминается — сообщения связок plain-текстовые.

### 3.3 Перехват ввода (`handleMessage`)

Новый порядок:

```
text вычислен
→ pending = getPendingEdit(userId)        // сбой KV → null + WARN (best-effort чтение)
→ if (!text): pending ? «⚠️ Жду текстовое сообщение. Отправьте текст или нажмите «❌ Отмена».» : return
→ saveUser / reactivate / track (без изменений)
→ if (pending && !text.startsWith('/')): сценарий сохранения (3.4), return
→ if (pending && text.startsWith('/')): clearPendingEdit + «⚠️ Режим редактирования сброшен.», далее обычный роутинг
→ существующий код: /start, фильтр не-админов, /setlink, черновик рассылки ...
```

Правила:

- Перехват **до** старого early return `if (!text) return` — иначе медиа-сообщения в режиме молчат (п. 3.5).
- Перехват **до** `/start` и **до** фильтра не-админов — иначе не-админ-создатель не может редактировать (его текст гасится на текущей строке 661 `if (!isAdmin(userId)) return`).
- Текст, начинающийся с `/`, через этот флоу не записать — обходной путь `/setlink` (зафиксированное ограничение).

### 3.4 Сценарий сохранения (повторная TOCTOU-проверка)

1. `getLink(pending.key)` → `null` → `clearPendingEdit` + `❌ Ключ "..." не найден.`;
2. `canManage(userId, link)` не прошёл → `clearPendingEdit` + `⛔ ...`;
3. `updateLinkMessage(key, text.slice(0, 4096))` → `false` → `clearPendingEdit` + `❌ ...`;
4. успех → `clearPendingEdit` → `showLinkCard(chatId, userId, key, null, false, '✅ Текст обновлён!')`.

Карточка идёт **новым сообщением** (`useNavFallback: false`): у приглашения и карточки разные наборы кнопок, edit на месте сломал бы UI.

### 3.5 Не-текстовые сообщения

Сообщение без текста (медиа, стикер) при активном режиме → `⚠️ Жду текстовое сообщение. Отправьте текст или нажмите «❌ Отмена».`, режим остаётся. Без активного режима — прежнее молчаливое `return`.

### 3.6 Отмена

`edit_cancel:<key>` → `clearPendingEdit` → `showLinkCard(..., editMsgId)` (правка приглашения на месте).

## 4. Модель данных — `lib/storage.js`

### 4.1 Флаг ожидания

```js
const PENDING_EDIT_PREFIX = 'pending_edit:'
const PENDING_EDIT_TTL = 15 * 60   // сек, фиксированный — не продлевается при чтении

setPendingEdit(userId, key, chatId)  // { key, chat_id, set_at } + kv.expire (паттерн nav.js)
getPendingEdit(userId)               // → объект | null (протухший ключ вернёт null)
clearPendingEdit(userId)             // kv.del
```

Сбой KV при `setPendingEdit`/`clearPendingEdit` **не** глотается best-effort-паттерном: без флага режим не работает, вызывающий показывает `❌ Не удалось начать редактирование, попробуйте ещё раз.`

### 4.2 Точечная правка

```js
updateLinkMessage(key, message) → boolean
```

- чтение: сначала `key.toLowerCase()`, затем исходный регистр (как `getLink` — поддержка legacy-ключей);
- запись `{ ...existing, message }` в **тот же** ключ, под которым нашла;
- `url`, `creator_id`, `created_at` не трогаются; `link_subs:`, `stats:` не затрагиваются;
- `null` → `false`, успех → `true`.

### 4.3 Известные ограничения (зафиксированы)

- Двойное нажатие «✏️» с двух устройств: последний клик перезаписывает флаг (edge case, приемлемо).
- Лимит MAX: не более 2 ack (`/answers`) в секунду на диалог — при превышении только лог, обработка не блокируется.

## 5. Изменения в коде

### 5.1 `lib/max-api.js`

```js
export async function answerCallback (callbackId) {
  if (!callbackId) return
  return request('POST', `/answers?callback_id=${encodeURIComponent(callbackId)}`, {})
}
```

Имя поля подтверждено документацией MAX: `updates[i].callback.callback_id` → в коде `cb.callback_id`.

### 5.2 `api/index.js` — `handleCallbackQuery`

1. Сразу после извлечения `userId/chatId`, **до** проверки прав: `answerCallback(cb.callback_id)` fire-and-forget (`.catch` + `alog('WARN')`) — спиннер гаснет и для кнопок, отброшенных проверкой прав.
2. Сразу после ack: если payload не `edit_msg:`/`edit_cancel:` → `clearPendingEdit(userId)` (ошибки глотаем). Правило «любая кнопка выводит из режима» — централизованно, не в каждом обработчике.
3. Новые обработчики:
   - **`edit_msg:<key>`**: `getLink` + `canManage` (тексты ошибок как в `del:`), снятие `_awaiting_limit` у рассылок этого юзера (`getAwaitingLimitBroadcast` → `updateBroadcast(..., { _awaiting_limit: false })`), `setPendingEdit` в try/catch, `renderScreen` с приглашением.
   - **`edit_cancel:<key>`**: `clearPendingEdit` → карточка.

### 5.3 `api/index.js` — `showLinkCard`

В первый ряд: `{ type: 'callback', text: '✏️', data: 'edit_msg:<key>' }`. Новый необязательный параметр `notice` — префиксует текст карточки (`notice + '\n\n' + text`), чтобы подтверждение и карточка не шли двумя сообщениями. Существующие вызовы без `notice` не меняются.

### 5.4 Взаимоисключение состояний

| Событие | Действие |
|---|---|
| Любой callback, кроме `edit_msg:`/`edit_cancel:` | снимает `pending_edit` |
| `edit_msg:` | ставит `pending_edit`, снимает `_awaiting_limit` |
| `edit_cancel:` | снимает `pending_edit`, возвращает карточку |
| Команда `/...` в режиме | снимает `pending_edit`, уведомление, команда роутится дальше |

Обратное направление: `broadcast_custom:` уже снимает `_awaiting_limit` у других рассылок, а правило «любой callback снимает `pending_edit`» закрывает коллизию с черновиком рассылки. Порядок перехватов в `handleMessage` (pending до черновика) — защита в глубину.

## 6. Тесты

`npm test` = `node --test test/*.test.js`; паттерны существующих тестов: `kv._clear()`, мок `global.fetch`, прямые вызовы хендлеров.

### 6.1 Дополнение `test/storage.test.js`

- `updateLinkMessage`: меняет только `message`; `url`/`creator_id`/`created_at` нетронуты; `false` для несуществующего ключа; legacy-ключ в исходном регистре находится и правится.
- `setPendingEdit → getPendingEdit → clearPendingEdit`: roundtrip, структура `{ key, chat_id, set_at }`, `null` после clear.

### 6.2 Новый `test/edit-link.test.js`

Фикстура callback-апдейта: `{ callback: { payload, callback_id, user: { user_id } }, message: { recipient: { chat_id }, body: { mid } } }`.

1. `edit_msg:<key>` → флаг установлен, экран приглашения с `❌ Отмена`, в fetch-вызовах `POST .../answers?callback_id=...` (ack).
2. Текст при активном флаге → `link.message` обновлён, флаг снят, карточка с `✅ Текст обновлён!`.
3. `/links` при активном флаге → флаг снят + `⚠️ Режим редактирования сброшен.` + команда отработала.
4. Сообщение без текста при активном флаге → `⚠️ Жду текстовое сообщение...`, флаг остался.
5. `edit_cancel:<key>` → флаг снят, карточка.
6. Не-админ-создатель: `edit_msg` проходит; не-создатель → `⛔` без установки флага.
7. Ключ удалён между нажатием и вводом → `❌` + флаг снят.
8. Чужой callback (например `links`) при активном флаге → флаг снят.
9. Текст >4096 → обрезается до 4096.
10. Сбой KV при `setPendingEdit` (подмена метода kv) → `❌ Не удалось начать редактирование...`.

Race condition двойного нажатия тестом не покрывается — зафиксирован как known limitation (§4.3).

## 7. Документация

- `docs/api.md`: строки `edit_msg:<key>` / `edit_cancel:<key>` в таблице callback-payload'ов; описание ack (`POST /answers`); абзац про режим ожидания в разделе «Связки» (п. про карточку).
- `README.md:34`: «карточка связки с кнопками „Редактировать“, „Удалить“, „Посмотреть“».
