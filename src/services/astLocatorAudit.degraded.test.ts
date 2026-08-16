import { describe, it, expect, vi } from 'vitest'

// A failed compiler load must degrade this optional safety net to a no-op,
// not crash automation generation. Reproduces the actual failure mode: the
// dynamic import of 'typescript' rejecting (a dev-server chunk-fetch race, an
// extension blocking it, a flaky network) — mocked here at the module level
// since that's the only way to make `import('typescript')` itself reject.
vi.mock('typescript', () => {
  throw new Error('Failed to fetch dynamically imported module')
})

describe('astLocatorAudit when the TypeScript compiler fails to load', () => {
  it('auditLocatorCardinality returns no violations instead of throwing', async () => {
    const { auditLocatorCardinality } = await import('./astLocatorAudit')
    const code = `
      test('x', async ({ page }) => {
        const cards = page.locator('.card')
        await expect(cards).toBeVisible()
      })
    `
    await expect(auditLocatorCardinality(code, new Set(['.card']))).resolves.toEqual([])
  })

  it('findRawCollectionMethods returns an empty set instead of throwing', async () => {
    const { findRawCollectionMethods } = await import('./astLocatorAudit')
    await expect(
      findRawCollectionMethods([{ name: 'getCards', code: "return this.page.locator('.card')" }], new Set(['.card']))
    ).resolves.toEqual(new Set())
  })
})
