# Max Bot API Reference

> Source: https://dev.max.ru/docs/chatbots/bots-coding/js, https://dev.max.ru/docs/chatbots/bots-coding/examples, https://github.com/max-messenger/max-bot-api-client-ts/tree/master/docs, https://github.com/max-messenger/max-bot-example-todolist
> Created: 2026-06-07
> Updated: 2026-06-07

## Overview

`@maxhub/max-bot-api` (v0.2.2) is the official MAX messenger TypeScript/JavaScript library for building bots. It provides an event-driven framework for handling updates (messages, commands, callbacks) and sending messages with attachments, formatted text, keyboards, and more.

The underlying REST API lives at `https://platform-api.max.ru`. Authentication is via `Authorization: <token>` header (query-param auth is deprecated). Rate limit: 30 requests per second.

Bot development requires a verified organization profile on the MAX partner platform (business.max.ru). Up to 5 bots per organization.

## Core Concepts

**Bot**: Main class from `@maxhub/max-bot-api`. Instantiate with a token from the bot's settings card on the partner platform. Handles connection, dispatching, and lifecycle.

**Context (ctx)**: Passed to every handler. Provides access to current message, user, chat, and API methods.

**Updates**: Events the bot receives — includes `bot_started`, `message_created`, `message_edited`, `message_removed`, `message_callback`, `bot_added`, `bot_removed`, `user_added`, `user_removed`, `chat_title_changed`.

**Middleware**: Functions registered with `bot.use()` that run on every update before handlers. Used to extend context with custom data.

**Webhook vs Long Polling**: For production — Webhook only. For dev/testing — either. Cannot use both simultaneously. Long Polling is rate-limited and not suitable for production.

**Deep Links**: URLs like `https://max.ru/<botName>?start=<payload>` that open a bot with extra parameters (up to 128 chars). Bot receives a `bot_started` update with the payload.

## API / Interface

### Bot Constructor

```typescript
import { Bot } from '@maxhub/max-bot-api';

const bot = new Bot(process.env.BOT_TOKEN);
const bot = new Bot<MyContext>(process.env.BOT_TOKEN); // with custom context
```

### Bot Methods — Registration

```typescript
bot.on(event: string, handler: (ctx: Context) => void): void
bot.command(name: string, handler: (ctx: Context) => Promise<void>): void
bot.hears(pattern: string | RegExp, handler: (ctx: Context) => Promise<void>): void
bot.action(payload: string | RegExp, handler: (ctx: Context) => Promise<void>): void
bot.use(middleware: (ctx: Context, next: () => Promise<void>) => void): void
bot.start(): void
bot.catch(errorHandler: (error: Error) => void): void
```

### Available Events

| Event | Description |
|-------|-------------|
| `bot_started` | User starts a dialog with the bot (also from deep links) |
| `message_created` | New message received |
| `message_edited` | Message edited |
| `message_removed` | Message removed |
| `message_callback` | Callback button pressed |
| `bot_added` | Bot added to a group chat |
| `bot_removed` | Bot removed from a group chat |
| `user_added` | User added to a conversation |
| `user_removed` | User removed from a conversation |
| `chat_title_changed` | Conversation title changed |

### Context Methods

```typescript
ctx.reply(text: string, extra?: ReplyExtra): Promise<SendMessageResult>

// ReplyExtra:
// { link?: { type: 'reply', mid: string }, format?: 'markdown' | 'html', attachments?: AttachmentJson[] }
```

### bot.api — Messaging

```typescript
bot.api.setMyCommands(commands: { name: string, description: string }[]): Promise<Response>
bot.api.sendMessageToUser(userId: number, text: string, extra?: MessageExtra): Promise<Response>
bot.api.sendMessageToChat(chatId: number, text: string, extra?: MessageExtra): Promise<Response>
```

### bot.api — Chat Actions (mark as read, typing)

```typescript
bot.api.sendAction(chatId: number, action: SenderAction): Promise<ActionResponse>
// SenderAction: 'typing_on' | 'sending_photo' | 'sending_video' | 'sending_audio' | 'sending_file' | 'mark_seen'
```

`POST /chats/{chatId}/actions` — отправка действия бота. `mark_seen` помечает сообщение как прочитанное; `typing_on` показывает индикатор "печатает".

### bot.api — Uploads

```typescript
bot.api.uploadImage({ source: string } | { url: string }): Promise<Attachment>
bot.api.uploadVideo({ source: string }): Promise<Attachment>
bot.api.uploadAudio({ source: string }): Promise<Attachment>
bot.api.uploadFile({ source: string }): Promise<Attachment>
```

### Raw API

```typescript
ctx.api.raw.get(method: string, params?: RawParams)
ctx.api.raw.post(method: string, params?: RawParams)
ctx.api.raw.put(method: string, params?: RawParams)
ctx.api.raw.patch(method: string, params?: RawParams)
ctx.api.raw.delete(method: string, params?: RawParams)

// RawParams: { path?: object, body?: object, query?: object }

// Example:
await ctx.api.raw.patch('chats/{chat_id}', {
  path: { chat_id: 123 },
  body: { title: 'New Title' },
  query: { notify: false },
});
```

### Attachment Classes

```typescript
new ImageAttachment({ token: string })
new VideoAttachment({ token: string })
new AudioAttachment({ token: string })
new FileAttachment({ token: string })
new StickerAttachment({ code: string })
new LocationAttachment({ lon: number, lat: number })
new ShareAttachment({ url: string, token: string })

// All extend Attachment:
attachment.toJson(): AttachmentJson
```

### Keyboard Builder

```typescript
Keyboard.inlineKeyboard(rows: Button[][]): Keyboard
```

### Button Types

| Method | Signature | Description |
|--------|-----------|-------------|
| `button.callback` | `(text, payload, extra?: { intent?: 'default' \| 'positive' \| 'negative' })` | Sends `message_callback` update on press |
| `button.link` | `(text: string, url: string)` | Opens URL in new tab (max 2048 chars) |
| `button.requestContact` | `(text: string)` | Requests user's phone & contact (with `hash` field for verification) |
| `button.requestGeoLocation` | `(text, extra?: { quick?: boolean })` | Requests user's location |
| `button.chat` | `(text, chatTitle, extra?: { chat_description?, start_payload?, uuid? })` | Creates a new chat with bot and user |
| `button.openApp` | `(text: string, webApp?: string, contactId?: number)` | Opens a mini-app |
| `button.message` | `(text: string)` | Sends a text message to the bot |

### Keyboard Layout Limits

- Max 210 buttons per inline keyboard
- Max 30 rows
- Max 7 buttons per row (3 for `link`, `open_app`, `request_geo_location`, `request_contact`)

## Text Formatting

Two formatting modes: `markdown` and `html`. Set `format` property in message extra.

### Markdown

| Style | Syntax |
|-------|--------|
| Italic | `*text*` or `_text_` |
| Bold | `**text**` or `__text__` |
| Strikethrough | `~~text~~` |
| Underline | `++text++` |
| Monospace | `` `code` `` |
| Link | `[text](url)` |
| User mention | `[Full Name](max://user/user_id)` |
| Highlighted | `^^text^^` |
| Heading | `# heading` |
| Quote | `> quote` |

### HTML

| Style | Tag |
|-------|-----|
| Italic | `<i>` / `<em>` |
| Bold | `<b>` / `<strong>` |
| Strikethrough | `<del>` / `<s>` |
| Underline | `<ins>` / `<u>` |
| Monospace | `<pre>` / `<code>` |
| Link | `<a href="url">text</a>` |
| User mention | `<a href="max://user/user_id">Full Name</a>` |
| Highlighted | `<mark>` |
| Heading | `<h1>` through `<h4>` (displayed identically) |
| Quote | `<blockquote>` |

## Deep Links

Format: `https://max.ru/<botName>?start=<payload>` (payload max 128 chars).

Bot receives a `bot_started` update:

```json
{
  "update_type": "bot_started",
  "timestamp": 1573226679188,
  "chat_id": 1234567890,
  "user": { "user_id": 1234567890, "name": "Иван", "username": "ivan_petrov" },
  "payload": "promo_summer2025"
}
```

Requires Webhook or Long Polling with `bot_started` in `update_types`.

## Usage Patterns

### Basic Bot

```typescript
import { Bot } from '@maxhub/max-bot-api';

const bot = new Bot(process.env.BOT_TOKEN);

bot.command('start', (ctx) => ctx.reply('Welcome!'));
bot.on('message_created', (ctx) => ctx.reply('New message'));

bot.start();
```

### Command & Pattern Matching

```typescript
bot.command('start', async (ctx) => { /* ... */ });
bot.hears('hello', async (ctx) => { /* ... */ });
bot.hears(/echo (.+)?/, async (ctx) => { /* ... */ });
bot.action('connect_wallet', async (ctx) => { /* ... */ });
bot.action(/color:(.+)/, async (ctx) => { /* ... */ });
```

### Reply with Original Message Link

```typescript
bot.hears('ping', async (ctx) => {
  await ctx.reply('pong', {
    link: { type: 'reply', mid: ctx.message.body.mid },
  });
});
```

### Formatted Messages

```typescript
// Markdown
await ctx.reply('**Hello!** _Welcome_ to [MAX](https://dev.max.ru).', { format: 'markdown' });
// HTML
await ctx.reply('<b>Hello!</b> <i>Welcome</i> to <a href="https://dev.max.ru">MAX</a>.', { format: 'html' });
```

### Sending Attachments

```typescript
// By token
const image = new ImageAttachment({ token: 'existingImageToken' });
await ctx.reply('', { attachments: [image.toJson()] });

// Upload from file
const image = await ctx.api.uploadImage({ source: '/path/to/image' });
await ctx.reply('', { attachments: [image.toJson()] });

// Upload from URL (images only)
const image = await ctx.api.uploadImage({ url: 'https://example.com/image.png' });
await ctx.reply('', { attachments: [image.toJson()] });

// Non-media attachments
const sticker = new StickerAttachment({ code: "stickerCode" });
const location = new LocationAttachment({ lon: 0, lat: 0 });
const share = new ShareAttachment({ url: "messagePublicUrl", token: "attachmentToken" });
```

### Inline Keyboard

```typescript
const keyboard = Keyboard.inlineKeyboard([
  [
    Keyboard.button.callback('default', 'color:default'),
    Keyboard.button.callback('positive', 'color:positive', { intent: 'positive' }),
    Keyboard.button.callback('negative', 'color:negative', { intent: 'negative' }),
  ],
  [
    Keyboard.button.link('Open MAX', 'https://max.ru'),
    Keyboard.button.openApp('Open App'),
  ],
]);
```

### Custom Context via Middleware

```typescript
interface MyContext extends Context {
  isAdmin?: boolean;
}
const ADMIN_ID = 12345;
const bot = new Bot<MyContext>(process.env.BOT_TOKEN);

bot.use(async (ctx, next) => {
  ctx.isAdmin = ctx.user?.user_id === ADMIN_ID;
  return next();
});

bot.command('start', async (ctx) => {
  if (ctx.isAdmin) return ctx.reply('Hello, admin!');
  return ctx.reply('Hello!');
});
```

### Using the REST API Directly

```typescript
// Verify token
// GET https://platform-api.max.ru/me with Authorization: <token>
// Response: { user_id, name, username, is_bot, last_activity_time }

// Send POST /messages
await ctx.api.raw.post('messages', {
  body: {
    text: 'Hello',
    chat_id: 12345,
    format: 'markdown',
  },
});
```

## Примеры создания ботов

### Hello Bot (JavaScript)

Пошаговое создание простого бота, который отвечает на команду `/hello`.

```bash
mkdir my-first-bot && cd my-first-bot
npm install --save @maxhub/max-bot-api
```

```javascript
import { Bot } from '@maxhub/max-bot-api';
const bot = new Bot(process.env.BOT_TOKEN);

bot.api.setMyCommands([
  { name: 'hello', description: 'Поприветствовать бота' },
]);

bot.command('hello', (ctx) => {
  return ctx.reply('Привет! ✨');
});

bot.start();
```

### Ping-Pong Bot (JS/TS)

Бот из репозитория `max-bot-api-client-ts` — реагирует на `/ping`, `hello` и все входящие сообщения.

```javascript
import { Bot } from '@maxhub/max-bot-api';
const bot = new Bot(process.env.BOT_TOKEN);

bot.api.setMyCommands([
  { name: 'ping', description: 'Сыграть в пинг-понг' },
]);

bot.on('bot_started', (ctx) =>
  ctx.reply('Привет! Отправь мне команду /ping, чтобы сыграть в пинг-понг')
);

bot.command('ping', (ctx) => ctx.reply('pong'));
bot.hears('hello', (ctx) => ctx.reply('world'));
bot.on('message_created', (ctx) => ctx.reply(ctx.message.body.text));

bot.start();
```

### Hello Bot (Golang)

Пример из официальной документации на Go.

```bash
mkdir my-first-bot && cd my-first-bot
go mod init my-first-bot
go get github.com/max-messenger/max-bot-api-client-go
```

```go
package main

import (
  "os"
  "github.com/max-messenger/max-bot-api-client-go"
)

func main() {
  bot := maxbotapi.NewBot(os.Getenv("BOT_TOKEN"))

  bot.SetMyCommands([]maxbotapi.Command{
    {Name: "hello", Description: "Поприветствовать бота"},
  })

  bot.OnCommand("hello", func(ctx maxbotapi.Context) {
    ctx.Reply("Привет! ✨")
  })

  bot.Start()
}
```

### To-Do List Bot (Golang)

Демо-бот из репозитория `max-bot-example-todolist` — работает как чат-бот и мини-приложение.

**Команды в чате:**
| Команда | Описание |
|---------|----------|
| `/info` | Список функций бота |
| `/create` | Добавить запись |
| `/list` | Просмотреть все записи |
| `/delete` | Удалить запись из списка |
| `/myid` | Получить user_id и chat_id |

**Запуск:**
```bash
git clone git@github.com:max-messenger/max-bot-example-todolist.git
cd max-bot-example-todolist
docker-compose up -d
cp config/todolist/config.tmpl.yaml config.yaml
go build -o todo-app ./cmd/todolist
./todo-app -c config.yaml
```

**Структура проекта:**
```
internal/app/
├── clients/        — клиенты (http, grpc, maxbot)
├── domain/         — доменные модели
├── repository/     — хранилища (state, todo)
├── router/         — HTTP API (todolistctrl, webhookctrl)
├── services/       — бизнес-логика (analytic, bot, todolist)
└── subscriber/     — подписки на события
```

Встроенные модули: `grace` (graceful shutdown), `health` (статус приложения), `server` (HTTP/gRPC), `info` (информация о приложении), `telemetry` (метрики Prometheus/OTEL). Доступны модули для Postgres, Redis Cluster, Kafka, Rate Limiter.

### Обработка ошибок

По умолчанию `bot.handleError` завершает программу при ошибке. Переопределите через `bot.catch`:

```javascript
bot.catch((error) => {
  console.error('Bot error:', error);
  // pm2 или systemd перезапустят процесс
});
```

Рекомендуется завершать программу при неизвестных ошибках и использовать `pm2` для автоматического перезапуска.

## REST API Reference (platform-api.max.ru)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/me` | Bot info |
| GET | `/chats` | List group chats and channels |
| GET | `/chats/{chatId}` | Chat/channel info |
| PATCH | `/chats/{chatId}` | Edit chat/channel |
| DELETE | `/chats/{chatId}` | Delete group chat |
| POST | `/chats/{chatId}/actions` | Send bot action |
| GET | `/chats/{chatId}/pin` | Get pinned message |
| PUT | `/chats/{chatId}/pin` | Pin message |
| DELETE | `/chats/{chatId}/pin` | Unpin message |
| GET | `/chats/{chatId}/members` | List members |
| POST | `/chats/{chatId}/members` | Add members |
| DELETE | `/chats/{chatId}/members` | Remove member |
| GET | `/messages` | Get messages |
| POST | `/messages` | Send message |
| PUT | `/messages` | Edit message |
| DELETE | `/messages` | Delete message |
| GET | `/messages/{messageId}` | Get single message |
| POST | `/uploads` | Upload file |
| POST | `/answers` | Answer callback |
| GET | `/subscriptions` | List webhook subscriptions |
| POST | `/subscriptions` | Subscribe to webhook |
| DELETE | `/subscriptions` | Unsubscribe from webhook |
| GET | `/updates` | Long Polling updates |

### HTTP Response Codes

| Code | Meaning |
|------|---------|
| 200 | Success |
| 400 | Invalid request |
| 401 | Authentication error |
| 404 | Not found |
| 405 | Method not allowed |
| 429 | Rate limit exceeded |
| 503 | Service unavailable |

## Configuration

| Option | Default | Description |
|--------|---------|-------------|
| `BOT_TOKEN` | (required) | From partner platform settings. Pass via env var. |
| `format` | plain text | `'markdown'` or `'html'` |
| `link` | none | `{ type: 'reply', mid: string }` to attach original message |
| `intent` | `'default'` | Callback button style: `'default'`, `'positive'`, `'negative'` |
| `quick` | false | Skip geo-location confirmation |
| `chat_description` | null | Chat button: description of created chat |
| `start_payload` | null | Chat button: payload sent on chat creation |

## Best Practices

1. **Use environment variables** for the bot token — never hardcode or commit it.
2. **Use Webhook for production** — Long Polling is rate-limited and not suitable for production. After May 25, HTTP webhooks and self-signed certs are no longer supported.
3. **Use `ctx.reply` as shorthand** — it calls `sendMessageToChat` in the same chat and supports link/reply.
4. **Use TypeScript** — the library ships with type definitions; custom context generics improve type safety.
5. **Use middleware** for cross-cutting concerns like auth and logging via `bot.use()`.
6. **Use `ctx.api.raw` as fallback** for methods not yet wrapped by the library.
7. **Keep keyboards simple** — max 210 buttons, 30 rows, text centered and truncated on overflow.

## Common Pitfalls

- **Typos in event names** — no server-side validation; rely on editor intellisense.
- **Missing `await`** — async handlers must return a Promise.
- **Forgetting `.toJson()`** — attachments need serialization before passing in `attachments`.
- **Token in query params** — deprecated. Use `Authorization: <token>` header instead.
- **Token exposure** — store in env vars, not in source code.
- **Payload over 128 chars** in deep links — truncated, won't reach the bot.

## Version Notes

- **v0.2.2** — published as `@maxhub/max-bot-api`. Active development on GitHub.
- Node.js >= 18.18.0 required.
- May 25 cutoff: HTTP webhooks and self-signed certs no longer supported; migrate to HTTPS + trusted CA.
- Rate limit: 30 rps on `platform-api.max.ru`.
- Bot token regeneration available via partner platform settings.
