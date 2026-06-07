import dotenv from 'dotenv'
import { serve } from '@hono/node-server'
import { app } from '../api/index.js'
dotenv.config({ path: '.env.local' })

const port = parseInt(process.env.PORT ?? '3000', 10)

serve({ fetch: app.fetch, port }, () => {
  console.log(`🚀 LinkPost Bot запущен на http://localhost:${port}`)
  console.log(`📡 Webhook эндпоинт: POST http://localhost:${port}/webhook`)
  console.log(`🔧 Setup webhook: GET http://localhost:${port}/setup-webhook?secret=${process.env.SETUP_SECRET ?? '(не задан)'}`)
})
