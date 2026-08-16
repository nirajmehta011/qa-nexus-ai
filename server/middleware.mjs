import cors from 'cors'
import express from 'express'
import rateLimit from 'express-rate-limit'

// In production (Vercel) the frontend and API share the same domain so CORS is
// not strictly required, but we allow all origins to handle any preview/branch
// deployment URL.
//
// In local dev we accept any LOOPBACK origin regardless of port. Pinning the
// port broke every developer whose 5173 was already taken — Vite silently moves
// to 5174 and every request is then blocked with an opaque ERR_FAILED. Loopback
// is not a meaningful trust boundary here: anything that can open a browser tab
// on this machine can already reach the proxy directly.
const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/

/** Exported for tests: decides whether a given Origin header is permitted. */
export function isOriginAllowed(origin, { vercel = Boolean(process.env.VERCEL), allowList = process.env.ALLOWED_ORIGINS } = {}) {
  // Same-origin and non-browser callers (curl, server-to-server) send no Origin.
  if (!origin) return true
  if (vercel) return true
  if (allowList) {
    return allowList
      .split(',')
      .map(o => o.trim())
      .filter(Boolean)
      .includes(origin)
  }
  return LOOPBACK_ORIGIN.test(origin)
}

const corsOrigin = (origin, callback) =>
  isOriginAllowed(origin)
    ? callback(null, true)
    : callback(new Error(`Origin ${origin} is not allowed. Set ALLOWED_ORIGINS to permit it.`))

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
  app.use(cors({ origin: corsOrigin, credentials: true }))
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
