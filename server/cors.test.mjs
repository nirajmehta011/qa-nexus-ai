import { describe, it, expect } from 'vitest'
import { isOriginAllowed } from './middleware.mjs'

// Pinning dev CORS to port 5173 silently broke anyone whose 5173 was taken:
// Vite moves to 5174 and every request fails with an opaque ERR_FAILED.

describe('isOriginAllowed (local dev)', () => {
  const dev = { vercel: false, allowList: undefined }

  it('allows loopback on any port', () => {
    for (const origin of [
      'http://localhost:5173',
      'http://localhost:5174',
      'http://localhost:5175',
      'http://127.0.0.1:4321',
      'http://[::1]:5173',
      'http://localhost'
    ]) {
      expect(isOriginAllowed(origin, dev), origin).toBe(true)
    }
  })

  it('allows requests with no Origin header (curl, server-to-server)', () => {
    expect(isOriginAllowed(undefined, dev)).toBe(true)
    expect(isOriginAllowed('', dev)).toBe(true)
  })

  it('rejects non-loopback origins', () => {
    for (const origin of [
      'http://evil.example.com',
      'https://localhost.evil.com',
      'http://192.168.1.10:5173',
      'http://localhost.attacker.net:5173'
    ]) {
      expect(isOriginAllowed(origin, dev), origin).toBe(false)
    }
  })
})

describe('isOriginAllowed (explicit allow list)', () => {
  const opts = { vercel: false, allowList: 'https://qa.example.com, https://staging.example.com' }

  it('permits a listed origin and rejects everything else', () => {
    expect(isOriginAllowed('https://qa.example.com', opts)).toBe(true)
    expect(isOriginAllowed('https://staging.example.com', opts)).toBe(true)
    expect(isOriginAllowed('https://other.example.com', opts)).toBe(false)
  })

  it('takes precedence over the loopback default', () => {
    expect(isOriginAllowed('http://localhost:5173', opts)).toBe(false)
  })
})

describe('isOriginAllowed (Vercel)', () => {
  it('allows any origin so preview deployments work', () => {
    expect(isOriginAllowed('https://qa-nexus-git-branch.vercel.app', { vercel: true })).toBe(true)
  })
})
