// Safely extracts a human-readable string from an axios/fetch error, no
// matter what shape the server (or the platform in front of it) responds
// with. Without this, error.response.data.error can be an object — e.g.
// Vercel's own platform-level failure JSON is {"error": {"code": "...",
// "message": "...", "requestId": "..."}} — and interpolating an object
// into a template literal silently renders "[object Object]" in the UI.
export function extractErrorMessage(error: any, fallback = 'Something went wrong'): string {
  const data = error?.response?.data
  const candidates = [data?.error, data?.message, data]

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate
    if (candidate && typeof candidate === 'object') {
      if (typeof candidate.message === 'string' && candidate.message.trim()) return candidate.message
      if (typeof candidate.error === 'string' && candidate.error.trim()) return candidate.error
    }
  }

  if (typeof error?.message === 'string' && error.message.trim()) return error.message
  return fallback
}

// Same defensive extraction for a manually-parsed fetch() JSON error body
// (raw {error, message} object rather than an axios error wrapper).
export function safeErrorField(body: any, fallback: string): string {
  if (typeof body?.error === 'string' && body.error.trim()) return body.error
  if (typeof body?.message === 'string' && body.message.trim()) return body.message
  if (body?.error && typeof body.error === 'object' && typeof body.error.message === 'string') return body.error.message
  return fallback
}
