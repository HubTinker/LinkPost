[← Начало работы](getting-started.md) · [Back to README](../README.md) · [API Reference →](api.md)

# Архитектура

## Обзор

LinkPost использует Layered Architecture (слоистую архитектуру). Это простое горизонтальное разделение на три слоя: представление (Hono-роуты), интеграция (MAX API) и данные (Vercel KV).

## Структура

```
lib/
├── max-api.js        # Слой интеграции — обёртка над MAX Bot REST API
├── storage.js        # Слой данных — работа с Vercel KV
└── kv-mock.js        # Мок KV для локальной разработки

api/
└── index.js          # Слой представления — Hono-роуты и обработчики

scripts/
├── backup-kv.js      # Бекап всей KV-базы в JSON
├── migrate-creators.js # Миграция: назначение creator_id старым связкам
├── dev-server.js     # Локальный dev-сервер
└── setup-webhook.js  # Ручная регистрация webhook
```

## Структура KV

```
link:<key>       → { url, message, creator_id }   # Связка ключ-ссылка
links_all        → Set<key>                       # Все ключи связок
user_links:<id>  → Set<key>                       # Индекс: ключи по создателю
link_subs:<key>  → Set<user_id>                   # Подписчики на ключ
user:<id>        → { user_id, name, ... }         # Профиль пользователя
users_all        → Set<user_id>                   # Все пользователи
```

Индекс `user_links:<userId>` заполняется при создании связки и очищается при удалении.

## Поток данных

```
MAX (событие) → /webhook (Hono) → обработчик → storage/Max API → ответ
```

1. MAX отправляет POST на `/webhook` с JSON-событием
2. Hono-роут парсит JSON и вызывает соответствующий обработчик
3. Обработчик использует `storage.js` для работы с KV и `max-api.js` для ответа
4. Ответ всегда `200 OK` (даже при ошибке — MAX не ретраит)

## Ключевые паттерны

- **Тонкая обёртка API** — `max-api.js` использует `fetch`, не требует SDK
- **Прямые вызовы** — без DI-контейнера, модули импортируются напрямую
- **ES Modules** — `import`/`export` во всех файлах

## См. также

- [API Reference](api.md) — описание эндпоинтов
- [Конфигурация](configuration.md) — переменные окружения
