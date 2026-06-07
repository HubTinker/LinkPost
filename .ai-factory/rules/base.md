# Правила проекта LinkPost Bot

> Автоматически обнаруженные соглашения из анализа кодовой базы. Отредактируйте при необходимости.

## Соглашения об именовании

- **Файлы:** kebab-case (`max-api.js`, `storage.js`, `webhook.js`)
- **Переменные:** camelCase (`chatId`, `userId`, `webhookUrl`)
- **Функции:** camelCase (`sendMessage`, `getLink`, `isAdmin`)
- **Константы:** UPPER_SNAKE_CASE (`BASE`, `LINK_PREFIX`, `USERS_SET`)
- **Импорты:** ES-модули с расширением `.js`

## Структура модулей

- `lib/max-api.js` — обёртка над MAX Bot REST API
- `lib/storage.js` — слой работы с Vercel KV
- `api/index.js` — точка входа с Hono-роутами

## Обработка ошибок

- try/catch в обработчиках webhook
- Возврат `200 OK` даже при ошибке (MAX не ретраит сообщения)
- Проверка входных данных с понятными сообщениями об ошибках
- HTTP-статусы для REST: 400 (invalid JSON), 403 (forbidden)

## Логирование

- `console.error` для ошибок
- Отсутствие внешних библиотек логирования

## Тестирование

- Тестовый фреймворк не обнаружен
