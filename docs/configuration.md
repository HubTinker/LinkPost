[← API Reference](api.md) · [Back to README](../README.md)

# Конфигурация

## Переменные окружения

| Переменная | Обязательная | Описание |
|------------|--------------|----------|
| `BOT_TOKEN` | ✅ | Токен бота из настроек MAX Partner Platform |
| `SETUP_SECRET` | ✅ | Секрет для эндпоинта `/setup-webhook` |
| `ADMIN_USER_IDS` | ✅ | ID администраторов через запятую (напр. `123,456`) |
| `BOT_NICK` | ❌ | Никнейм бота для deep-ссылок (по умолч. `YourBot`) |
| `LOG_LEVEL` | ❌ | Уровень логирования: `DEBUG`, `INFO`, `WARN`, `ERROR` (по умолч. `INFO`) |

## Vercel KV

Создаётся через Vercel CLI:

```bash
vercel kv create
```

Переменные `KV_URL`, `KV_REST_API_URL`, `KV_REST_API_TOKEN` автоматически добавляются в Vercel.

## Префиксы ключей в KV

| Префикс | Назначение |
|---------|------------|
| `link:` | Связки ключ-ссылка (`{ url, message, creator_id }`) |
| `links_all` | Set всех ключей связок |
| `link_subs:` | Set подписчиков на ключ |
| `user_links:` | Set ключей по создателю (индекс) |
| `user:` | Данные пользователей |
| `users_all` | Set всех ID пользователей |

## См. также

- [Начало работы](getting-started.md) — установка и запуск
- [API Reference](api.md) — эндпоинты бота
