import express from 'express'
import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'

// Load app/.env first, then the repo-root .env (existing values win)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(__dirname, '.env') })
dotenv.config({ path: path.join(__dirname, '..', '.env') })

import { applyMiddleware, applyErrorHandler } from './server/middleware.mjs'
import miscRouter from './server/misc.mjs'
import providersRouter from './server/providers.mjs'
import rulesRouter from './server/rules.mjs'

const app = express()
const PORT = process.env.BACKEND_PORT || 3001

applyMiddleware(app)

app.use(miscRouter)
app.use(providersRouter)
app.use(rulesRouter)

applyErrorHandler(app)

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`\n🚀 QA Nexus Backend proxy server running on http://localhost:${PORT}`)
    console.log(`📍 Frontend should be running on http://localhost:5173`)
    console.log(`✅ Providers supported: Groq | OpenRouter | Gemini | OpenAI\n`)
  })
}

export default app
