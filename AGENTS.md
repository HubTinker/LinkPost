# AGENTS.md

> Этот файл — структурная карта проекта для AI-агентов. Обновляйте при значительных изменениях структуры.

## Обзор проекта

LinkPost — бот для мессенджера MAX на Hono.js. Прод-окружение — Node.js на Amvera, код совместим с Vercel Edge. Позволяет администраторам создавать связки «ключ → ссылка на канал» и делиться ими через deep-ссылки.

## Технологический стек

- **Язык программирования:** JavaScript (ES Modules)
- **Фреймворк:** Hono.js (@hono/node-server)
- **База данных:** Vercel KV (Redis)
- **Мессенджер API:** MAX Bot API
- **Развёртывание:** Amvera (git-деплой), опционально Vercel Edge

## Структура проекта

```
./
├── api/
│   └── index.js              # Точка входа: Hono-роуты (webhook, setup-webhook)
├── lib/
│   ├── max-api.js            # Обёртка над MAX Bot REST API
│   ├── storage.js            # Слой Vercel KV (ключи, пользователи)
│   ├── broadcast.js          # Рассылки по пользователям
│   ├── nav.js                # Кнопки навигации в сообщениях
│   └── kv-mock.js            # In-memory-реализация KV для локальной разработки
├── scripts/
│   ├── dev-server.js         # Локальный dev-сервер (npm run dev)
│   ├── amvera-server.js      # Production-сервер для Amvera
│   ├── setup-webhook.js      # Регистрация webhook
│   ├── backup-kv.js          # Бэкап данных KV
│   ├── migrate-creators.js   # Миграция данных
│   └── deploy-amvera.sh      # Деплой на Amvera
├── test/                     # Юнит-тесты (node --test)
├── docs/                     # Пользовательская документация
├── vercel.json               # Конфиг Vercel (опциональный деплой)
├── amvera.yaml               # Конфиг Amvera
├── package.json
└── README.md
```

## Ключевые точки входа

| Файл | Назначение |
|------|------------|
| `api/index.js` | Hono-роуты: webhook, setup-webhook |
| `lib/max-api.js` | MAX Bot API — отправка сообщений, регистрация webhook |
| `lib/storage.js` | Vercel KV — связки ключ-ссылка, пользователи |
| `scripts/dev-server.js` | Локальный запуск (`npm run dev`) |
| `scripts/amvera-server.js` | Production-сервер для Amvera |

## Документация

| Документ | Путь | Описание |
|----------|------|----------|
| README | README.md | Лендинг проекта |
| Начало работы | `docs/getting-started.md` | Установка, настройка, первый запуск |
| Архитектура | `docs/architecture.md` | Структура проекта и паттерны |
| API Reference | `docs/api.md` | Эндпоинты webhook и setup-webhook |
| Конфигурация | `docs/configuration.md` | Переменные окружения |

## Правила для агентов

- Разделяйте составные shell-команды на отдельные шаги с проверкой каждого
  - Неправильно: `git checkout main && git pull`
  - Правильно: Сначала `git checkout main`, затем `git pull origin main`