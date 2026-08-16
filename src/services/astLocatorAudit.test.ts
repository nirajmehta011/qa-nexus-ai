import { describe, it, expect } from 'vitest'
import { auditLocatorCardinality, findRawCollectionMethods } from './astLocatorAudit'

const CARD_SELECTORS = new Set(['.card'])

describe('auditLocatorCardinality', () => {
  it('flags the exact real bug: a variable holding a raw collection, asserted on lines later', async () => {
    // Verified live against sweetshop.vivrichards.co.uk: page.locator('.card')
    // matches 16 elements; expect(cards).toBeVisible() THROWS "strict mode
    // violation" at runtime. A regex can't catch this because the badness
    // spans two separate statements connected only by the variable name.
    const code = `
      test('x', async ({ page }) => {
        const cards = page.locator('.card')
        await expect(cards).toHaveCount(16)
        await expect(cards).toBeVisible()
      })
    `
    const violations = await auditLocatorCardinality(code, CARD_SELECTORS)
    expect(violations).toHaveLength(1)
    expect(violations[0].message).toMatch(/strict mode violation/)
    expect(violations[0].line).toBe(5)
  })

  it('flags the inline form too: expect(page.locator(item)).toBeVisible()', async () => {
    const code = `await expect(page.locator('.card')).toBeVisible()`
    const violations = await auditLocatorCardinality(code, CARD_SELECTORS)
    expect(violations).toHaveLength(1)
  })

  it('does not flag toHaveCount on a raw collection – that IS the correct pattern', async () => {
    const code = `
      const cards = page.locator('.card')
      await expect(cards).toHaveCount(16)
    `
    expect(await auditLocatorCardinality(code, CARD_SELECTORS)).toHaveLength(0)
  })

  it('does not flag a collection narrowed with .filter() first', async () => {
    const code = `
      const card = page.locator('.card').filter({ hasText: 'Bon Bons' })
      await expect(card).toBeVisible()
    `
    expect(await auditLocatorCardinality(code, CARD_SELECTORS)).toHaveLength(0)
  })

  it('does not flag .first()/.nth()/.last()-narrowed locators', async () => {
    for (const narrow of ['.first()', '.nth(0)', '.last()']) {
      const code = `
        const card = page.locator('.card')${narrow}
        await expect(card).toBeVisible()
      `
      expect(await auditLocatorCardinality(code, CARD_SELECTORS), narrow).toHaveLength(0)
    }
  })

  it('does not flag iterating the collection with .all() and asserting each item', async () => {
    // The correct, prompt-documented safe pattern for a whole-collection check.
    const code = `
      const cards = page.locator('.card')
      for (const card of await cards.all()) {
        await expect(card).toBeVisible()
      }
    `
    expect(await auditLocatorCardinality(code, CARD_SELECTORS)).toHaveLength(0)
  })

  it('does not flag toHaveText with an array argument (the valid multi-element form)', async () => {
    const code = `
      const cards = page.locator('.card')
      await expect(cards).toHaveText(['Bon Bons', 'Sherbert Straws'])
    `
    expect(await auditLocatorCardinality(code, CARD_SELECTORS)).toHaveLength(0)
  })

  it('flags toHaveText with a single string on a raw collection', async () => {
    const code = `
      const cards = page.locator('.card')
      await expect(cards).toHaveText('Bon Bons')
    `
    expect(await auditLocatorCardinality(code, CARD_SELECTORS)).toHaveLength(1)
  })

  it('flags a locator reached through this.page (page-method context) the same way', async () => {
    const code = `
      const items = this.page.locator('.card')
      await expect(items).toBeChecked()
    `
    expect(await auditLocatorCardinality(code, CARD_SELECTORS)).toHaveLength(1)
  })

  it('flags a locator reached through a fixture (home.page, post BasePage.page going public)', async () => {
    const code = `
      const items = home.page.locator('.card')
      await expect(items).toBeVisible()
    `
    expect(await auditLocatorCardinality(code, CARD_SELECTORS)).toHaveLength(1)
  })

  it('is a no-op when there are no known collections to check against', async () => {
    const code = `await expect(page.locator('.card')).toBeVisible()`
    expect(await auditLocatorCardinality(code, new Set())).toHaveLength(0)
  })

  it('ignores an unrelated selector that happens to also be single-element-asserted', async () => {
    const code = `await expect(page.getByRole('button', { name: 'Save' })).toBeVisible()`
    expect(await auditLocatorCardinality(code, CARD_SELECTORS)).toHaveLength(0)
  })

  it('reports multiple violations with correct line numbers', async () => {
    const code = [
      `const cards = page.locator('.card')`,
      `await expect(cards).toBeVisible()`,
      `await expect(cards).toBeEnabled()`
    ].join('\n')
    const violations = await auditLocatorCardinality(code, CARD_SELECTORS)
    expect(violations.map(v => v.line)).toEqual([2, 3])
  })
})

describe('findRawCollectionMethods (page-object method returning a raw collection)', () => {
  it('identifies a method whose body directly returns an unfiltered collection', async () => {
    const methods = [
      { name: 'getCards', code: `getCards() {\n  return this.page.locator('.card')\n}` },
      { name: 'getCardByName', code: `getCardByName(name) {\n  return this.page.locator('.card').filter({ hasText: name })\n}` }
    ]
    const raw = await findRawCollectionMethods(methods, CARD_SELECTORS)
    expect(raw.has('getCards')).toBe(true)
    expect(raw.has('getCardByName')).toBe(false) // narrowed – safe
  })

  it('lets the audit track calls to a known raw-collection method (real pattern: sweets.getCards())', async () => {
    const methods = [{ name: 'getCards', code: `getCards() {\n  return this.page.locator('.card')\n}` }]
    const rawMethods = await findRawCollectionMethods(methods, CARD_SELECTORS)

    const code = `
      const cards = sweets.getCards()
      await expect(cards).toBeVisible()
    `
    const violations = await auditLocatorCardinality(code, CARD_SELECTORS, rawMethods)
    expect(violations).toHaveLength(1)
  })

  it('also flags the inline call form: expect(sweets.getCards()).toBeVisible()', async () => {
    const methods = [{ name: 'getCards', code: `getCards() {\n  return this.page.locator('.card')\n}` }]
    const rawMethods = await findRawCollectionMethods(methods, CARD_SELECTORS)
    const violations = await auditLocatorCardinality(
      `await expect(sweets.getCards()).toBeVisible()`,
      CARD_SELECTORS,
      rawMethods
    )
    expect(violations).toHaveLength(1)
  })
})
