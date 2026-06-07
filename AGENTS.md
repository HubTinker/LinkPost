# AGENTS.md

> Этот файл — структурная карта проекта для AI-агентов. Автоматически сгенерирован `/aif`. Обновляйте при значительных изменениях структуры.

## Обзор проекта

LinkPost — бот для мессенджера MAX на Hono.js, развёрнутый на Vercel Edge. Позволяет администраторам создавать связки «ключ → ссылка на канал» и делиться ими через deep-ссылки.

## Технологический стек

- **Язык программирования:** JavaScript (ES Modules)
- **Фреймворк:** Hono.js
- **База данных:** Vercel KV (Redis)
- **Мессенджер API:** MAX Bot API
- **Развёртывание:** Vercel Edge Runtime

## Структура проекта

```
./
├── .ai-factory/              # Конфигурация AI Factory
│   ├── DESCRIPTION.md        # Спецификация проекта
│   ├── ARCHITECTURE.md       # Архитектурные решения
│   ├── config.yaml           # Настройки AI Factory
│   ├── rules/
│   │   └── base.md           # Базовые правила проекта
│   └── references/           # Справочные материалы
│       ├── INDEX.md          # Указатель референсов
│       └── max-bot-api.md    # MAX Bot API документация
├── .opencode/                # Конфигурация OpenCode
│   └── skills/               # AI Factory навыки
├── .agents/skills/           # Внешние навыки (skills.sh)
│   ├── hono/                 # Hono.js API reference
│   └── upstash-redis-kv/     # Upstash Redis/KV
├── lib/
│   ├── max-api.js            # Обёртка над MAX Bot REST API
│   └── storage.js            # Слой Vercel KV (ключи, пользователи)
├── api/
│   └── index.js              # Точка входа с Hono-роутами
└── opencode.json             # MCP конфигурация
```

## Ключевые точки входа

| Файл | Назначение |
|------|------------|
| `api/index.js` | Hono-роуты: webhook, setup-webhook |
| `lib/max-api.js` | MAX Bot API — отправка сообщений, регистрация webhook |
| `lib/storage.js` | Vercel KV — связки ключ-ссылка, пользователи |

## Документация

| Документ | Путь | Описание |
|----------|------|----------|
| README | README.md | Лендинг проекта |
| Начало работы | `docs/getting-started.md` | Установка, настройка, первый запуск |
| Архитектура | `docs/architecture.md` | Структура проекта и паттерны |
| API Reference | `docs/api.md` | Эндпоинты webhook и setup-webhook |
| Конфигурация | `docs/configuration.md` | Переменные окружения |
| MAX Bot API | `.ai-factory/references/max-bot-api.md` | Справочник по MAX Bot API |

## Файлы контекста AI

| Файл | Назначение |
|------|------------|
| AGENTS.md | Структурная карта проекта (этот файл) |
| `.ai-factory/DESCRIPTION.md` | Спецификация проекта |
| `.ai-factory/ARCHITECTURE.md` | Архитектурные решения и правила зависимостей |
| CLAUDE.md | Правила для Claude Code |

## Правила для агентов

- Разделяйте составные shell-команды на отдельные шаги с проверкой каждого
  - Неправильно: `git checkout main && git pull`
  - Правильно: Сначала `git checkout main`, затем `git pull origin main`
