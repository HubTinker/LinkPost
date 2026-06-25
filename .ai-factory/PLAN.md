# План: Статистика — first_seen, created_at, счётчики по дням

**Created:** 2026-06-25
**Type:** feature

## Settings

| Параметр | Значение |
|----------|----------|
| Testing | yes |
| Logging | verbose |
| Docs | no |

## Research Context

**Тема:** Добавление аналитики новых пользователей в разрезе ключей и по дням.

**Что нужно:**
- `created_at` на связке — когда создана, возраст ключа
- `first_seen` на пользователе — когда впервые пришёл (хранить, не показывать списком)
- Счётчики по дням: `stats:new:<key>:<YYYY-MM-DD>` и `stats:new:total:<YYYY-MM-DD>`
- TTL 90 дней на все stats:* ключи
- Команда `/stats <key>` — всего, сегодня, вчера, за неделю, возраст ключа
- Кнопка «Статистика» в админ-меню

**Не делаем:**
- Сравнение ключей между собой (топ за неделю)
- first_seen НЕ показываем списком — только для расчёта «новых за период»

## Задачи

### 1. created_at в setLink

**Description:** Добавить `created_at: Date.now()` в объект, сохраняемый в `setLink`.

**Files:** `lib/storage.js`

**Changes:**
- `setLink(key, url, message, creatorId)`: в `kv.set` добавить поле `created_at: Date.now()`
- Обновить `log('DEBUG', ...)` — включить `created_at` в сообщение

**Logging:**
- `DEBUG: setLink: key=<k>, url=<u>, creator=<c>, created_at=<ts>`

### 2. first_seen в saveUser

**Description:** Записывать `first_seen` только при ПЕРВОМ сохранении пользователя. При первом появлении — инкрементить `stats:new:total:<today>`.

**Files:** `lib/storage.js`

**Changes:**
- Перед `kv.set` проверить `await kv.get(\`${USER_PREFIX}${user_id}\`)`
- Если записи нет → добавить `first_seen: Date.now()` в объект + INCR `stats:new:total:<YYYY-MM-DD>`
- Если запись есть → не трогать `first_seen` (сохраняется из существующей записи)
- Добавить хелпер `formatDate(d = new Date())` → `"YYYY-MM-DD"` (понадобится дальше)

**Логика saveUser после изменений:**
```
existing = await kv.get(user:<id>)
isNew = !existing
first_seen = isNew ? Date.now() : existing.first_seen
await kv.set(user:<id>, { ..., first_seen, updated_at: Date.now() })
if (isNew) await incrDailyTotal(formatDate())
if (subscribedKey) await addUserToLink(subscribedKey, user_id)
```

**Logging:**
- `DEBUG: saveUser: userId=<id>, isNew=<bool>, subscribedKey=<key>`

### 3. addUserToLink + ежедневные счётчики ключей

**Description:** `addUserToLink` возвращает результат `sadd`. Если пользователь НОВЫЙ для этого ключа — инкрементить `stats:new:<key>:<today>`. Добавить функции incr/get для stats-ключей с TTL 90 дней.

**Files:** `lib/storage.js`

**Changes в addUserToLink:**
- `const added = await kv.sadd(...)` → возвращать `added` (1 — новый, 0 — уже был)
- Если `added === 1` → `await incrDailyStat(key, formatDate())`

**Новые функции (все экспортируемые):**
```js
STATS_PREFIX = 'stats:new:'
STATS_TOTAL = 'stats:new:total'
STATS_TTL = 90 * 24 * 60 * 60  // 90 дней в секундах

async function incrDailyStat(key, date)    // INCR stats:new:<key>:<date> + EXPIRE
async function incrDailyTotal(date)        // INCR stats:new:total:<date> + EXPIRE
async function getDailyStat(key, date)     // GET → Number, default 0
async function getDailyTotal(date)         // GET → Number, default 0
async function getStatRange(key, from, to)  // [{date, count}, ...] за диапазон
async function getTotalRange(from, to)      // [{date, count}, ...] за диапазон
```

**TTL:** Каждый вызов INCR также вызывает `kv.expire(key, STATS_TTL)`. Это продлевает жизнь ключа на 90 дней от последней активности.

**Logging:**
- `DEBUG: incrDailyStat: key=<k>, date=<d>`

### 4. Функции чтения статистики

**Description:** Добавить `getLinkSubCount(key)` и `getLinkAge(key)` — простые обёртки для формирования ответа `/stats`.

**Files:** `lib/storage.js`

**Функции:**
```js
export async function getLinkSubCount(key)  // SCARD link_subs:<key>
export async function getLinkAge(key)       // days since link:<key>.created_at
```

**getLinkAge:**
- Читает `link:<key>`, извлекает `created_at`
- Если поля нет → возвращает `null`
- Иначе → `Math.floor((Date.now() - created_at) / 86400000)` (дней)

**Logging:**
- `DEBUG: getLinkAge: key=<k>, age=<n> days`

### 5. incr в kv-mock.js

**Description:** Добавить методы `incr` и `expire` в `lib/kv-mock.js` для поддержки тестов.

**Files:** `lib/kv-mock.js`

**Методы:**
```js
async incr(key) {
  const val = store.has(key) ? Number(store.get(key)) : 0
  const next = val + 1
  store.set(key, next)
  console.log('[KV-MOCK] incr', key, '\u2192', next)
  return next
},
async expire(key, seconds) {
  // no-op: мок не эмулирует истечение ключей
  console.log('[KV-MOCK] expire', key, seconds + 's')
}
```

**Logging:** стандартный `[KV-MOCK]` префикс.

### 6. Команда /stats для админа

**Description:** Добавить обработчик `/stats <key>` в `handleMessage`. Показывает полную статистику по ключу.

**Files:** `api/index.js`

**Импорты (добавить):**
```js
import { getLinkSubCount, getLinkAge, getDailyStat, getDailyTotal } from '../lib/storage.js'
```

**Логика:**
1. Проверить `isAdmin(userId)` → нет: DENY
2. Распарсить `[key]` из `parseArgs(text)`
3. Если нет ключа → `⚠️ Формат: /stats <ключ>`
4. `getLink(key)` → если нет: `❌ Ключ не найден`
5. Собрать данные:
   - `total = await getLinkSubCount(key)`
   - `today = await getDailyStat(key, formatDate())`
   - `yesterday = await getDailyStat(key, formatDate(d - 86400000))`
   - `week = sum(await getStatRange(key, weekAgo, today))`
   - `age = await getLinkAge(key)`
6. Формат ответа:
```
📊 Статистика ключа «<key>»

👥 Всего: <total>
📅 Сегодня: +<today>
📆 Вчера: +<yesterday>
📈 За неделю: +<week>
🕐 Возраст ключа: <age> дн.
🔗 <url>
```

**Logging:**
- `console.log('[API] /stats: key=%s, total=%d, today=%d, week=%d', key, total, today, week)`

### 7. Кнопка «Статистика» в админ-меню

**Description:** Добавить кнопку и callback-обработчик для показа общей статистики системы.

**Files:** `api/index.js`

**Изменения:**
- `showAdminMenu`: добавить кнопку `{ type: 'callback', text: '📊 Статистика', data: 'stats' }` в клавиатуру
- `handleCallbackQuery`: добавить обработчик `cb.payload === 'stats'`

**Общая статистика (без ключа):**
```
📊 Общая статистика

👥 Всего пользователей: <total_users>
📅 Новых сегодня: +<today_total>
📆 Новых вчера: +<yesterday_total>
📈 Новых за неделю: +<week_total>
🔑 Активных связок: <links_count>
```

Плюс кнопка `🔙 Назад`.

**Logging:**
- `console.log('[API] callback: stats → общая статистика')`

### 8. Unit-тесты

**Description:** Добавить тесты для всех новых функций хранилища и команды `/stats`.

**Files:** `test/storage.test.js` (расширение), `test/handler.test.js` (расширение)

**Тесты storage (новый describe-блок):**

1. **setLink сохраняет created_at**
2. **getLinkAge возвращает 0 для только что созданного ключа**
3. **getLinkAge возвращает null для ключа без created_at**
4. **saveUser устанавливает first_seen новому пользователю**
5. **saveUser НЕ перезаписывает first_seen существующему**
6. **saveUser инкрементит stats:new:total:<today> для нового**
7. **saveUser НЕ инкрементит total для существующего**
8. **addUserToLink возвращает 1 для нового подписчика**
9. **addUserToLink возвращает 0 для уже подписанного**
10. **addUserToLink инкрементит stats:new:<key>:<today> для нового**
11. **getDailyStat возвращает 0 для несуществующей даты**
12. **incrDailyStat + getDailyStat — круговая проверка**
13. **getStatRange возвращает корректный диапазон**
14. **getLinkSubCount возвращает размер set**

**Тесты API (новый describe-блок):**

1. **/stats для админа с существующим ключом — показывает статистику**
2. **/stats для не-админа — DENY**
3. **/stats без аргументов — подсказка формата**
4. **/stats с несуществующим ключом — «не найден»**
5. **callback 'stats' показывает общую статистику**

**Implementation notes:**
- Все тесты используют `kv._clear()` в `beforeEach`
- Для мока `Date.now()` использовать фиксированную дату (через `kv.set` напрямую для created_at/first_seen)
- `formatDate` импортировать из storage.js или вычислять локально

**Logging:** тесты логи не проверяют — только assert на значения.

## Commit Plan

3 коммита:

| # | Коммит | Задачи | Сообщение |
|---|--------|--------|-----------|
| 1 | Storage | 1–5 | `feat(storage): add created_at, first_seen, daily stats counters` |
| 2 | API | 6–7 | `feat(api): add /stats command and admin menu button` |
| 3 | Tests | 8 | `test: add unit tests for stats storage and /stats command` |

## Проверка

После выполнения всех задач:
1. `npm test` — все тесты (старые + новые) проходят без ошибок
2. `rg "getLinkAge\|getLinkSubCount\|incrDailyStat\|getDailyStat" --include "*.js"` — все функции используются
