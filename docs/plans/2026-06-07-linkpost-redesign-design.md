# LinkPost Redesign — Design Doc

**Date:** 2026-06-07
**Status:** Approved

## Overview

LinkPost — бот для мессенджера MAX. Распределяет входящий трафик по ключам `?start=<key>`.

## Data Model

```
link:<key>         → Hash   { url, message }
link_subs:<key>    → Set    [ user_id, ... ]   — кто пришёл по этому ключу
links_all          → Set    [ key, ... ]        — все ключи

user:<user_id>     → Hash   { user_id, name, username, subscribed_key, inactive, updated_at }
users_all          → Set    [ user_id, ... ]    — все пользователи
```

### Storage layer (`lib/storage.js`) — additions

- `addUserToLink(key, user_id)` — `sadd link_subs:<key> user_id`
- `getLinkSubs(key)` — `smembers link_subs:<key>`
- `markInactive(user_id)` — `hset user:<user_id> inactive true`
- `reactivateUser(user_id)` — `hset user:<user_id> inactive false`
- Save `subscribed_key` in `saveUser()`

## User Flow

1. User clicks deep-link `https://max.ru/<bot>?start=<key>`
2. MAX sends `bot_started` with `payload: "<key>"`
3. Bot saves user with `subscribed_key`
4. Bot adds user to `link_subs:<key>`
5. Bot sends message + inline button with link
6. Unknown key → error message

Text input of key for non-admins is **removed**.

## Admin Panel

### Commands (unchanged)
`/setlink <key> <url> <msg>`, `/dellink <key>`, `/links`, `/users`

### Inline buttons (new — on `/start` for admin)
- **«📋 Связки»** → shows `/links` output
- **«➕ Создать связку»** → `/setlink` usage help
- **«👥 Пользователи»** → stats (total, per-key, active/inactive)
- **«📨 Рассылка»** → placeholder (future feature)

### Delete from list (new)
Each link in `/links` is a button with `callback_data: "del:<key>"`.
On tap — confirm dialog (Y/N buttons).
On confirm — `delLink(key)`.

### Webhook handler additions
Handle `update_type: 'callback_query'` — parse `callback_data`, execute action, send response.

## Inactive User Tracking

- On broadcast send failure → `markInactive(user_id)`
- On user re-enters (`bot_started` or any message) → `reactivateUser(user_id)`
- No polling/active check on MAX API (not available)

## Files Changed

| File | Change |
|------|--------|
| `lib/storage.js` | Add `link_subs:*` methods, `subscribed_key`/`inactive` in user, `markInactive`, `reactivateUser` |
| `api/index.js` | Remove text key input for non-admins, add callback_query handler, inline keyboard admin panel, confirm-delete flow, save `subscribed_key` + `link_subs` on `bot_started` |
| `test/handler.test.js` | Update tests, add callback tests, add link subscription tests |
| `lib/kv-mock.js` | No changes expected |

## Future

- **Broadcast** — iterate `link_subs:<key>` or `users_all`, send message, mark inactive on failure
- **Per-key stats** — count, active/inactive per link
