import { describe, it, expect } from 'vitest'
import { extractErrorMessage, safeErrorField } from './errorUtils'

describe('extractErrorMessage', () => {
  it('extracts a plain string error from response.data.error', () => {
    const err = { response: { data: { error: 'Invalid API key' } } }
    expect(extractErrorMessage(err)).toBe('Invalid API key')
  })

  it('never returns "[object Object]" when response.data.error is an object', () => {
    // Vercel's platform-level failure shape: {"error": {"code": "...", "message": "...", "requestId": "..."}}
    const err = { response: { data: { error: { code: 'FUNCTION_INVOCATION_FAILED', message: 'A server error has occurred', requestId: 'abc123' } } } }
    const result = extractErrorMessage(err)
    expect(result).toBe('A server error has occurred')
    expect(result).not.toContain('[object Object]')
  })

  it('falls back to response.data.message when .error is missing', () => {
    const err = { response: { data: { message: 'Bad gateway' } } }
    expect(extractErrorMessage(err)).toBe('Bad gateway')
  })

  it('falls back to error.message when response.data is absent', () => {
    const err = { message: 'Network Error' }
    expect(extractErrorMessage(err)).toBe('Network Error')
  })

  it('falls back to the provided default when nothing usable is found', () => {
    const err = { response: { data: { code: 500 } } }
    expect(extractErrorMessage(err, 'Connection failed')).toBe('Connection failed')
  })

  it('handles a completely empty/undefined error without throwing', () => {
    expect(extractErrorMessage(undefined, 'fallback')).toBe('fallback')
    expect(extractErrorMessage(null, 'fallback')).toBe('fallback')
    expect(extractErrorMessage({}, 'fallback')).toBe('fallback')
  })

  it('ignores blank/whitespace-only string candidates', () => {
    const err = { response: { data: { error: '   ' } }, message: 'real message' }
    expect(extractErrorMessage(err)).toBe('real message')
  })
})

describe('safeErrorField', () => {
  it('extracts a plain string error field', () => {
    expect(safeErrorField({ error: 'Failed to fetch from Figma' }, 'fallback')).toBe('Failed to fetch from Figma')
  })

  it('never returns an object rendered as text', () => {
    const body = { error: { message: 'nested message' } }
    expect(safeErrorField(body, 'fallback')).toBe('nested message')
  })

  it('falls back when the body has no usable string', () => {
    expect(safeErrorField({}, 'Failed to fetch from Figma')).toBe('Failed to fetch from Figma')
    expect(safeErrorField(null, 'fallback')).toBe('fallback')
  })
})
