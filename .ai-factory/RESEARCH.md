# Research

Updated: 2026-06-07 18:10
Status: active

## Active Summary (input for /aif-plan)
<!-- aif:active-summary:start -->
Topic: Добавление владельца (creator) к связкам ключ-ссылка
Goal: Сохранять creator_id при создании ключа, фильтровать ключи по создателю, подготовить базу к multi-user сценарию
Constraints:
  - Не потерять существующих подписанных пользователей (users_all, user:*)
  - Бекап всей KV-базы перед миграцией
Decisions:
  - creator_id добавляется в value link:<key> → { url, message, creator_id }
  - setLink(key, url, msg, creatorId) — новый параметр
  - getLinksByCreator(userId) — новый метод
  - Индекс user_links:<userId> (set) создаётся сразу при setLink
  - Миграция: ключи без creator_id → назначить первому админу из ADMIN_IDS
  - Права: админы видят/удаляют всё, создатели — только свои ключи
  - Роли в будущем уйдут в KV (не только ADMIN_IDS env), но в рамках этой задачи isAdmin() остаётся
  - /links для админов: все ключи (с пометкой создателя); для пользователей: только user_links:<userId>
  - /dellink: админ может удалить любой; пользователь — только свой (проверка creator_id)
Open questions:
  - Формат бекапа: прямой дамп всех ключей через @vercel/kv или сторонний инструмент?
  - Нужна ли обратная совместимость getLink() (без фильтра по creator — для deep-link резолвинга)?
Success signals:
  - Бекап базы сохранён перед миграцией
  - setLink принимает и сохраняет creator_id
  - Миграция существующих ключей без потерь
  - /links показывает админу все ключи с creator, пользователю — только свои
  - Индекс user_links:<userId> наполняется корректно
Next step: /aif-plan fast для реализации изменений в lib/storage.js и api/index.js
<!-- aif:active-summary:end -->

## Sessions
<!-- aif:sessions:start -->

### 2026-06-07 18:10 — Аудит реализации LinkPost
What changed:
  - Проанализированы: api/index.js, lib/storage.js, lib/max-api.js, server.js, poll.js, test/*.test.js
  - Сверены 6 функций из DESCRIPTION.md с кодом — все реализованы
  - Найдены проблемы: отсутствует kv-mock.js (краш при локальном запуске), 6 остаточных [FIX] логов, нет тестов на бизнес-логику
Key notes:
  - kv-mock.js импортируется в lib/storage.js:2 но не существует в проекте
  - [FIX] логи разбросаны по api/index.js и lib/max-api.js (всего 6 штук)
  - Тесты handler.test.js и max-api.test.js проверяют только защиту от undefined chatId
  - getAllLinks() через KV.keys() — потенциально хрупко на больших объёмах
  - .env.local содержит реальный BOT_TOKEN (git не инициализирован — пока безопасно)
Links (paths):
  - api/index.js
  - lib/storage.js
  - lib/max-api.js
  - test/handler.test.js
  - test/max-api.test.js
  - .ai-factory/patches/2026-06-07-17.40.md
<!-- aif:sessions:end -->
