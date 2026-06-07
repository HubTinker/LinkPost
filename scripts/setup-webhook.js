/**
 * Альтернативный способ регистрации webhook через CLI.
 *
 * Использование:
 *   BOT_TOKEN=xxx WEBHOOK_URL=https://your-app.vercel.app/webhook node scripts/setup-webhook.js
 *
 * Или через браузер (проще):
 *   https://your-app.vercel.app/setup-webhook?secret=ВАШ_SETUP_SECRET
 */

const { BOT_TOKEN, WEBHOOK_URL } = process.env

if (!BOT_TOKEN || !WEBHOOK_URL) {
  console.error('❌ Нужны переменные: BOT_TOKEN и WEBHOOK_URL')
  process.exit(1)
}

const res = await fetch('https://platform-api.max.ru/subscriptions', {
  method: 'POST',
  headers: {
    Authorization: BOT_TOKEN,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    url: WEBHOOK_URL,
    update_types: ['bot_started', 'message_created']
  })
})

const data = await res.json()
console.log('Ответ MAX API:', JSON.stringify(data, null, 2))
console.log(data.success ? '✅ Webhook зарегистрирован!' : '❌ Ошибка регистрации')
