import { describe, it, expect } from 'vitest'
import {
  resolveElement,
  resolveElements,
  resolveCollection,
  isOrderNonDeterministic,
  parseLocatorExpression,
  type CountProbe
} from './groundingResolver'
import type { CandidateEntry, CollectionEntry } from './domDistiller'

// Fake live page: a map of selector expression -> node count.
const probeFrom = (counts: Record<string, number>): CountProbe =>
  async sel => (sel in counts ? counts[sel] : 0)

const entry = (candidates: string[]): CandidateEntry => ({
  tag: 'a', label: 'Add to Basket', kind: 'other', page: 'Sweets', candidates
})

describe('resolveElement', () => {
  it('rejects a role that the browser assigns to nothing, falling to the next tier', () => {
    // The real defect: <a class="addItem"> has no href -> no implicit role,
    // so getByRole('link') matches ZERO nodes. Only a live count reveals this.
    const roleSel = `page.getByRole('link', { name: 'Add to Basket' })`
    const dataSel = `page.locator('[data-name="Bon Bons"]')`
    const probe = probeFrom({ [roleSel]: 0, [dataSel]: 1 })

    return resolveElement(entry([roleSel, dataSel]), probe).then(res => {
      expect(res).toEqual({ selector: dataSel, verifiedCount: 1 })
    })
  })

  it('prefers the highest-priority candidate that resolves uniquely', async () => {
    const a = `page.getByTestId('add')`
    const b = `page.locator('a.addItem')`
    const res = await resolveElement(entry([a, b]), probeFrom({ [a]: 1, [b]: 1 }))
    expect(res).toEqual({ selector: a, verifiedCount: 1 })
  })

  it('refuses an ambiguous selector rather than emitting a positional .nth()', async () => {
    const cls = `page.locator('a.addItem')`
    const res = await resolveElement(entry([cls]), probeFrom({ [cls]: 4 }))
    expect(res).toHaveProperty('reason')
    expect((res as any).reason).toMatch(/multiple elements/i)
    expect((res as any).reason).toMatch(/nth/i)
  })

  it('reports when nothing matched at all', async () => {
    const res = await resolveElement(entry([`page.getByPlaceholder('Search')`]), probeFrom({}))
    expect((res as any).reason).toMatch(/no candidate matched/i)
  })

  it('skips a candidate whose expression throws on the live page', async () => {
    const bad = `page.locator('// TODO')`
    const good = `page.locator('.addItem')`
    const probe: CountProbe = async sel => {
      if (sel === bad) throw new Error('invalid selector')
      return sel === good ? 1 : 0
    }
    expect(await resolveElement(entry([bad, good]), probe)).toEqual({ selector: good, verifiedCount: 1 })
  })
})

describe('resolveElements', () => {
  it('splits verified elements from unresolved ones', async () => {
    const ok = `page.getByTestId('ok')`
    const result = await resolveElements(
      [entry([ok]), entry([`page.getByPlaceholder('Search')`])],
      probeFrom({ [ok]: 1 })
    )
    expect(result.elements).toHaveLength(1)
    expect(result.elements[0].verifiedCount).toBe(1)
    expect(result.unresolved).toHaveLength(1)
    expect(result.unresolved[0].tried).toContain(`page.getByPlaceholder('Search')`)
  })
})

describe('resolveCollection', () => {
  const collection: CollectionEntry = {
    name: 'card',
    itemSelector: '.card',
    count: 4,
    fields: [
      { name: 'cardTitle', selector: '.card-title', kind: 'other' },
      { name: 'ghost', selector: '.does-not-exist', kind: 'other' }
    ]
  }

  const probe = (items: number, fields: Record<string, number>) => ({
    countItems: async () => items,
    countFieldInFirstItem: async (_i: string, f: string) => fields[f] ?? 0
  })

  it('keeps only fields that resolve inside an item, and uses the live item count', async () => {
    const resolved = await resolveCollection(collection, probe(4, { '.card-title': 1 }))
    expect(resolved!.count).toBe(4)
    expect(resolved!.fields.map(f => f.selector)).toEqual(['.card-title'])
  })

  it('drops a collection that is not actually repeating on the live page', async () => {
    expect(await resolveCollection(collection, probe(1, { '.card-title': 1 }))).toBeNull()
  })
})

describe('parseLocatorExpression (closed grammar — never eval page content)', () => {
  it('decodes each shape the distiller emits', () => {
    expect(parseLocatorExpression(`page.getByTestId('save')`)).toEqual({ kind: 'testId', value: 'save' })
    expect(parseLocatorExpression(`page.getByPlaceholder('Email')`)).toEqual({ kind: 'placeholder', value: 'Email' })
    expect(parseLocatorExpression(`page.getByText('Hi', { exact: true })`)).toEqual({ kind: 'text', value: 'Hi', exact: true })
    expect(parseLocatorExpression(`page.getByRole('button', { name: 'Save' })`)).toEqual({ kind: 'role', role: 'button', name: 'Save' })
    expect(parseLocatorExpression(`page.getByRole('link', { name: /Basket/ })`)).toEqual({ kind: 'roleRegex', role: 'link', pattern: 'Basket' })
    expect(parseLocatorExpression(`page.locator('[data-name="Bon Bons"]')`)).toEqual({ kind: 'css', selector: '[data-name="Bon Bons"]' })
  })

  it('unescapes quoted values back to their literal form', () => {
    expect(parseLocatorExpression(`page.getByRole('button', { name: 'It\\'s fine' })`))
      .toEqual({ kind: 'role', role: 'button', name: "It's fine" })
  })

  // SECURITY: candidate expressions embed page-controlled content. Anything
  // outside the grammar must be rejected, never executed.
  it('rejects anything outside the grammar, including injection attempts', () => {
    expect(parseLocatorExpression(`page.evaluate(() => process.exit(1))`)).toBeNull()
    expect(parseLocatorExpression(`page.locator('x'); require('child_process').execSync('id')`)).toBeNull()
    expect(parseLocatorExpression(`page.getByTestId('a') + process.env.TOKEN`)).toBeNull()
    expect(parseLocatorExpression(`page.getByRole('textbox', { name: 'x' })`)).toBeNull() // role not in our set
    expect(parseLocatorExpression(`fetch('http://evil')`)).toBeNull()
  })
})

describe('isOrderNonDeterministic', () => {
  it('detects a reshuffle of the same items across two loads', () => {
    // The sweetshop randomises its card order on every page load.
    expect(isOrderNonDeterministic(['A', 'B', 'C'], ['C', 'A', 'B'])).toBe(true)
  })

  it('returns false for a stable order', () => {
    expect(isOrderNonDeterministic(['A', 'B', 'C'], ['A', 'B', 'C'])).toBe(false)
  })

  it('does not mistake changed content for a shuffle', () => {
    expect(isOrderNonDeterministic(['A', 'B'], ['A', 'Z'])).toBe(false)
  })

  it('ignores lists too short to have a meaningful order', () => {
    expect(isOrderNonDeterministic(['A'], ['A'])).toBe(false)
  })
})
