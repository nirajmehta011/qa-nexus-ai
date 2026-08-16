import { describe, it, expect } from 'vitest'
import { isPrivateIP, assertPublicHttpUrl } from './misc.mjs'

describe('isPrivateIP', () => {
  const privateCases = [
    ['loopback', '127.0.0.1'],
    ['loopback range', '127.8.8.8'],
    ['rfc1918 10/8', '10.0.0.5'],
    ['rfc1918 172.16/12 low', '172.16.0.1'],
    ['rfc1918 172.16/12 high', '172.31.255.254'],
    ['rfc1918 192.168/16', '192.168.1.1'],
    ['link-local / cloud metadata', '169.254.169.254'],
    ['CGNAT', '100.64.0.1'],
    ['zero network', '0.0.0.0'],
    ['multicast', '224.0.0.1'],
    ['broadcast/reserved', '255.255.255.255'],
    ['ipv6 loopback', '::1'],
    ['ipv6 unique local fc', 'fc00::1'],
    ['ipv6 unique local fd', 'fd12:3456::1'],
    ['ipv6 link local', 'fe80::1'],
    ['ipv4-mapped private', '::ffff:192.168.0.1'],
  ]

  it.each(privateCases)('rejects %s (%s)', (_label, ip) => {
    expect(isPrivateIP(ip)).toBe(true)
  })

  const publicCases = [
    ['public v4', '93.184.216.34'],
    ['public v4 (dns)', '8.8.8.8'],
    ['172 outside private range', '172.32.0.1'],
    ['ipv4-mapped public', '::ffff:8.8.8.8'],
    ['public v6', '2606:2800:220:1::1'],
  ]

  it.each(publicCases)('allows %s (%s)', (_label, ip) => {
    expect(isPrivateIP(ip)).toBe(false)
  })
})

describe('assertPublicHttpUrl', () => {
  it('rejects non-http protocols', async () => {
    await expect(assertPublicHttpUrl('file:///etc/passwd')).rejects.toThrow(/Only http/)
    await expect(assertPublicHttpUrl('ftp://example.com')).rejects.toThrow(/Only http/)
    await expect(assertPublicHttpUrl('gopher://example.com')).rejects.toThrow(/Only http/)
  })

  it('rejects malformed URLs', async () => {
    await expect(assertPublicHttpUrl('not a url')).rejects.toThrow(/Invalid URL/)
  })

  it('rejects literal private IPs without DNS lookup', async () => {
    await expect(assertPublicHttpUrl('http://127.0.0.1/x')).rejects.toThrow(/private or internal/)
    await expect(assertPublicHttpUrl('http://169.254.169.254/latest/meta-data')).rejects.toThrow(/private or internal/)
    await expect(assertPublicHttpUrl('http://[::1]/')).rejects.toThrow(/private or internal/)
  })

  it('rejects hostnames resolving to loopback', async () => {
    await expect(assertPublicHttpUrl('http://localhost:3001/health')).rejects.toThrow(/private or internal/)
  })
})
