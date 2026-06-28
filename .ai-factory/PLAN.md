# План: Закрытие дыр в статистике рассылок

Ветка: main | Дата: 2026-06-28

## Settings

- **Тестирование:** да
- **Логирование:** verbose (DEBUG)
- **Документация:** warn-only

## Research Context

Тема: Закрытие дыр в статистике рассылок
Цель: Исправить три пробела в сборе и отображении статистики broadcast

Ограничения:
- Не менять структуру хранения broadcast в KV (key layout уже устоялся)
- Статистика должна обновляться в реальном времени (никаких фоновых пересчётов)
- Не ломать существующий flow черновиков и отправки

Решения:
- Дыра 1 (markFailed): вызывать при ошибках отправки в process-broadcasts + first batch
- Дыра 2 (итоговая сводка): после status='sent' отправлять админу сообщение с sent/opened/unsubbed
- Дыра 3 (агрегация): новый callback stats_broadcasts_overall — общий охват, средний open rate, отписки
- Итоговая сводка отправляется только created_by (не всем админам)
- Агрегация вычисляется на лету (без отдельной KV-записи), по всем рассылкам без лимита

Сигналы успеха:
- markFailed вызывается при ошибках отправки, scard :failed растёт
- После завершения рассылки админ получает сообщение со статистикой
- Появляется кнопка «📊 Общая статистика рассылок» с агрегированными цифрами

## Tasks

### Этап 1: markFailed — фиксация ошибок отправки

- [x] **Task 1: Вызов markFailed при ошибках отправки рассылки**

  Файл: `api/index.js` (2 локации)

  **Локация A — первый батч (broadcast_confirm_now, строка 670):**
  В блоке `catch (err)` после `console.error` добавить:
  ```js
  await markFailed(bid, user.user_id).catch(() => {})
  ```
  Затем `break` (как сейчас), курсор не продвигается — сообщение будет переотправлено при следующем тике.

  **Локация B — цепной батч (process-broadcasts, строка 963):**
  В блоке `catch (err)` после `console.error` добавить:
  ```js
  await markFailed(b.id, user.user_id).catch(() => {})
  ```
  Логика та же: курсор не продвигается, переотправка на следующем тике.

  Логирование: `alog('INFO', 'broadcast %s: markFailed userId=%d', bid/b.id, user.user_id)`

  **Проверка:** после ошибки отправки `scard(broadcast:<id>:failed)` возвращает 1.

### Этап 2: Итоговая сводка после завершения

- [x] **Task 2: Сообщение со статистикой при статусе sent**

  Файл: `api/index.js` (2 локации)

  Импорт: убедиться что `getBroadcastStats` и `createBroadcast` уже импортируются. `getBroadcastStats` уже есть в импорте (строка 23).

  **Локация A — первый батч завершён (broadcast_confirm_now, строка 679-685):**
  После `await updateBroadcast(bid, { status: 'sent' })` и перед `console.log`, получить `getBroadcastStats`, сформировать и отправить сообщение создателю:
  ```js
  const finalStats = await getBroadcastStats(bid)
  const totalUsers = await getUserCount()
  const openPct = finalStats.sent ? Math.round(finalStats.opened / finalStats.sent * 100) : 0
  const unsubPct = finalStats.sent ? Math.round(finalStats.unsubbed / finalStats.sent * 100) : 0
  const summaryMsg = `✅ Рассылка #${bid} завершена!\n\n` +
    `📤 Отправлено: ${finalStats.sent} / ${totalUsers}\n` +
    `👁 Открыто: ${finalStats.opened} (${openPct}%)\n` +
    `🚫 Отписалось: ${finalStats.unsubbed} (${unsubPct}%)\n` +
    `❌ Ошибок: ${finalStats.failed}`
  await sendMessage(b.created_by, summaryMsg)
  ```
  Существующий `sendMessage(chatId, ...)` в ответе админу — оставить.

  **Локация B — цепной батч завершён (process-broadcasts, строка 972-973):**
  Аналогично: после `await updateBroadcast(b.id, { status: 'sent' })` отправить сводку `b.created_by`.

  Логирование: `alog('INFO', 'broadcast %s: sent summary to creator=%d, stats=%j', bid, b.created_by, finalStats)`

  **Проверка:** после завершения рассылки создатель получает сообщение со статистикой.

### Этап 3: Агрегированная статистика по всем рассылкам

- [x] **Task 3: Общая статистика рассылок — callback + кнопка**

  Файл: `api/index.js`

  **3a. Новый callback `stats_broadcasts_overall`:**
  В `handleCallbackQuery` добавить обработку:
  ```js
  if (cb.payload === 'stats_broadcasts_overall') {
    const all = await getAllBroadcasts()
    let totalSent = 0, totalOpened = 0, totalUnsubbed = 0, totalFailed = 0, count = 0
    for (const b of all) {
      const s = await getBroadcastStats(b.id)
      totalSent += s.sent
      totalOpened += s.opened
      totalUnsubbed += s.unsubbed
      totalFailed += s.failed
      if (s.sent > 0) count++
    }
    const avgOpenPct = totalSent ? Math.round(totalOpened / totalSent * 100) : 0
    let msg = '📊 Общая статистика рассылок\n\n'
    msg += `📨 Всего рассылок с отправкой: ${count}\n`
    msg += `📤 Всего отправлено сообщений: ${totalSent}\n`
    msg += `👁 Всего открытий: ${totalOpened} (средний ${avgOpenPct}%)\n`
    msg += `🚫 Всего отписок: ${totalUnsubbed}\n`
    msg += `❌ Всего ошибок: ${totalFailed}`
    return sendMessageWithKeyboard(chatId, msg, [
      [{ type: 'callback', text: '🔙 Назад', data: 'back' }]
    ])
  }
  ```

  **3b. Кнопка в меню статистики:**
  В обработчик `cb.payload === 'stats'` (строка 516) добавить кнопку:
  ```js
  [{ type: 'callback', text: '📨 Рассылки', data: 'stats_broadcasts_overall' }],
  ```
  Разместить после `stats_top`, перед `back`.

  Логирование: `alog('DEBUG', 'stats_broadcasts_overall: all=%d, withSent=%d, totalSent=%d', all.length, count, totalSent)`

  **Проверка:** в меню Статистика → «📨 Рассылки» показывает агрегированные цифры.

### Этап 4: Тесты

- [x] **Task 4: Тесты на статистику рассылок**

  Файл: `test/broadcast-stats.test.js` (новый)

  Добавить тесты в существующий `describe('Broadcast tracking')` в `test/broadcast.test.js` (расширить существующий файл, не создавать новый):

  1. **markFailed:**
     - Создать broadcast, вызвать `markFailed(b.id, userId)`, проверить что `scard(:failed)` = 1
     - Дважды вызвать `markFailed` для одного userId — всё ещё 1 (set)
     - Два разных userId — `scard(:failed)` = 2

  2. **getBroadcastStats после markFailed:**
     - `markSent` + `markDelivered` + `markOpened` + `markUnsubbed` + `markFailed` для разных userId
     - `getBroadcastStats` возвращает `{ sent: 1, delivered: 1, opened: 1, unsubbed: 1, failed: 1 }`

  3. **Агрегация (unit-тест на уровне KV):**
     - Создать 2 broadcast, наполнить разной статистикой
     - Вызвать `getBroadcastStats` для каждого и просуммировать — проверить что сумма корректна

  Логирование: `console.log` в тестах по необходимости.

## Commit Plan

Менее 5 задач — все изменения в одном коммите в конце.

Сообщение коммита:
```
fix: закрыть дыры в статистике рассылок (markFailed, сводка, агрегация)

- markFailed вызывается при ошибках отправки в first/chain batch
- итоговая сводка со статистикой отправляется создателю при status=sent
- добавлена агрегированная статистика по всем рассылкам в меню
- тесты на markFailed, getBroadcastStats и агрегацию
```
