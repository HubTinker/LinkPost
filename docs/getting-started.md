[Back to README](../README.md) · [Архитектура →](architecture.md)

# Начало работы

## Требования

- Node.js >= 18
- Аккаунт на [Vercel](https://vercel.com)
- Зарегистрированная организация на [business.max.ru](https://business.max.ru)
- Токен бота из настроек на MAX Partner Platform
- Экземпляр Vercel KV (Redis)

## Установка

```bash
git clone <repository-url>
cd linkpost-bot
npm install
```

## Настройка Vercel

Установите Vercel CLI:

```bash
npm i -g vercel
```

Подключите проект:

```bash
vercel link
```

Создайте Vercel KV базу данных:

```bash
vercel kv create
```

## Переменные окружения

Скопируйте переменные из Vercel:

```bash
vercel env pull
```

Или установите вручную в `.env.local`:

```
BOT_TOKEN=ваш_токен_бота
SETUP_SECRET=ваш_секрет
ADMIN_USER_IDS=123456789
BOT_NICK=YourBot
```

## Запуск локально

```bash
vercel dev
```

Сервер запустится на `http://localhost:3000`.

## Регистрация webhook

После деплоя вызовите один раз:

```
GET https://ваш-проект.vercel.app/setup-webhook?secret=ВАШ_SECRET
```

MAX начнёт присылать события на ваш webhook.

## Деплой

```bash
vercel --prod
```

## См. также

- [Конфигурация](configuration.md) — все переменные окружения
- [API Reference](api.md) — эндпоинты бота
