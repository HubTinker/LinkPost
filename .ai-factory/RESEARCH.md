# Research

Updated: 2026-06-28 12:00
Status: active

## Active Summary (input for /aif-plan)
<!-- aif:active-summary:start -->
Topic: Закрытие дыр в статистике рассылок
Goal: Исправить три пробела в сборе и отображении статистики broadcast
Constraints:
  - Не менять структуру хранения broadcast в KV (key layout уже устоялся)
  - Статистика должна обновляться в реальном времени (никаких фоновых пересчётов)
  - Не ломать существующий flow черновиков и отправки
Decisions:
  - Дыра 1 (markFailed): вызывать при ошибках отправки в process-broadcasts + first batch
  - Дыра 2 (итоговая сводка): после status='sent' отправлять админу сообщение с sent/opened/unsubbed
  - Дыра 3 (агрегация): новый callback stats_broadcasts_overall — общий охват, средний open rate, отписки
Open questions:
  - Кому слать итоговую сводку? Только created_by или всем админам?
  - Нужен ли лимит на кол-во рассылок в агрегированной статистике (все / последние 30 дней)?
  - Делать ли агрегацию через отдельную KV-запись или вычислять на лету?
Success signals:
  - markFailed вызывается при ошибках отправки, scard :failed растёт
  - После завершения рассылки админ получает сообщение со статистикой
  - Появляется кнопка «📊 Общая статистика рассылок» с агрегированными цифрами
Next step: /aif-plan fast для реализации дыр в api/index.js и lib/broadcast.js
<!-- aif:active-summary:end -->

## Sessions
<!-- aif:sessions:start -->

### 2026-06-07 18:10 — Аудит реализации LinkPost
What changed:
  - Проанализированы: api/index.js, lib/storage.js, lib/max-api.js, server.js, poll.js, test/*.test.js
  - Сверены 6 функций из DESCRIPTION.md с кодом — все реализованы
  - Найдены проблемы: отсутствует kv-mock.js (краш при локальном запуске), 6 остаточных [FIX] логов, нет тестов на бизнес-логику
Key notes:
  - kv-mock.js импортируется в lib/storage.js:2 но не существует в проекте
  - [FIX] логи разбросаны по api/index.js и lib/max-api.js (всего 6 штук)
  - Тесты handler.test.js и max-api.test.js проверяют только защиту от undefined chatId
  - getAllLinks() через KV.keys() — потенциально хрупко на больших объёмах
  - .env.local содержит реальный BOT_TOKEN (git не инициализирован — пока безопасно)
Links (paths):
  - api/index.js
  - lib/storage.js
  - lib/max-api.js
  - test/handler.test.js
  - test/max-api.test.js
  - .ai-factory/patches/2026-06-07-17.40.md

### 2026-06-28 12:00 — Дыры в статистике рассылок
What changed:
  - Найдены три пробела в сборе/отображении статистики broadcast
  - Дыра 1: markFailed() объявлен в lib/broadcast.js:142 но нигде не вызывается — ошибки отправки теряются
  - Дыра 2: при status='sent' админ видит только «завершена» без итоговых цифр (sent/opened/unsubbed)
  - Дыра 3: нет агрегированной статистики по всем рассылкам — нет кнопки «общий охват / средний open rate»
Key notes:
  - Статистика собирается через scard на :sent, :delivered, :opened, :unsubbed, :failed сетах
  - open-tracking: 72ч окно в handleMessage/handleCallback; unsub-tracking: 7д окно в bot_stopped
  - delivered ≈ sent всегда (оптимистичная запись) — MAX API не даёт delivery receipts
  - Статистика доступна через drill-down (broadcast_view → broadcast_stats) но не проактивно
  - markFailed ни разу не вызывается в api/index.js при catch в process-broadcasts и first batch
Links (paths):
  - lib/broadcast.js (stats sets, markSent/Delivered/Opened/Unsubbed/Failed, getBroadcastStats)
  - api/index.js:649-699 (broadcast_confirm_now — first batch без markFailed)
  - api/index.js:925-994 (process-broadcasts — chain batch без markFailed)
  - api/index.js:737-758 (broadcast_stats callback — существующее отображение)
  - api/index.js:190-205 (open tracking в handleMessage)
  - api/index.js:884-899 (unsub tracking в bot_stopped)
<!-- aif:sessions:end -->
