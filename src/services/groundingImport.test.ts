import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { parseGroundingFile } from './groundingImport'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// The file the app actually ships and the "Try the sample" button fetches, and
// itself the real output of `blast-ground` against sweetshop.vivrichards.co.uk.
// Parsing the genuine artifact is the only way to know the schema matches what
// the CLI emits — and pinning the test to the shipped copy means the demo asset
// can never silently drift out of sync with the parser.
const SHIPPED_SAMPLE = JSON.parse(
  readFileSync(path.join(__dirname, '../../public/sample-grounding.json'), 'utf8')
)

describe('parseGroundingFile — the shipped blast-ground sample', () => {
  const parsed = parseGroundingFile(SHIPPED_SAMPLE)

  it('accepts the artifact the CLI actually produces', () => {
    expect(parsed.baseUrl).toBe('https://sweetshop.vivrichards.co.uk')
    expect(parsed.elements.length).toBeGreaterThan(30)
    expect(parsed.collections.length).toBeGreaterThan(0)
    expect(parsed.pageNames).toContain('Sweets')
  })

  it('carries through the live-verified selector for the href-less add button', () => {
    const add = parsed.elements.find(e => e.label === 'Add to Basket')!
    expect(add.selector).toMatch(/data-id/)
    expect(add.selector).not.toMatch(/getByRole/)
  })

  it('strips verifiedCount so elements match the app ElementEntry shape', () => {
    expect(parsed.elements.every(e => !('verifiedCount' in e))).toBe(true)
  })

  it('maps every page to the URL it was grounded at, for auth setup to navigate to', () => {
    expect(parsed.pageUrls.Login).toBe('https://sweetshop.vivrichards.co.uk/login')
  })

  it('surfaces the dead route the CLI found on the target site', () => {
    expect(parsed.missingRoutes).toContain('/bout')
  })

  it('warns about a collection whose order is randomised between loads', () => {
    expect(parsed.warnings.some(w => /reorders itself/.test(w))).toBe(true)
  })

  it('reports unresolved elements rather than inventing selectors for them', () => {
    expect(parsed.unresolvedLabels.length).toBeGreaterThan(0)
    expect(parsed.warnings.some(w => /todoSelector\(\) stubs/.test(w))).toBe(true)
  })
})

describe('parseGroundingFile — validation', () => {
  const valid = {
    version: 1,
    baseUrl: 'https://example.com',
    elements: [{ selector: "page.getByTestId('x')", tag: 'button', label: 'X', kind: 'button' }]
  }

  it('applies defaults for optional sections', () => {
    const parsed = parseGroundingFile(valid)
    expect(parsed.collections).toEqual([])
    expect(parsed.missingRoutes).toEqual([])
    expect(parsed.warnings).toEqual([])
  })

  const unstable = {
    name: 'card',
    itemSelector: '.card',
    count: 4,
    fields: [],
    nondeterministicOrder: true
  }

  it('synthesizes an ordering warning when the CLI did not emit one', () => {
    const parsed = parseGroundingFile({ ...valid, collections: [unstable] })
    expect(parsed.warnings.filter(w => w.includes('.card'))).toHaveLength(1)
  })

  it('does not repeat an ordering warning the CLI already emitted', () => {
    const parsed = parseGroundingFile({
      ...valid,
      collections: [unstable],
      warnings: ['[Home] ".card" reorders itself between loads — address items by text, never by index.']
    })
    expect(parsed.warnings.filter(w => w.includes('.card'))).toHaveLength(1)
  })

  it('rejects a non-grounding JSON with an actionable message', () => {
    expect(() => parseGroundingFile({ hello: 'world' })).toThrow(/not a valid grounding\.json/i)
    expect(() => parseGroundingFile({ hello: 'world' })).toThrow(/blast-ground/)
  })

  it('rejects a future schema version rather than silently mis-reading it', () => {
    expect(() => parseGroundingFile({ ...valid, version: 2 })).toThrow(/version/)
  })

  it('rejects a bad baseUrl', () => {
    expect(() => parseGroundingFile({ ...valid, baseUrl: 'not-a-url' })).toThrow(/baseUrl/)
  })
})
