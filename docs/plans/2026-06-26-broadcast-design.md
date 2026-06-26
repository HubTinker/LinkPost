# Broadcast — дизайн функции рассылки

> Утверждён: 26.06.2026

## Обзор

Функция позволяет админам создавать, редактировать, удалять и отправлять рассылки пользователям бота. Поддерживается немедленная и отложенная отправка. Собирается обратная связь: сколько отправлено, сколько открыто, сколько отписалось после рассылки.

## Выбранный подход

**Вариант A — «Очередь в KV + пакетная отправка»**

Vercel Cron каждую минуту вызывает эндпоинт `/process-broadcasts`, который забирает из KV ближайшие рассылки и отправляет пачками по 20 пользователей. Прогресс сохраняется в KV между тиками. `poll.js` используется как запасной/ручной вариант.

## Модель данных (Vercel KV)

### Метаданные рассылки

```
broadcast:<id> → JSON {
  id, title, text,
  images: [file_id, ...],
  buttons: [{text, url}, ...],
  format: "markdown" | "plain",
  status: "draft" | "scheduled" | "sending" | "sent" | "cancelled",
  scheduled_at: timestamp | null,
  created_at, created_by
}
```

- `broadcasts:all` — Set всех ID рассылок
- `broadcasts:scheduled` — Sorted Set по `scheduled_at` (ZSET, для выборки ближайших)

### Состояние отправки

```
broadcast:<id>:sent      — Set userId (кому ушло сообщение)
broadcast:<id>:delivered — Set userId (подтверждена доставка)
broadcast:<id>:opened    — Set userId (открыли / были активны после)
broadcast:<id>:unsubbed  — Set userId (отписались после)
broadcast:<id>:failed    — Set userId (неудачные попытки после 3 ретраев)
```

### Прогресс

```
broadcast:<id>:cursor — number, индекс последнего обработанного пользователя в users_all
```

### TTL и очистка

- Set-ы прогресса: 90 дней (аналогично `STATS_TTL`)
- Метаданные: хранятся постоянно
- При удалении рассылки — каскадное удаление всех связанных ключей

## Команды и интерфейс

### Меню рассылок

Кнопка «📨 Рассылка» в главном меню админа ведёт в подменю:

```
📨 Рассылка
├── 📝 Новая рассылка
├── 📋 Список рассылок
│   ├── ✏️ Редактировать (только draft)
│   ├── ❌ Удалить
│   └── 📊 Статистика
└── 🔙 Назад
```

### Пошаговое создание рассылки

1. **Текст** — админ вводит Markdown-текст
2. **Изображения** — админ отправляет фото, бот загружает их через MAX file API, получает file_id. Кнопка «Готово» для перехода
3. **Кнопки** — админ присылает строки `Текст кнопки | https://url`. До 5 кнопок
4. **Расписание** — «Отправить сейчас» или «Запланировать» (ввод даты/времени `26.06.2026 18:00`)
5. **Подтверждение** — превью сообщения + «✅ Отправить» / «✏️ Редактировать» / «❌ Отмена»

### Редактирование и удаление

- Редактировать можно только рассылки в статусе `draft`
- При `sending` редактирование заблокировано
- Удаление — каскадное, с подтверждением

## Процесс отправки

### Cron-эндпоинт `/process-broadcasts`

Вызывается Vercel Cron каждую минуту (GET, требует `?secret=`). Алгоритм:

```
1. ZRANGEBYSCORE broadcasts:scheduled 0 NOW → все рассылки, чьё время пришло
2. Для каждой:
   ├── status = "sending"
   ├── Загружаем users_all → все userId
   ├── Вычитаем broadcast:<id>:sent → только новые получатели
   ├── Берём пачку из 20 пользователей
   ├── Для каждого: sendBroadcastMessage(...)
   │   ├── Успех → добавляем в sent-Set
   │   └── Ошибка → ретрай на следующем тике (до 3 попыток, затем в failed-Set)
   ├── Обновляем broadcast:<id>:cursor
   └── Если все обработаны → status = "sent"
```

### Отправка «сейчас»

Админ жмёт «Отправить сейчас» → `scheduled_at = Date.now()`, `status = "scheduled"`. Cron (≤60 сек) подхватывает.

### Остановка и возобновление

- «⏸ Остановить» → `status = "cancelled"`
- «▶️ Возобновить» → `status = "scheduled"`, Cron снова подхватит

### `poll.js`

Расширяется для ручного вызова `/process-broadcasts` — для тестирования и дебага.

## Сбор обратной связи

| Метрика | Как собирается |
|---------|---------------|
| Отправлено | При успешном `sendBroadcastMessage()` → `broadcast:<id>:sent` |
| Доставлено | При `ok: true` от MAX API → `broadcast:<id>:delivered` |
| Открыто | Если пользователь из `sent`-Set совершил любое действие в боте в течение 72ч → `broadcast:<id>:opened` |
| Отписалось | При получении `bot_stopped` от MAX API, если userId в `sent`-Set за 7 дней → `broadcast:<id>:unsubbed` |

### Вывод статистики

```
📊 Статистика рассылки #br_xxx

📝 Текст: Друзья, новый канал...
📅 Отправлена: 25.06.2026 18:00

✅ Отправлено:   1240
👁 Открыто:       847 (68%)
🚫 Отписалось:     12 (1.0%)
```

## API и файлы

### Новый файл: `lib/broadcast.js`

Функции работы с KV-ключами рассылок:

- `createBroadcast(data)`, `getBroadcast(id)`, `updateBroadcast(id, patch)`, `deleteBroadcast(id)`
- `getAllBroadcasts()`, `getScheduledBroadcasts()`
- `markSent(bid, uid)`, `markDelivered(bid, uid)`, `markOpened(bid, uid)`, `recordUnsub(bid, uid)`
- `getBroadcastStats(id)` → `{sent, delivered, opened, unsubbed}`
- `getBroadcastProgress(id)` → `{processed, total, percent}`

### Новые роуты в `api/index.js`

| Метод | Путь | Назначение |
|-------|------|------------|
| GET | `/process-broadcasts` | Cron-эндпоинт, требует `?secret=` |

### Расширение `lib/max-api.js`

- `sendBroadcastMessage(chatId, broadcast)` — отправка полного сообщения (текст + изображения + inline_keyboard)
- `uploadFile(fileBuffer, filename)` — загрузка файла через MAX file API, возвращает `file_id`

### Расширение `api/index.js`

- Новые callback-обработчики: `broadcast`, `broadcast_create`, `broadcast_list`, `broadcast_edit`, `broadcast_delete`, `broadcast_stats`, `broadcast_send_now`, `broadcast_schedule`, `broadcast_stop`, `broadcast_resume`
- Обработка `bot_stopped` в webhook (для метрики отписок)

### Расширение `poll.js`

- Добавить вызов `/process-broadcasts?secret=...` для ручного запуска

## Обработка ошибок

- **Ошибка MAX API на userId**: логируем, пропускаем, ретрай до 3 раз, затем в `failed`-Set
- **Таймаут Vercel Edge**: курсор сохраняется, следующий тик продолжит
- **Дубли**: проверка `SISMEMBER broadcast:<id>:sent` перед отправкой
- **Гонка Cron-тиков**: Vercel гарантирует 1 экземпляр. `poll.js` — только вручную
- **Мониторинг**: логи `[broadcast] br_xxx: started/progress/completed/ERROR`

## Ограничения

- Размер пачки: 20 пользователей за тик (≈1 тик в минуту)
- При 1200 пользователях: ~60 тиков = ~60 минут на полную рассылку
- Кнопок: до 5
- Изображений: до 5
- Текст сообщения: до 4096 символов
