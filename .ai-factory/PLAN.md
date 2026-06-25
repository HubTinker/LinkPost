# Миграция на platform-api2.max.ru

Дата: 2026-06-25
Режим: Fast

## Settings

| Параметр | Значение |
|----------|----------|
| Тестирование | Да |
| Логирование | Verbose (DEBUG) |
| Документация | Нет |

## Research Context

> Перенесено из `.ai-factory/RESEARCH.md` (Active Summary)

**Тема:** Миграция MAX API с platform-api.max.ru на platform-api2.max.ru до 19 июля 2026.

**Цель:** Заменить endpoint во всех API-вызовах, проверить TLS-совместимость в Vercel Edge Runtime, перерегистрировать webhook.

**Ограничения:**
- Сертификат Минцифры на новом домене — Vercel Edge Runtime может не доверять
- Двойная TLS-ренегоциация на platform-api2 — потенциальная несовместимость с Edge
- Старый API отключат 19 июля — жёсткий дедлайн

**Решения (из explore-фазы):**
- Единственная точка изменения — `lib/max-api.js:1` (константа BASE)
- Проверка TLS из Edge через временный эндпоинт `/check-migration`
- При неудаче — план Б: переход на Node.js Runtime с `NODE_EXTRA_CA_CERTS`

**Проблемы:**
- platform-api2.max.ru отвечает HTTP 401 (ОК), но с двойной TLS-ренегоциацией
- Локально через Windows Schannel работает, через Vercel Edge — неизвестно

---

## Tasks

### Фаза 1: Проверка совместимости

- [x] **Task 1.1** — Добавить тестовый эндпоинт `/check-migration`
  
  **Файл:** `api/index.js`
  
  **Что сделать:**
  - Добавить `GET /check-migration` с проверкой `SETUP_SECRET` (по аналогии с `/setup-webhook`)
  - Эндпоинт делает `fetch()` к `platform-api2.max.ru/me` и `platform-api.max.ru/me`
  - Возвращает JSON с результатами обоих запросов (статус, тело, ошибка)
  
  **Логирование:**
  - DEBUG: старт проверки каждого API, статус ответа
  - ERROR: если `fetch()` упал с исключением — сообщение ошибки полностью
  
  **Зависимости:** нет

- [ ] **Task 1.2** — Деплой на Vercel и ручная проверка
  
  **Команда:** `npm run deploy`
  
  **Что сделать:**
  - Задеплоить с тестовым эндпоинтом
  - Вызвать `GET https://<deploy-url>/check-migration?secret=<SETUP_SECRET>`
  - Оценить результат: принимает ли Edge сертификат Минцифры
  
  **Критерии успеха:**
  - `api2.ok === true && api2.status === 200` — Edge доверяет, переходим к Фазе 2
  - `api2.error` содержит `certificate` / `untrusted` / `renegotiation` — План Б
  
  **Зависимости:** Task 1.1

- [x] **Task 1.3** — Тест на TLS-совместимость из Edge
  
  **Файл:** `test/migration.test.js` (новый)
  
  **Что сделать:**
  - Юнит-тест: проверка, что `lib/max-api.js` использует корректный BASE
  - Интеграционный тест (опционально, если есть KV mock): вызов `registerWebhook()` через мокнутый fetch
  
  **Логирование:** не требуется (тесты)
  
  **Зависимости:** Task 1.1

### Фаза 2: Миграция

- [ ] **Task 2.1** — Заменить BASE в `lib/max-api.js`
  
  **Файл:** `lib/max-api.js`
  
  **Что сделать:**
  - Строка 1: `platform-api.max.ru` → `platform-api2.max.ru`
  - Проверить, что больше нигде в проекте нет жёстко зашитого старого домена (`grep` по коду)
  
  **Логирование:**
  - INFO: при старте — текущий BASE (уже есть в логах `[API] request`)
  
  **Зависимости:** Task 1.2 (только если Edge прошёл проверку)

- [ ] **Task 2.2** — Деплой и перерегистрация webhook
  
  **Команда:** `npm run deploy`
  
  **Что сделать:**
  - Задеплоить с новым BASE
  - Вызвать `GET /setup-webhook?secret=<SETUP_SECRET>` для перерегистрации webhook на новом API
  - Проверить в логах, что `registerWebhook` отработал без ошибок
  
  **Логирование:**
  - DEBUG: все вызовы `[API] request` должны идти к `platform-api2.max.ru`
  - ERROR: любой ответ не-200 от MAX API
  
  **Зависимости:** Task 2.1

- [ ] **Task 2.3** — Smoke-тест: бот работает
  
  **Что сделать:**
  - Отправить `/start` боту — проверить ответ
  - Отправить `/links` (если админ) — проверить ответ
  - Проверить логи Vercel: все `[API]`-запросы к `platform-api2.max.ru`
  
  **Зависимости:** Task 2.2

### Фаза 3: Зачистка

- [ ] **Task 3.1** — Удалить тестовый эндпоинт `/check-migration`
  
  **Файл:** `api/index.js`
  
  **Что сделать:**
  - Удалить временный маршрут `GET /check-migration`, добавленный в Task 1.1
  
  **Логирование:** не требуется
  
  **Зависимости:** Task 2.3

- [ ] **Task 3.2** — Финальная проверка и обновление референса
  
  **Файл:** `.ai-factory/references/max-bot-api.md`
  
  **Что сделать:**
  - `grep` по всему проекту — убедиться, что `platform-api.max.ru` не осталось (кроме референса)
  - Обновить `max-bot-api.md`: исправить упоминания старого домена на `platform-api2.max.ru`
  - Обновить `Updated:` в референсе
  
  **Зависимости:** Task 3.1

---

## План Б (если Edge не принимает сертификат)

Если Task 1.2 покажет TLS-ошибку из Edge Runtime:

1. Сменить рантайм в `vercel.json`: `"runtime": "nodejs20.x"` вместо `"edge"`
2. Добавить сертификат Минцифры через `NODE_EXTRA_CA_CERTS` (переменная окружения в Vercel)
3. Задеплоить и повторить Task 1.2

---

## Commit Plan

| Точка | После задач | Сообщение |
|--------|-------------|-----------|
| C1 | 1.1, 1.2, 1.3 | `feat: add /check-migration endpoint for platform-api2 TLS test` |
| C2 | 2.1 | `feat: migrate MAX API base URL to platform-api2.max.ru` |
| C3 | 2.2, 2.3 | `chore: re-register webhook on platform-api2, smoke test` |
| C4 | 3.1, 3.2 | `chore: remove migration test endpoint, update API reference` |
