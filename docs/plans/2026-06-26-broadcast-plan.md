# Broadcast Feature — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add broadcast messaging: admin creates message (text + images + buttons + Markdown), sends immediately or scheduled, tracks opens/unsubs.

**Architecture:** Vercel KV stores broadcast metadata and progress sets. Vercel Cron calls `/process-broadcasts` which sends in batches of 20. `lib/broadcast.js` is the storage layer, `lib/max-api.js` gains `sendBroadcastMessage` and `uploadFile`.

**Tech Stack:** Hono.js, Vercel KV (Redis), MAX Bot API, Node.js tls

---

### Task 1: Broadcast storage layer (`lib/broadcast.js`)

**Files:**
- Create: `lib/broadcast.js`
- Reference: `lib/storage.js` (for patterns)

**Step 1: Write the file with all broadcast KV functions**

Create `lib/broadcast.js`:

```js
const BR_PREFIX = 'broadcast:'
const BR_ALL_SET = 'broadcasts:all'
const BR_SCHEDULED_ZSET = 'broadcasts:scheduled'

const SENT_SUFFIX = ':sent'
const DELIVERED_SUFFIX = ':delivered'
const OPENED_SUFFIX = ':opened'
const UNSUBBED_SUFFIX = ':unsubbed'
const FAILED_SUFFIX = ':failed'
const CURSOR_SUFFIX = ':cursor'

const STATS_TTL = 90 * 24 * 60 * 60
const LOG_LEVEL = (process.env.LOG_LEVEL ?? 'INFO').toUpperCase()

function log (level, ...args) {
  const levels = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 }
  if ((levels[level] ?? 1) >= (levels[LOG_LEVEL] ?? 0)) {
    console.log(`[broadcast] [${level}]`, ...args)
  }
}

let _kv = null
async function getKv () {
  if (!_kv) {
    const useMock = !process.env.KV_URL && !process.env.KV_REST_API_URL
    const mod = useMock ? await import('./kv-mock.js') : await import('@vercel/kv')
    _kv = mod.kv
  }
  return _kv
}

export async function createBroadcast (data) {
  const kv = await getKv()
  const id = `br_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const broadcast = {
    id,
    title: data.title ?? null,
    text: data.text ?? '',
    images: data.images ?? [],
    buttons: data.buttons ?? [],
    format: data.format ?? 'markdown',
    status: data.scheduled_at ? 'scheduled' : 'draft',
    scheduled_at: data.scheduled_at ?? null,
    created_at: Date.now(),
    created_by: data.created_by
  }
  await kv.set(`${BR_PREFIX}${id}`, broadcast)
  await kv.sadd(BR_ALL_SET, id)
  if (broadcast.scheduled_at) {
    await kv.zadd(BR_SCHEDULED_ZSET, { score: broadcast.scheduled_at, member: id })
  }
  log('INFO', `created broadcast ${id}, status=${broadcast.status}`)
  return broadcast
}

export async function getBroadcast (id) {
  const kv = await getKv()
  return kv.get(`${BR_PREFIX}${id}`)
}

export async function updateBroadcast (id, patch) {
  const kv = await getKv()
  const existing = await kv.get(`${BR_PREFIX}${id}`)
  if (!existing) return null
  const updated = { ...existing, ...patch, id }
  await kv.set(`${BR_PREFIX}${id}`, updated)

  if (patch.scheduled_at !== undefined) {
    await kv.zrem(BR_SCHEDULED_ZSET, id)
    if (updated.scheduled_at != null) {
      await kv.zadd(BR_SCHEDULED_ZSET, { score: updated.scheduled_at, member: id })
    }
  }
  return updated
}

export async function deleteBroadcast (id) {
  const kv = await getKv()
  const keys = [
    `${BR_PREFIX}${id}`,
    `${BR_PREFIX}${id}${SENT_SUFFIX}`,
    `${BR_PREFIX}${id}${DELIVERED_SUFFIX}`,
    `${BR_PREFIX}${id}${OPENED_SUFFIX}`,
    `${BR_PREFIX}${id}${UNSUBBED_SUFFIX}`,
    `${BR_PREFIX}${id}${FAILED_SUFFIX}`,
    `${BR_PREFIX}${id}${CURSOR_SUFFIX}`
  ]
  await kv.del(...keys)
  await kv.srem(BR_ALL_SET, id)
  await kv.zrem(BR_SCHEDULED_ZSET, id)
  log('INFO', `deleted broadcast ${id}`)
}

export async function getAllBroadcasts () {
  const kv = await getKv()
  const ids = await kv.smembers(BR_ALL_SET)
  if (!ids.length) return []
  const values = await Promise.all(ids.map(id => kv.get(`${BR_PREFIX}${id}`)))
  return values.filter(Boolean).sort((a, b) => b.created_at - a.created_at)
}

export async function getScheduledBroadcasts () {
  const kv = await getKv()
  const ids = await kv.zrangebyscore(BR_SCHEDULED_ZSET, 0, Date.now())
  if (!ids.length) return []
  const values = await Promise.all(ids.map(id => kv.get(`${BR_PREFIX}${id}`)))
  return values.filter(b => b && b.status === 'scheduled')
}

export async function markSent (broadcastId, userId) {
  const kv = await getKv()
  return kv.sadd(`${BR_PREFIX}${broadcastId}${SENT_SUFFIX}`, String(userId))
}

export async function isSent (broadcastId, userId) {
  const kv = await getKv()
  return kv.sismember(`${BR_PREFIX}${broadcastId}${SENT_SUFFIX}`, String(userId))
}

export async function markDelivered (broadcastId, userId) {
  const kv = await getKv()
  return kv.sadd(`${BR_PREFIX}${broadcastId}${DELIVERED_SUFFIX}`, String(userId))
}

export async function markOpened (broadcastId, userId) {
  const kv = await getKv()
  return kv.sadd(`${BR_PREFIX}${broadcastId}${OPENED_SUFFIX}`, String(userId))
}

export async function recordUnsub (broadcastId, userId) {
  const kv = await getKv()
  return kv.sadd(`${BR_PREFIX}${broadcastId}${UNSUBBED_SUFFIX}`, String(userId))
}

export async function markFailed (broadcastId, userId) {
  const kv = await getKv()
  return kv.sadd(`${BR_PREFIX}${broadcastId}${FAILED_SUFFIX}`, String(userId))
}

export async function getCursor (broadcastId) {
  const kv = await getKv()
  const val = await kv.get(`${BR_PREFIX}${broadcastId}${CURSOR_SUFFIX}`)
  return Number(val) || 0
}

export async function setCursor (broadcastId, value) {
  const kv = await getKv()
  const key = `${BR_PREFIX}${broadcastId}${CURSOR_SUFFIX}`
  await kv.set(key, value)
  await kv.expire(key, STATS_TTL)
}

export async function getBroadcastStats (broadcastId) {
  const kv = await getKv()
  const [sent, delivered, opened, unsubbed, failed] = await Promise.all([
    kv.scard(`${BR_PREFIX}${broadcastId}${SENT_SUFFIX}`),
    kv.scard(`${BR_PREFIX}${broadcastId}${DELIVERED_SUFFIX}`),
    kv.scard(`${BR_PREFIX}${broadcastId}${OPENED_SUFFIX}`),
    kv.scard(`${BR_PREFIX}${broadcastId}${UNSUBBED_SUFFIX}`),
    kv.scard(`${BR_PREFIX}${broadcastId}${FAILED_SUFFIX}`)
  ])
  return { sent, delivered, opened, unsubbed, failed }
}

export { BR_PREFIX, BR_ALL_SET, BR_SCHEDULED_ZSET }
```

**Step 2: Verify file syntax**

Run: `node --check lib/broadcast.js`
Expected: no output (no syntax errors)

**Step 3: Commit**

```bash
git add lib/broadcast.js
git commit -m "feat: add broadcast storage layer"
```

---

### Task 2: Extend MAX API — sendBroadcastMessage

**Files:**
- Modify: `lib/max-api.js`
- Reference: `lib/max-api.js:107-161` (existing send functions)

**Step 1: Add `sendBroadcastMessage` function**

Add to `lib/max-api.js`:

```js
export async function sendBroadcastMessage (chatId, broadcast) {
  if (chatId == null) {
    console.error('[API] sendBroadcastMessage: chatId is required')
    throw new Error(`chatId is required, got ${chatId}`)
  }

  const payload = {
    text: broadcast.text
  }

  if (broadcast.format && broadcast.format !== 'plain') {
    payload.format = broadcast.format
  }

  const attachments = []

  if (broadcast.images && broadcast.images.length) {
    for (const fileId of broadcast.images) {
      attachments.push({
        type: 'image',
        payload: { file_id: fileId }
      })
    }
  }

  if (broadcast.buttons && broadcast.buttons.length) {
    attachments.push({
      type: 'inline_keyboard',
      payload: {
        buttons: broadcast.buttons.map(row => {
          const btnRow = Array.isArray(row) ? row : [row]
          return btnRow.map(btn => ({
            type: 'link',
            text: btn.text,
            url: btn.url
          }))
        })
      }
    })
  }

  if (attachments.length) {
    payload.attachments = attachments
  }

  return request('POST', `/messages?chat_id=${chatId}`, payload)
}
```

**Step 2: Verify file syntax**

Run: `node --check lib/max-api.js`
Expected: no output

**Step 3: Commit**

```bash
git add lib/max-api.js
git commit -m "feat: add sendBroadcastMessage to MAX API"
```

---

### Task 3: Extend MAX API — uploadFile (images)

**Files:**
- Modify: `lib/max-api.js`

**Step 1: Research MAX file upload endpoint**

Check `.ai-factory/references/max-bot-api.md` for file upload API.

**Step 2: Add `uploadFile` function**

```js
export async function uploadFile (fileBuffer, filename) {
  // MAX Bot API: POST /files with multipart/form-data
  // Returns { file_id: "..." }
  const url = `${BASE}/files`

  if (allCAs) {
    // For TLS mode, we skip multipart (complex) — admin sends file to bot,
    // bot receives it as attachment with file_id already
    console.warn('[API] uploadFile: TLS mode, file upload not supported — use received file_id')
    throw new Error('File upload not supported in TLS mode. Send image to bot directly.')
  }

  const formData = new FormData()
  formData.append('file', new Blob([fileBuffer]), filename)

  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: process.env.BOT_TOKEN },
    body: formData
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`MAX file upload error ${res.status}: ${err}`)
  }

  return res.json()
}
```

**Step 3: Note on image handling strategy**

The admin sends images to the bot via chat. The bot receives them as `message_created` events with attachments. The `file_id` is extracted from the attachment payload and stored in the broadcast draft. No separate file upload API call is needed.

**Step 4: Commit**

```bash
git add lib/max-api.js
git commit -m "feat: add uploadFile to MAX API"
```

---

### Task 4: Broadcast callback handlers in `api/index.js`

**Files:**
- Modify: `api/index.js`
- Reference: `api/index.js:286-476` (existing callback handlers pattern)
- Reference: `api/index.js:69-83` (showAdminMenu, needs broadcast menu update)

**Step 1: Add imports**

At top of `api/index.js`, add:
```js
import {
  createBroadcast, getBroadcast, updateBroadcast, deleteBroadcast,
  getAllBroadcasts, getScheduledBroadcasts,
  markSent, markDelivered, markOpened, recordUnsub,
  getBroadcastStats
} from '../lib/broadcast.js'
```

**Step 2: Update `showAdminMenu` — replace placeholder with submenu**

In `showAdminMenu`, replace the broadcast button's callback data from `'broadcast'` to `'broadcast_menu'`.

**Step 3: Add callback handler for `broadcast_menu`**

In `handleCallbackQuery`, add handler for `cb.payload === 'broadcast_menu'`:
```js
if (cb.payload === 'broadcast_menu') {
  const stats = { draft: 0, scheduled: 0, sending: 0, sent: 0 }
  const all = await getAllBroadcasts()
  for (const b of all) {
    if (stats[b.status] !== undefined) stats[b.status]++
  }
  return sendMessageWithKeyboard(chatId,
    `📨 Рассылки\n\n` +
    `📝 Черновики: ${stats.draft}\n` +
    `⏳ Запланировано: ${stats.scheduled}\n` +
    `📤 Отправляется: ${stats.sending}\n` +
    `✅ Отправлено: ${stats.sent}`,
    [
      [{ type: 'callback', text: '📝 Новая рассылка', data: 'broadcast_create' }],
      [{ type: 'callback', text: '📋 Список рассылок', data: 'broadcast_list' }],
      [{ type: 'callback', text: '🔙 Назад', data: 'back' }]
    ]
  )
}
```

**Step 4: Add handler for `broadcast_create`**

Starts the step-by-step creation flow. Sets session state for the admin (step 1: ask for text):
```js
if (cb.payload === 'broadcast_create') {
  const draft = await createBroadcast({
    created_by: userId,
    status: 'draft'
  })
  return sendMessageWithKeyboard(chatId,
    `📝 Новая рассылка (шаг 1/4)\n\n` +
    `Введите текст сообщения (поддерживается Markdown):\n\n` +
    `ID черновика: ${draft.id}\n` +
    `Для отмены используйте /cancel`,
    [[{ type: 'callback', text: '❌ Отмена', data: 'broadcast_cancel' }]]
  )
}
```

**Step 5: Commit**

```bash
git add api/index.js
git commit -m "feat: add broadcast menu and create draft callback"
```

---

### Task 5: Broadcast creation flow — message handler

**Files:**
- Modify: `api/index.js`

**Step 1: Add draft state tracking**

Use a simple approach — the last created broadcast in `draft` status by this admin is the active edit target. Add a helper:

```js
async function getActiveDraft (userId) {
  const all = await getAllBroadcasts()
  return all.find(b => b.status === 'draft' && b.created_by === userId)
}
```

**Step 2: Extend `handleMessage` for broadcast draft flow**

In `handleMessage`, after the existing command handlers, add broadcast draft handling for admin users:

```js
// Broadcast draft flow (admin only, not a command)
if (isAdmin(userId)) {
  const draft = await getActiveDraft(userId)
  if (draft) {
    // Determine which step we're on based on what fields are filled
    if (!draft.text) {
      // Step 1: collecting text
      await updateBroadcast(draft.id, { text })
      return sendMessageWithKeyboard(chatId,
        `✅ Текст сохранён!\n\n` +
        `Теперь отправьте изображения (по одному) или нажмите «Готово» чтобы пропустить.\n\n` +
        `ID: ${draft.id}`,
        [
          [{ type: 'callback', text: '✅ Готово', data: `broadcast_images_done:${draft.id}` }],
          [{ type: 'callback', text: '❌ Отмена', data: `broadcast_cancel:${draft.id}` }]
        ]
      )
      return
    }
    // Further steps handled via message attachments and callbacks
  }
}
```

**Step 3: Commit**

```bash
git add api/index.js
git commit -m "feat: broadcast draft text collection"
```

---

### Task 6: Broadcast images and buttons steps

**Files:**
- Modify: `api/index.js`

**Step 1: Handle image attachments in handleMessage for draft flow**

When admin sends a photo while in draft mode and text is already set, extract `file_id` from the message attachment and append to draft images:

```js
// In handleMessage, for admin with active draft that has text but no images_done flag:
const photoAttachment = message?.attachments?.find(a => a.type === 'image')
if (photoAttachment) {
  const fileId = photoAttachment.payload?.file_id
  if (fileId) {
    const images = (draft.images || []).concat([fileId])
    await updateBroadcast(draft.id, { images })
    return sendMessage(chatId, `📷 Изображение добавлено (${images.length}). Отправьте ещё или нажмите «Готово».`)
  }
}
```

**Step 2: Add callback for `broadcast_images_done:<id>`**

```js
if (cb.payload.startsWith('broadcast_images_done:')) {
  const bid = cb.payload.slice('broadcast_images_done:'.length)
  await updateBroadcast(bid, { _images_done: true })
  return sendMessageWithKeyboard(chatId,
    `🔘 Шаг 3/4: Кнопки\n\n` +
    `Отправьте кнопки в формате:\n` +
    `Текст кнопки | https://ссылка\n\n` +
    `По одной кнопке на строку. До 5 кнопок.\n` +
    `Нажмите «Готово» чтобы пропустить.`,
    [
      [{ type: 'callback', text: '✅ Готово', data: `broadcast_buttons_done:${bid}` }],
      [{ type: 'callback', text: '❌ Отмена', data: `broadcast_cancel:${bid}` }]
    ]
  )
}
```

**Step 3: Parse button text in handleMessage**

When draft has `_images_done` and no `_buttons_done`:
```js
if (draft._images_done && !draft._buttons_done) {
  const lines = text.split('\n').filter(l => l.trim())
  const buttons = []
  for (const line of lines) {
    const parts = line.split('|')
    if (parts.length >= 2) {
      buttons.push({ text: parts[0].trim(), url: parts[1].trim() })
    }
  }
  if (buttons.length) {
    await updateBroadcast(draft.id, { buttons, _buttons_done: true })
  }
  // Proceed to schedule step
}
```

**Step 4: Commit**

```bash
git add api/index.js
git commit -m "feat: broadcast images and buttons collection"
```

---

### Task 7: Broadcast schedule step and confirmation

**Files:**
- Modify: `api/index.js`

**Step 1: Add callback for schedule choice**

```js
if (cb.payload.startsWith('broadcast_schedule:')) {
  const bid = cb.payload.slice('broadcast_schedule:'.length)
  return sendMessageWithKeyboard(chatId,
    `⏰ Шаг 4/4: Расписание\n\n` +
    `Выберите когда отправить рассылку:`,
    [
      [{ type: 'callback', text: '🚀 Отправить сейчас', data: `broadcast_send_now:${bid}` }],
      [{ type: 'callback', text: '📅 Запланировать', data: `broadcast_schedule_input:${bid}` }],
      [{ type: 'callback', text: '🔙 Назад', data: 'back' }]
    ]
  )
}
```

**Step 2: Handle "send now"**

```js
if (cb.payload.startsWith('broadcast_send_now:')) {
  const bid = cb.payload.slice('broadcast_send_now:'.length)
  const b = await getBroadcast(bid)
  if (!b) return sendMessage(chatId, '❌ Рассылка не найдена.')
  return sendMessageWithKeyboard(chatId,
    formatBroadcastPreview(b) + '\n\nОтправить сейчас?',
    [
      [{ type: 'callback', text: '✅ Подтвердить', data: `broadcast_confirm_now:${bid}` }],
      [{ type: 'callback', text: '❌ Отмена', data: `broadcast_cancel:${bid}` }]
    ]
  )
}
```

**Step 3: Handle confirmation — set scheduled_at to now**

```js
if (cb.payload.startsWith('broadcast_confirm_now:')) {
  const bid = cb.payload.slice('broadcast_confirm_now:'.length)
  await updateBroadcast(bid, {
    status: 'scheduled',
    scheduled_at: Date.now()
  })
  return sendMessageWithKeyboard(chatId,
    `✅ Рассылка #${bid} запущена! Отправка начнётся в течение минуты.`,
    [[{ type: 'callback', text: '🔙 Назад', data: 'back' }]]
  )
}
```

**Step 4: Scheduled datetime input (reuse text handler)**

When draft has `_schedule_pending` flag, parse datetime from message text:
```js
if (draft._schedule_pending) {
  const parsed = parseRussianDate(text) // "26.06.2026 18:00" → timestamp
  if (!parsed || parsed <= Date.now()) {
    return sendMessage(chatId, '⚠️ Неверная дата. Формат: ДД.ММ.ГГГГ ЧЧ:ММ (будущее время)')
  }
  await updateBroadcast(draft.id, {
    status: 'scheduled',
    scheduled_at: parsed,
    _schedule_pending: false
  })
  return sendMessageWithKeyboard(chatId,
    `✅ Рассылка запланирована на ${text}`,
    [[{ type: 'callback', text: '🔙 Назад', data: 'back' }]]
  )
}
```

**Step 5: Commit**

```bash
git add api/index.js
git commit -m "feat: broadcast schedule and send confirmation"
```

---

### Task 8: Broadcast list, edit, delete

**Files:**
- Modify: `api/index.js`

**Step 1: Add `broadcast_list` callback**

Shows broadcasts with action buttons:
```js
if (cb.payload === 'broadcast_list') {
  const broadcasts = await getAllBroadcasts()
  if (!broadcasts.length) {
    return sendMessageWithKeyboard(chatId, '📭 Нет рассылок.', [
      [{ type: 'callback', text: '🔙 Назад', data: 'back' }]
    ])
  }
  const buttons = broadcasts.slice(0, 10).map(b => [
    { type: 'callback', text: `${statusEmoji(b.status)} ${b.id}`, data: `broadcast_view:${b.id}` }
  ])
  buttons.push([{ type: 'callback', text: '🔙 Назад', data: 'back' }])
  return sendMessageWithKeyboard(chatId, '📋 Рассылки:', buttons)
}
```

**Step 2: Add `broadcast_view:<id>` — detail view with actions**

```js
if (cb.payload.startsWith('broadcast_view:')) {
  const bid = cb.payload.slice('broadcast_view:'.length)
  const b = await getBroadcast(bid)
  if (!b) return sendMessage(chatId, '❌ Рассылка не найдена.')

  const row = []
  if (b.status === 'draft') {
    row.push({ type: 'callback', text: '✏️ Редактировать', data: `broadcast_edit:${bid}` })
  }
  if (b.status === 'sending') {
    row.push({ type: 'callback', text: '⏸ Остановить', data: `broadcast_stop:${bid}` })
  }
  if (b.status === 'cancelled') {
    row.push({ type: 'callback', text: '▶️ Возобновить', data: `broadcast_resume:${bid}` })
  }
  return sendMessageWithKeyboard(chatId,
    formatBroadcastDetail(b),
    [
      row,
      [{ type: 'callback', text: '📊 Статистика', data: `broadcast_stats:${bid}` }],
      [{ type: 'callback', text: '❌ Удалить', data: `broadcast_delete:${bid}` }],
      [{ type: 'callback', text: '🔙 К списку', data: 'broadcast_list' }]
    ]
  )
}
```

**Step 3: Implement delete with confirmation**

```js
if (cb.payload.startsWith('broadcast_delete:')) {
  const bid = cb.payload.slice('broadcast_delete:'.length)
  return sendMessageWithKeyboard(chatId,
    `🗑 Удалить рассылку #${bid}?`,
    [
      [
        { type: 'callback', text: '✅ Да', data: `broadcast_delete_confirm:${bid}` },
        { type: 'callback', text: '❌ Нет', data: `broadcast_view:${bid}` }
      ]
    ]
  )
}
if (cb.payload.startsWith('broadcast_delete_confirm:')) {
  const bid = cb.payload.slice('broadcast_delete_confirm:'.length)
  await deleteBroadcast(bid)
  return sendMessageWithKeyboard(chatId, `🗑 Рассылка #${bid} удалена.`, [
    [{ type: 'callback', text: '🔙 К списку', data: 'broadcast_list' }]
  ])
}
```

**Step 4: Implement stop/resume**

```js
if (cb.payload.startsWith('broadcast_stop:')) {
  const bid = cb.payload.slice('broadcast_stop:'.length)
  await updateBroadcast(bid, { status: 'cancelled' })
  return sendMessageWithKeyboard(chatId, `⏸ Рассылка #${bid} остановлена.`, [
    [{ type: 'callback', text: '🔙 Назад', data: `broadcast_view:${bid}` }]
  ])
}
if (cb.payload.startsWith('broadcast_resume:')) {
  const bid = cb.payload.slice('broadcast_resume:'.length)
  await updateBroadcast(bid, { status: 'scheduled', scheduled_at: Date.now() })
  return sendMessageWithKeyboard(chatId, `▶️ Рассылка #${bid} возобновлена.`, [
    [{ type: 'callback', text: '🔙 Назад', data: `broadcast_view:${bid}` }]
  ])
}
```

**Step 5: Commit**

```bash
git add api/index.js
git commit -m "feat: broadcast list, view, edit, delete callbacks"
```

---

### Task 9: Broadcast stats display

**Files:**
- Modify: `api/index.js`

**Step 1: Add `broadcast_stats:<id>` callback**

```js
if (cb.payload.startsWith('broadcast_stats:')) {
  const bid = cb.payload.slice('broadcast_stats:'.length)
  const b = await getBroadcast(bid)
  if (!b) return sendMessage(chatId, '❌ Рассылка не найдена.')
  const stats = await getBroadcastStats(bid)
  const totalUsers = await getUserCount()
  const openPct = stats.sent ? Math.round(stats.opened / stats.sent * 100) : 0
  const unsubPct = stats.sent ? Math.round(stats.unsubbed / stats.sent * 100) : 0

  let msg = `📊 Статистика рассылки #${bid}\n\n`
  msg += `📝 Текст: ${b.text.slice(0, 100)}${b.text.length > 100 ? '...' : ''}\n`
  msg += `📅 Статус: ${statusLabel(b.status)}\n`
  if (b.scheduled_at) msg += `🕐 Запланирована: ${new Date(b.scheduled_at).toLocaleString('ru')}\n`
  msg += `\n`
  msg += `✅ Отправлено:   ${stats.sent} / ${totalUsers}\n`
  msg += `👁 Открыто:       ${stats.opened} (${openPct}%)\n`
  msg += `🚫 Отписалось:    ${stats.unsubbed} (${unsubPct}%)\n`

  return sendMessageWithKeyboard(chatId, msg, [
    [{ type: 'callback', text: '🔙 Назад', data: `broadcast_view:${bid}` }]
  ])
}
```

**Step 2: Add helper functions**

```js
function statusEmoji (s) {
  return { draft: '📝', scheduled: '⏳', sending: '📤', sent: '✅', cancelled: '⏸' }[s] || '❓'
}
function statusLabel (s) {
  return { draft: 'Черновик', scheduled: 'Запланирована', sending: 'Отправляется', sent: 'Отправлена', cancelled: 'Остановлена' }[s] || s
}
function formatBroadcastPreview (b) {
  let out = `📨 Предпросмотр:\n\n${b.text.slice(0, 300)}`
  if (b.images?.length) out += `\n\n📷 Изображений: ${b.images.length}`
  if (b.buttons?.length) out += `\n\n🔘 Кнопок: ${b.buttons.length}`
  return out
}
function formatBroadcastDetail (b) {
  let out = `📨 Рассылка #${b.id}\n`
  out += `📅 Статус: ${statusLabel(b.status)}\n`
  out += `📝 Текст: ${b.text?.slice(0, 150) || '(нет)'}${(b.text?.length > 150) ? '...' : ''}\n`
  out += `📷 Изображений: ${b.images?.length || 0}\n`
  out += `🔘 Кнопок: ${b.buttons?.length || 0}\n`
  if (b.scheduled_at) out += `🕐 Запланирована: ${new Date(b.scheduled_at).toLocaleString('ru')}\n`
  return out
}
function parseRussianDate (str) {
  const m = str.match(/^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{1,2}):(\d{2})$/)
  if (!m) return null
  const [, day, month, year, hour, min] = m
  const d = new Date(+year, +month - 1, +day, +hour, +min)
  return isNaN(d.getTime()) ? null : d.getTime()
}
```

**Step 3: Commit**

```bash
git add api/index.js
git commit -m "feat: broadcast stats and helper functions"
```

---

### Task 10: `/process-broadcasts` endpoint

**Files:**
- Modify: `api/index.js`

**Step 1: Add the cron route**

Add BEFORE `app.get('/', ...)`:

```js
app.get('/process-broadcasts', async (c) => {
  const secret = c.req.query('secret')
  if (secret !== process.env.SETUP_SECRET) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const broadcasts = await getScheduledBroadcasts()
  if (!broadcasts.length) {
    return c.json({ message: 'No broadcasts to process' })
  }

  const results = []

  for (const b of broadcasts) {
    try {
      // Mark as sending
      await updateBroadcast(b.id, { status: 'sending' })
      console.log(`[broadcast] ${b.id}: started`)

      // Get all users
      const allUserIds = await (await getKv_()).smembers('users_all')
      const cursor = await getCursor(b.id)
      const batchSize = 20
      const batch = allUserIds.slice(cursor, cursor + batchSize)

      let sentInBatch = 0
      for (const uid of batch) {
        try {
          const alreadySent = await isSent(b.id, uid)
          if (alreadySent) continue

          await sendBroadcastMessage(Number(uid), b)
          await markSent(b.id, uid)
          await markDelivered(b.id, uid)
          sentInBatch++
        } catch (err) {
          console.error(`[broadcast] ${b.id}: ERROR for userId=${uid}: ${err.message}`)
          const failCount = await getFailCount(b.id, uid)
          if (failCount >= 3) {
            await markFailed(b.id, uid)
          }
        }
      }

      const newCursor = cursor + batch.length
      await setCursor(b.id, newCursor)

      if (newCursor >= allUserIds.length) {
        await updateBroadcast(b.id, { status: 'sent' })
        console.log(`[broadcast] ${b.id}: completed (${allUserIds.length} users)`)
      } else {
        console.log(`[broadcast] ${b.id}: progress ${newCursor}/${allUserIds.length}`)
        // Keep status as 'sending', but also keep in scheduled set for next tick
        // Remove and re-add to refresh ZSET
        await updateBroadcast(b.id, { status: 'scheduled', scheduled_at: Date.now() + 1000 })
      }

      results.push({ id: b.id, sent: sentInBatch, cursor: newCursor, total: allUserIds.length })
    } catch (err) {
      console.error(`[broadcast] ${b.id}: fatal error: ${err.message}`)
      results.push({ id: b.id, error: err.message })
    }
  }

  return c.json({ processed: results.length, results })
})
```

**Step 2: Need to export getKv or use getAllUsers from storage**

Add import for `getAllUsers` from `../lib/storage.js`:
```js
import {
  ...,
  getAllUsers
} from '../lib/storage.js'
```

And update the endpoint to use:
```js
const users = await getAllUsers()
const allUserIds = users.map(u => u.user_id)
```

**Step 3: Commit**

```bash
git add api/index.js
git commit -m "feat: add /process-broadcasts cron endpoint"
```

---

### Task 11: Handle `bot_stopped` event for unsub tracking

**Files:**
- Modify: `api/index.js`

**Step 1: Add `bot_stopped` handler in webhook**

In the webhook handler, add:
```js
if (update.update_type === 'bot_stopped') {
  const userId = update.user?.user_id
  if (userId) {
    // Mark user as inactive in storage
    await markInactive(userId)
    // Check all recent broadcasts for unsub tracking
    const recentBroadcasts = await getAllBroadcasts()
    const sevenDaysAgo = Date.now() - 7 * 86400000
    for (const b of recentBroadcasts) {
      if (b.created_at > sevenDaysAgo) {
        const wasSent = await isSent(b.id, userId)
        if (wasSent) {
          await recordUnsub(b.id, userId)
          console.log(`[broadcast] ${b.id}: user ${userId} unsubscribed after broadcast`)
        }
      }
    }
  }
}
```

**Step 2: Import `markInactive` from storage**

Ensure `markInactive` is imported in `api/index.js`.

**Step 3: Commit**

```bash
git add api/index.js
git commit -m "feat: track unsubs after broadcast via bot_stopped event"
```

---

### Task 12: Track opens via user activity

**Files:**
- Modify: `api/index.js`

**Step 1: Add open tracking in `handleMessage` and `handleCallbackQuery`**

After saving/reactivating user in `handleMessage` and `handleCallbackQuery`, add:
```js
// Track broadcast opens
const recentBroadcasts = await getAllBroadcasts()
const window72h = Date.now() - 72 * 3600000
for (const b of recentBroadcasts) {
  if (b.created_at > window72h && (b.status === 'sending' || b.status === 'sent')) {
    const wasSent = await isSent(b.id, userId)
    if (wasSent) {
      await markOpened(b.id, userId)
    }
  }
}
```

**Step 2: Commit**

```bash
git add api/index.js
git commit -m "feat: track broadcast opens via user activity"
```

---

### Task 13: Update `poll.js` for manual trigger

**Files:**
- Modify: `poll.js`
- Read: `poll.js`

**Step 1: Read current `poll.js`**

**Step 2: Add broadcast processing**

Add a call to `/process-broadcasts` with the secret query param, similar to existing polling logic.

**Step 3: Commit**

```bash
git add poll.js
git commit -m "feat: add broadcast trigger to poll.js"
```

---

### Task 14: Vercel Cron configuration

**Files:**
- Modify: `vercel.json`

**Step 1: Add cron job to `vercel.json`**

```json
{
  "crons": [
    {
      "path": "/process-broadcasts?secret=${SETUP_SECRET}",
      "schedule": "* * * * *"
    }
  ]
}
```

Note: Vercel Cron may use a different config format. Check Vercel docs for Hono.js + Vercel Edge cron setup.

**Step 2: Commit**

```bash
git add vercel.json
git commit -m "feat: add Vercel Cron for broadcast processing"
```

---

### Task 15: Integration test and manual verification

**Files:**
- Create: `test/broadcast.test.js`
- Reference: `test/` (existing tests)

**Step 1: Write integration test**

```js
import { createBroadcast, getBroadcast, updateBroadcast, deleteBroadcast, getAllBroadcasts, markSent, isSent, getBroadcastStats } from '../lib/broadcast.js'

// Test basic CRUD
const b = await createBroadcast({ text: 'Test message', created_by: 123 })
console.assert(b.id, 'should have id')
console.assert(b.status === 'draft', 'should be draft')

const got = await getBroadcast(b.id)
console.assert(got.text === 'Test message', 'should have text')

await updateBroadcast(b.id, { text: 'Updated' })
const updated = await getBroadcast(b.id)
console.assert(updated.text === 'Updated', 'should update')

await markSent(b.id, 456)
console.assert(await isSent(b.id, 456), 'should be sent')
console.assert(!(await isSent(b.id, 999)), 'should not be sent')

const stats = await getBroadcastStats(b.id)
console.assert(stats.sent === 1, 'should have 1 sent')

await deleteBroadcast(b.id)
const deleted = await getBroadcast(b.id)
console.assert(!deleted, 'should be deleted')

console.log('All broadcast tests passed')
```

**Step 2: Run test**

```bash
node test/broadcast.test.js
```

Expected: `All broadcast tests passed`

**Step 3: Commit**

```bash
git add test/broadcast.test.js
git commit -m "test: add broadcast integration tests"
```
