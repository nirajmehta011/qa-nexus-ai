import express from 'express'
import axios from 'axios'
import { completeLimiter } from './middleware.mjs'

const router = express.Router()

// Vercel functions are capped at 60s (vercel.json maxDuration) – upstream
// calls must give up before the platform kills the request.
const LLM_TIMEOUT_MS = 55_000

// Clamp client-supplied generation params to safe ranges.
export function clampGenParams(body) {
  const t = Number(body.temperature)
  const temperature = Number.isFinite(t) ? Math.min(Math.max(t, 0), 1) : 0.7
  const m = Number(body.maxTokens)
  const maxTokens = Number.isFinite(m) ? Math.min(Math.max(Math.floor(m), 1), 8000) : 4000
  const json = body.responseFormat === 'json'
  return { temperature, maxTokens, json }
}

function providerError(res, error, providerName) {
  const e = error
  if (e.response?.status === 401) return res.status(401).json({ error: `${providerName} authentication failed` })
  if (e.response?.status === 429) {
    const retryAfter = e.response.headers?.['retry-after']
    if (retryAfter) res.set('Retry-After', String(retryAfter))
    return res.status(429).json({ error: `${providerName} rate limited – try again later` })
  }
  if (e.code === 'ECONNABORTED') return res.status(504).json({ error: `${providerName} request timed out after ${LLM_TIMEOUT_MS / 1000}s` })
  res.status(500).json({ error: e.response?.data?.error?.message || e.message || 'Unknown error' })
}

function openAIStyleComplete({ providerName, url, buildHeaders }) {
  return async (req, res) => {
    try {
      const { apiKey, model, messages } = req.body
      if (!apiKey || !model || !messages) return res.status(400).json({ error: 'Missing required parameters' })

      const { temperature, maxTokens, json } = clampGenParams(req.body)
      const payload = { model, messages, temperature, max_tokens: maxTokens }
      if (json) payload.response_format = { type: 'json_object' }

      let response
      try {
        response = await axios.post(url, payload, { headers: buildHeaders(apiKey), timeout: LLM_TIMEOUT_MS })
      } catch (err) {
        // Some models reject response_format – retry once without it.
        if (json && err.response?.status === 400) {
          delete payload.response_format
          response = await axios.post(url, payload, { headers: buildHeaders(apiKey), timeout: LLM_TIMEOUT_MS })
        } else {
          throw err
        }
      }
      res.json({ success: true, content: response.data.choices[0].message.content })
    } catch (error) {
      providerError(res, error, providerName)
    }
  }
}

// ─────────────────────────────── GROQ ────────────────────────────────────────
router.post('/api/groq/models', async (req, res) => {
  try {
    const { apiKey } = req.body
    if (!apiKey) return res.status(400).json({ error: 'Missing API key' })

    const response = await axios.get('https://api.groq.com/openai/v1/models', {
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json' },
      timeout: 10000
    })
    const models = (response.data.data || []).map(m => ({ id: m.id, name: m.id }))
    res.json({ success: true, models })
  } catch (error) {
    if (error.response?.status === 401) return res.status(401).json({ error: 'Groq authentication failed – check API key' })
    providerError(res, error, 'Groq')
  }
})

router.post('/api/groq/complete', completeLimiter, openAIStyleComplete({
  providerName: 'Groq',
  url: 'https://api.groq.com/openai/v1/chat/completions',
  buildHeaders: (apiKey) => ({ 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' })
}))

// ─────────────────────────────── OPENROUTER ──────────────────────────────────
router.post('/api/openrouter/models', async (req, res) => {
  try {
    const { apiKey } = req.body
    if (!apiKey) return res.status(400).json({ error: 'Missing API key' })

    const response = await axios.get('https://openrouter.ai/api/v1/models', {
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json' },
      timeout: 10000
    })
    const models = (response.data.data || [])
      .slice(0, 50) // limit to top 50
      .map(m => ({ id: m.id, name: m.name || m.id }))
    res.json({ success: true, models })
  } catch (error) {
    if (error.response?.status === 401) return res.status(401).json({ error: 'OpenRouter authentication failed – check API key' })
    providerError(res, error, 'OpenRouter')
  }
})

router.post('/api/openrouter/complete', completeLimiter, openAIStyleComplete({
  providerName: 'OpenRouter',
  url: 'https://openrouter.ai/api/v1/chat/completions',
  buildHeaders: (apiKey) => ({
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': 'http://localhost:5173',
    'X-Title': 'QA Nexus'
  })
}))

// ─────────────────────────────── GEMINI ──────────────────────────────────────
router.post('/api/gemini/models', async (req, res) => {
  try {
    const { apiKey } = req.body
    if (!apiKey) return res.status(400).json({ error: 'Missing API key' })

    const response = await axios.get(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
      { timeout: 10000 }
    )
    const models = (response.data.models || [])
      .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
      .map(m => ({ id: m.name.replace('models/', ''), name: m.displayName || m.name }))
    res.json({ success: true, models })
  } catch (error) {
    if (error.response?.status === 400 || error.response?.status === 403) {
      return res.status(401).json({ error: 'Gemini authentication failed – check API key' })
    }
    providerError(res, error, 'Gemini')
  }
})

// Convert OpenAI-style messages (string or multimodal parts) to Gemini contents.
export function toGeminiContents(messages) {
  const contents = []
  for (const msg of messages) {
    const role = msg.role === 'assistant' ? 'model' : 'user'
    const parts = []

    if (typeof msg.content === 'string') {
      parts.push({ text: msg.content })
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === 'text') {
          parts.push({ text: part.text })
        } else if (part.type === 'image_url') {
          const url = part.image_url?.url || ''
          const match = url.match(/^data:([^;]+);base64,(.+)$/)
          if (match) {
            parts.push({ inlineData: { mimeType: match[1], data: match[2] } })
          }
        } else if (part.type === 'inline_data') {
          parts.push({ inlineData: { mimeType: part.mimeType, data: part.data } })
        }
      }
    }
    contents.push({ role, parts })
  }
  return contents
}

router.post('/api/gemini/complete', completeLimiter, async (req, res) => {
  try {
    const { apiKey, model, messages } = req.body
    if (!apiKey || !model || !messages) return res.status(400).json({ error: 'Missing required parameters' })

    const { temperature, maxTokens, json } = clampGenParams(req.body)
    const generationConfig = { temperature, maxOutputTokens: maxTokens }
    if (json) generationConfig.responseMimeType = 'application/json'

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      { contents: toGeminiContents(messages), generationConfig },
      { timeout: LLM_TIMEOUT_MS }
    )
    const content = response.data.candidates?.[0]?.content?.parts?.[0]?.text || ''
    res.json({ success: true, content })
  } catch (error) {
    if (error.response?.status === 400 || error.response?.status === 403) {
      return res.status(401).json({ error: 'Gemini authentication failed' })
    }
    providerError(res, error, 'Gemini')
  }
})

// ─────────────────────────────── OPENAI ──────────────────────────────────────
router.post('/api/openai/models', async (req, res) => {
  try {
    const { apiKey } = req.body
    if (!apiKey) return res.status(400).json({ error: 'Missing API key' })

    const response = await axios.get('https://api.openai.com/v1/models', {
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json' },
      timeout: 10000
    })
    const models = (response.data.data || [])
      .filter(m => m.id.startsWith('gpt'))
      .sort((a, b) => b.created - a.created)
      .slice(0, 20)
      .map(m => ({ id: m.id, name: m.id }))
    res.json({ success: true, models })
  } catch (error) {
    if (error.response?.status === 401) return res.status(401).json({ error: 'OpenAI authentication failed – check API key' })
    providerError(res, error, 'OpenAI')
  }
})

router.post('/api/openai/complete', completeLimiter, openAIStyleComplete({
  providerName: 'OpenAI',
  url: 'https://api.openai.com/v1/chat/completions',
  buildHeaders: (apiKey) => ({ 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' })
}))

export default router
