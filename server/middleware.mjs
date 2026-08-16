import cors from 'cors'
import express from 'express'
import rateLimit from 'express-rate-limit'

// In production (Vercel) the frontend and API share the same domain so
// CORS is not strictly required, but we allow all origins to handle any
// preview/branch deployment URL. In local dev we restrict to known ports.
const allowedOrigins = process.env.VERCEL
  ? true // allow all origins on Vercel (same-domain or preview URLs)
  : ['http://localhost:5173', 'http://localhost:3000', 'http://127.0.0.1:5173']

// Per-IP abuse protection. On Vercel each lambda instance keeps its own
// counters, so limits are approximate there — acceptable until auth lands.
export const apiLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests – please slow down and try again in a minute.' }
})

export const completeLimiter = process.env.DISABLE_RATE_LIMIT === '1'
  ? (req, res, next) => next()
  : rateLimit({
      windowMs: 60_000,
      limit: 10,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'Too many generation requests – please wait a minute before retrying.' }
    })

export function applyMiddleware(app) {
  app.set('trust proxy', 1)
  app.use(cors({ origin: allowedOrigins, credentials: true }))
  app.use(express.json({ limit: '15mb' }))
  app.use(express.urlencoded({ limit: '15mb', extended: true }))
  // DISABLE_RATE_LIMIT=1 is for local eval runs only – never set it in production.
  if (process.env.DISABLE_RATE_LIMIT !== '1') {
    app.use('/api', apiLimiter)
  }
}

export function applyErrorHandler(app) {
  app.use((err, req, res, _next) => {
    console.error('Unhandled error:', err)
    res.status(500).json({ error: 'Internal server error' })
  })
}
