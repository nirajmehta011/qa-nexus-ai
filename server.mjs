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
  const server = app.listen(PORT, () => {
    console.log(`\n🚀 QA Nexus Backend proxy server running on http://localhost:${PORT}`)
    console.log(`📍 Frontend should be running on http://localhost:5173`)
    console.log(`✅ Providers supported: Groq | OpenRouter | Gemini | OpenAI\n`)
  })

  // A busy port is the most common local failure and the raw Node stack trace
  // explains none of it — say what happened and how to get moving.
  server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `\n❌ Port ${PORT} is already in use — another app is holding it.\n` +
        `   Start QA Nexus on free ports instead, e.g.:\n\n` +
        `     BACKEND_PORT=3101 VITE_API_URL=http://localhost:3101/api npm run dev:full\n\n` +
        `   (VITE_API_URL must match BACKEND_PORT, or the browser will call the wrong server.)\n`
      )
      process.exit(1)
    }
    throw err
  })
}

export default app
