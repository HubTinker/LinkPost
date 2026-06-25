# Link Creator Ownership

Branch: N/A (`git.create_branches: false`)
Created: 2026-06-25

## Settings

- **Testing:** yes
- **Logging:** verbose (DEBUG)
- **Docs:** yes (mandatory checkpoint)

## Research Context

> Из `.ai-factory/RESEARCH.md`

**Topic:** Добавление владельца (creator) к связкам ключ-ссылка
**Goal:** Сохранять `creator_id` при создании ключа, фильтровать ключи по создателю, подготовить базу к multi-user сценарию
**Constraints:**
- Не потерять существующих подписанных пользователей (`users_all`, `user:*`)
- Бекап всей KV-базы перед миграцией
**Decisions:**
- `creator_id` добавляется в value `link:<key>` → `{ url, message, creator_id }`
- `setLink(key, url, msg, creatorId)` — новый параметр
- `getLinksByCreator(userId)` — новый метод
- Индекс `user_links:<userId>` (set) создаётся сразу при `setLink`
- Миграция: ключи без `creator_id` → назначить первому админу из `ADMIN_IDS`
- Права: админы видят/удаляют всё, создатели — только свои ключи
- `/links` для админов: все ключи (с пометкой создателя); для пользователей: только `user_links:<userId>`
- `/dellink`: админ может удалить любой; пользователь — только свой (проверка `creator_id`)

---

## Tasks

### Phase 1: Безопасность и слой хранения

- [x] **Task 1 — Скрипт бекапа KV-базы**

  Файл: `scripts/backup-kv.js` (новый)

  **Что делает:**
  - Загружает `.env.local` через `dotenv`
  - Подключается к `@vercel/kv`
  - Дампит все 5 типов ключей: `links_all`, `link:<key>`, `link_subs:<key>`, `users_all`, `user:<id>`
  - Сохраняет в `backup-YYYY-MM-DD-HHmmss.json` в корне проекта
  - Выводит суммарную статистику (сколько ключей каждого типа)

  **Логирование (DEBUG):**
  - `[backup] Starting KV dump...`
  - `[backup] Links: N, Users: M, Subs: K`
  - `[backup] Saved to <filename>`

  **Зависимости:** нет

- [x] **Task 2 — `setLink` с `creator_id` и индексом**

  Файл: `lib/storage.js`

  **Что изменить:**
  - Добавить константу `USER_LINKS_PREFIX = 'user_links:'`
  - `setLink(key, url, message, creatorId)` — добавить параметр `creatorId`
  - Сохранять `{ url, message, creator_id: creatorId }` (вместо `{ url, message }`)
  - После `kv.set` добавлять ключ в `kv.sadd('user_links:<creatorId>', key)` если `creatorId != null`

  **Логирование (DEBUG):**
  - `[storage] setLink: key=<key>, creator=<creatorId>`
  - `[storage] setLink: added to user_links:<creatorId>`

  **Зависимости:** Task 1 (бекап)

- [x] **Task 3 — `getLinksByCreator` и обновление `delLink`**

  Файл: `lib/storage.js`

  **Что добавить:**
  - `getLinksByCreator(userId)` — получает ключи из `user_links:<userId>`, достаёт значения и возвращает `[{ key, url, message, creator_id }, ...]`
  - Обновить `delLink(key)` — перед удалением прочитать `link:<key>`, если есть `creator_id`, удалить ключ из `user_links:<creatorId>` через `kv.srem`

  **Логирование (DEBUG):**
  - `[storage] getLinksByCreator: userId=<id>, found=N keys`
  - `[storage] delLink: key=<key>, removed from user_links:<creatorId>`

  **Зависимости:** Task 2

### Phase 2: Миграция данных

- [x] **Task 4 — Скрипт миграции существующих ключей**

  Файл: `scripts/migrate-creators.js` (новый)

  **Алгоритм:**
  1. Загрузить `.env.local`
  2. Прочитать `ADMIN_IDS`, взять первый элемент как `fallbackOwner`
  3. Пройти по всем ключам из `links_all`
  4. Для каждого `link:<key>` без `creator_id` — записать `creator_id: fallbackOwner`
  5. Добавить ключ в `user_links:<fallbackOwner>`
  6. Вывести отчёт: сколько ключей мигрировано, сколько пропущено (уже имели `creator_id`)

  **Логирование (DEBUG):**
  - `[migrate] fallback owner: <id>`
  - `[migrate] migrating link:<key> → creator_id=<id>`
  - `[migrate] Done: migrated=M, skipped=N`

  **Зависимости:** Task 3 (нужна функция `setLink` с создателем, но миграция работает напрямую с `@vercel/kv`, а не через storage.js, чтобы не зависеть от сигнатуры `setLink`)

### Phase 3: Слой API

- [x] **Task 5 — `/setlink` передаёт `userId`**

  Файл: `api/index.js`

  **Что изменить:**
  - Строка `await setLink(key, url, msg)` → `await setLink(key, url, msg, userId)`
  - В ответном сообщении добавить информацию о создателе (только для админов)

  **Логирование (DEBUG):**
  - `[API] /setlink: key=<key>, creator=<userId>`
  - `[API] /setlink: saved successfully`

  **Зависимости:** Task 2

- [x] **Task 6 — `/links` с фильтрацией по создателю**

  Файл: `api/index.js`

  **Что изменить:**
  - Убрать `isAdmin` проверку для `/links` (команда доступна всем)
  - Админы → `getAllLinks()` (все ключи)
  - Пользователи → `getLinksByCreator(userId)` (только свои)
  - `formatLinksList` — для админов добавить строку `👤 Создатель: ID=<creator_id>` (когда `creator_id` присутствует)

  **Логирование (DEBUG):**
  - `[API] /links: userId=<id>, isAdmin=<bool>, found=N links`

  **Зависимости:** Task 3, Task 5

- [x] **Task 7 — `/dellink` с проверкой владельца**

  Файл: `api/index.js`

  **Что изменить в `/dellink`:**
  - После проверки `existing = await getLink(key)` добавить:
    - Если `!isAdmin(userId)` и `existing.creator_id !== userId` → отказ `⛔ Вы можете удалять только свои ключи.`

  **Что изменить в `handleCallbackQuery`:**
  - `del:` callback — та же проверка владельца перед показом подтверждения
  - `confirm_del:` callback — та же проверка владельца перед удалением
  - Для не-админов callback-кнопки всё ещё недоступны (проверка `isAdmin` в начале `handleCallbackQuery`), но проверка владельца добавляется на будущее

  **Логирование (DEBUG):**
  - `[API] /dellink: key=<key>, userId=<id>, creator=<creatorId>, allowed=<bool>`
  - `[API] confirm_del: key=<key>, deleted by=<userId>`

  **Зависимости:** Task 3, Task 6

### Phase 4: Тесты

- [x] **Task 8 — Тесты `storage.js`**

  Файл: `test/storage.test.js`

  **Что добавить:**
  - `setLink` с `creator_id` — проверка, что `creator_id` сохранён в `link:<key>` и ключ добавлен в `user_links:<creatorId>`
  - `setLink` без `creator_id` (null/undefined) — проверка, что индекс не создаётся
  - `getLinksByCreator` — возвращает ключи только указанного создателя
  - `getLinksByCreator` для пользователя без ключей — возвращает `[]`
  - `delLink` — проверка, что ключ удаляется из `user_links:<creatorId>`

  **Логирование:** не требуется (тесты)

  **Зависимости:** Task 3

- [x] **Task 9 — Тесты `api/index.js`**

  Файл: `test/handler.test.js`

  **Что обновить:**
  - `/setlink` тесты — проверить, что `creator_id` сохраняется в KV
  - `/links` для админа — видит все ключи (обновить существующий тест)
  - `/links` для НЕ-админа — видит только свои ключи (новый тест)
  - `/dellink` — не-админ НЕ может удалить чужой ключ (новый тест)
  - `/dellink` — не-админ МОЖЕТ удалить свой ключ (новый тест)

  **Логирование:** не требуется (тесты)

  **Зависимости:** Task 7, Task 8

### Phase 5: Документация

- [x] **Task 10 — Обновить `docs/`**

  Файлы: `docs/api.md`, `docs/architecture.md`

  **Что обновить:**
  - `docs/api.md` — описать новое поведение `/setlink`, `/links`, `/dellink` (фильтрация по создателю, права)
  - `docs/architecture.md` — добавить `user_links:<userId>` индекс в описание структуры KV

  **Зависимости:** Task 9

---

## Commit Plan

| # | Коммит | Задачи | Сообщение |
|---|--------|--------|-----------|
| 1 | Backup + Storage | Task 1, 2, 3 | `feat(storage): add creator_id to links with backup script` |
| 2 | Migration | Task 4 | `chore: migrate existing links with fallback creator` |
| 3 | API layer | Task 5, 6, 7 | `feat(api): filter links by creator, enforce ownership on delete` |
| 4 | Tests | Task 8, 9 | `test: add tests for link creator ownership` |
| 5 | Docs | Task 10 | `docs: update API and architecture for creator ownership` |
