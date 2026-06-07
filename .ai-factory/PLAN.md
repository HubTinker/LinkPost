# План: cleanup — исправление проблем, найденных в аудите

**Branch:** нет (git disabled)
**Created:** 2026-06-07
**Type:** fix / refactor

## Settings

| Параметр | Значение |
|----------|----------|
| Testing | yes |
| Logging | verbose |
| Docs | no |

## Research Context

Проверка реализации всех запланированных функций LinkPost. Все 6 функций из DESCRIPTION.md реализованы полностью. Основные проблемы: отсутствует kv-mock.js (краш при локальном запуске), 6 остаточных [FIX] логов, нет тестов на бизнес-логику. Подробнее — `.ai-factory/RESEARCH.md`.

## Задачи

### ~~Задача 1: Создать lib/kv-mock.js~~ ✅

**Description:** Реализовать in-memory заглушку для Vercel KV, чтобы бот работал локально без подключения к Redis.

**Files:** `lib/kv-mock.js` (новый)

**Interface — методы:**
- `get(key)` — возвращает значение или `null`
- `set(key, value)` — сохраняет в Map
- `del(key)` — удаляет ключ
- `keys(pattern)` — возвращает ключи по glob-паттерну (`link:*`)
- `sadd(set, member)` — добавляет элемент в Set
- `smembers(set)` — возвращает все элементы Set
- `scard(set)` — возвращает размер Set

**Implementation notes:**
- Хранить данные в `Map` и отдельном `Map` для sets
- `keys(pattern)` поддерживает только `*` на конце (как в коде `link:*`)
- Экспортировать как `{ kv }` — совместимо с интерфейсом `@vercel/kv`
- Добавить логи через `console.log` с префиксом `[KV-MOCK]` для visibility

**Logging:**
- `console.log('[KV-MOCK] set', key)` — при создании/обновлении
- `console.log('[KV-MOCK] get', key, '→', result ? 'found' : 'miss')` — при чтении
- `console.log('[KV-MOCK] keys', pattern, '→', count)` — при поиске

**Definition of done:**
- Файл создан
- `node -e "import('./lib/kv-mock.js')"` не выдаёт ошибок

### ~~Задача 2: Удалить [FIX] префиксы из production-логов~~ ✅

**Description:** Все `console.*` c `[FIX]` заменить на нормальные сообщения. Это остатки отладки после фикса undefined chat_id.

**Files:**
- `api/index.js:95`
- `lib/max-api.js:11,20,24,30,41`

**Changes:**

| File | Line | Old | New |
|------|------|-----|-----|
| `api/index.js` | 95 | `console.warn('[FIX] handleMessage: chat_id отсутствует, пропускаем')` | `console.warn('handleMessage: chat_id отсутствует, пропускаем')` |
| `lib/max-api.js` | 11 | `console.log('[FIX] API request', ...)` | `console.log('[API] request', method, path, JSON.stringify(body))` |
| `lib/max-api.js` | 20 | `console.error('[FIX] API error', ...)` | `console.error('[API] error', res.status, err)` |
| `lib/max-api.js` | 24 | `console.log('[FIX] API success', path)` | `console.log('[API] success', path)` |
| `lib/max-api.js` | 30 | `console.error('[FIX] sendMessage: chatId is required')` | `console.error('[API] sendMessage: chatId is required')` |
| `lib/max-api.js` | 41 | `console.error('[FIX] sendMessageWithLink: chatId is required')` | `console.error('[API] sendMessageWithLink: chatId is required')` |

**Definition of done:**
- В коде не осталось ни одного `[FIX]` (кроме `.ai-factory/patches/` — это архив)
- `rg "\[FIX\]" --include "*.js"` не находит совпадений

### ~~Задача 3: Добавить тесты на бизнес-логику~~ ✅

**Dependency:** Задача 1 (kv-mock.js нужен для импорта storage.js в тестах)

**Files:** `test/handler.test.js` (расширение)

**Test cases:**

1. **handleBotStarted без payload (админ)**
   - `user.user_id = 123` (из ADMIN_USER_IDS)
   - Должна вернуться панель с командами

2. **handleBotStarted без payload (не админ)**
   - `user.user_id = 999`
   - Должно прийти приветствие для обычного пользователя

3. **handleMessage с /setlink (админ)**
   - text = `/setlink test https://example.com Hello!`
   - Должен вызвать `setLink` с правильными аргументами

4. **handleMessage с /setlink (не админ)**
   - `user.user_id = 999`
   - Должен получить отказ (DENY)

5. **handleMessage с /dellink (админ, существующий ключ)**
   - text = `/dellink test`
   - Должен удалить ключ

6. **handleMessage с /dellink (админ, несуществующий ключ)**
   - text = `/dellink nonexistent`
   - Должен сообщить, что ключ не найден

7. **handleMessage с /links (админ)**
   - Должен вернуть список связок

8. **handleMessage с /users (админ)**
   - Должен вернуть количество пользователей

9. **handleMessage с вводом ключа (существующий)**
   - text = существующий ключ
   - Должен вызвать `sendMessageWithLink`

10. **handleMessage с вводом ключа (несуществующий)**
    - text = несуществующий ключ
    - Должен вернуть "Ключ не найден"

**Implementation notes:**
- Перед каждым тестом сбрасывать mock-хранилище в чистое состояние
- Использовать `beforeEach` для очистки
- Проверять через assert вызовы `sendMessage`/`sendMessageWithLink` (через mock fetch)

**Definition of done:**
- `npm test` проходит все тесты (старые + новые)
- Покрыты ключевые сценарии: админ/не админ, команды, ввод ключа, диплинк

## Commit Plan

Менее 5 задач — единый коммит после выполнения всех задач.

**Предлагаемый message:** `fix: add kv-mock.js, cleanup [FIX] logs, expand test coverage`

## Проверка

После выполнения всех задач:
1. `npm test` — без ошибок
2. `rg "\[FIX\]" --include "*.js"` — пусто
3. `node -e "import('./lib/storage.js')"` — без ошибок (kv-mock.js подхватывается)
