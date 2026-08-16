import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./aiService', async importOriginal => {
  const actual = await importOriginal<typeof import('./aiService')>()
  return {
    ...actual,
    default: {
      complete: vi.fn(),
      makeRepairFn: vi.fn(() => async () => { throw new Error('repair unavailable in test') })
    }
  }
})

import aiService from './aiService'
import { buildAutomationSuite, computeGroundingStats, hasExecutableTodoSelector, buildFixmeStub, extractGotoPaths, isRouteMissing, findUngroundedLocators, desyncLocatorGetter, degradeUngroundedLocators, findMissingPageMethods, enforceTestTitle, isGroundedLocator, fixMisusedTodoSelector, findMissingLocatorProperties } from './automationBuilder'
import type { TestCase } from './aiService'

const mockComplete = aiService.complete as ReturnType<typeof vi.fn>

const testCase: TestCase = {
  id: 'TC-001',
  summary: 'Verify login',
  issueType: 'Test',
  priority: 'High',
  labels: 'functional',
  testType: 'Functional',
  precondition: 'User exists',
  steps: [{ stepNumber: 1, action: 'Click login', testData: '', expectedResult: 'Dashboard shown' }],
  status: 'Not Executed',
  component: 'Auth',
  estimatedTime: '5m',
  scenarioType: 'happy_path'
}

const elements = [
  { selector: "page.getByRole('button', { name: 'Log in' })", tag: 'button', label: 'Log in', kind: 'button' as const, page: 'Login' }
]

const specResponse = JSON.stringify({
  testFiles: [{
    filename: 'tests/tc-001.spec.ts',
    code: "import { test, expect } from '../fixtures/base.fixture'\n\ntest('TC-001: Verify login', async ({ login }) => {\n  await login.logIn()\n  await expect(login.page).toHaveURL('/dashboard')\n})\n"
  }],
  pageMethods: [{
    page: 'Login',
    code: "async logIn() {\n    await this.locators.logInButton.click()\n  }"
  }]
})

beforeEach(() => mockComplete.mockReset())

describe('buildAutomationSuite', () => {
  it('scaffolds a full POM framework and adds LLM-translated specs + methods', async () => {
    mockComplete.mockResolvedValueOnce(specResponse)
    const result = await buildAutomationSuite({
      provider: 'gemini', apiKey: 'k', model: 'm',
      projectName: 'My QA Suite',
      testCases: [testCase],
      context: { elements, baseUrl: 'https://app.example.com' }
    })

    // Deterministic scaffold present without any LLM involvement
    expect(result.packageJson).toContain('"@playwright/test"')
    expect(result.playwrightConfig).toContain("baseURL: process.env.BASE_URL || 'https://app.example.com'")
    const filenames = result.testFiles.map(f => f.filename)
    expect(filenames).toContain('pages/base.page.ts')
    expect(filenames).toContain('components/modal.component.ts')
    expect(filenames).toContain('components/toast.component.ts')
    expect(filenames).toContain('pages/locators/login.locators.ts')
    expect(filenames).toContain('pages/login.page.ts')
    expect(filenames).toContain('fixtures/base.fixture.ts')
    expect(filenames).toContain('tests/tc-001.spec.ts')
    expect(result.pageObjectNames).toEqual(['Login'])
    expect(result.readme).toContain('Page Object Model')

    // Locators file is 100% deterministic and grounded
    const locatorsFile = result.testFiles.find(f => f.filename === 'pages/locators/login.locators.ts')!
    expect(locatorsFile.code).toContain("this.logInButton = page.getByRole('button', { name: 'Log in' })")

    // LLM-authored method spliced into the page object shell
    const pageFile = result.testFiles.find(f => f.filename === 'pages/login.page.ts')!
    expect(pageFile.code).toContain('async logIn()')
    expect(pageFile.code).toContain('extends BasePage')

    // Fixtures wire the page object in
    const fixturesFile = result.testFiles.find(f => f.filename === 'fixtures/base.fixture.ts')!
    expect(fixturesFile.code).toContain('login: Login')

    // Only ONE LLM call (translation+methods combined), prompt constrained to the page's properties
    expect(mockComplete).toHaveBeenCalledTimes(1)
    const prompt = mockComplete.mock.calls[0][3] as string
    expect(prompt).not.toContain('app.locators') // uses the real fixture name, not a generic "app"
    expect(prompt).toContain('login.locators.logInButton')
    expect(prompt).toContain('NEVER write "page.getByRole')
    expect(prompt).toContain('TEST INDEPENDENCE')

    // Support files always present
    expect(filenames).toContain('.gitignore')
    expect(filenames).toContain('.env.example')
    expect(filenames).toContain('.github/workflows/playwright.yml')

    // Auth setup: a "Login" page with a grounded, authored logIn() method
    // was present, so the setup project + storageState reuse are wired in.
    expect(filenames).toContain('tests/auth.setup.ts')
    const authFile = result.testFiles.find(f => f.filename === 'tests/auth.setup.ts')!
    expect(authFile.code).toContain('login.logIn(')
    expect(result.playwrightConfig).toContain("name: 'setup'")
    expect(result.playwrightConfig).toContain('storageState')
  })

  it('does not scaffold an auth setup project when no login page was grounded', async () => {
    const nonLoginElements = [
      { selector: "page.getByRole('button', { name: 'Save' })", tag: 'button', label: 'Save', kind: 'button' as const, page: 'Settings' }
    ]
    mockComplete.mockResolvedValueOnce(JSON.stringify({
      testFiles: [{ filename: 'tests/tc-001.spec.ts', code: "import { test, expect } from '../fixtures/base.fixture'\ntest('x', async ({ settings }) => {})" }]
    }))
    const result = await buildAutomationSuite({
      provider: 'gemini', apiKey: 'k', model: 'm', projectName: 'x',
      testCases: [testCase], context: { elements: nonLoginElements }
    })
    expect(result.testFiles.some(f => f.filename === 'tests/auth.setup.ts')).toBe(false)
    expect(result.playwrightConfig).not.toContain("name: 'setup'")
  })

  it('accumulates methods across chunks without duplicating an already-authored one', async () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ ...testCase, id: `TC-${String(i + 1).padStart(3, '0')}` }))
    const chunk1 = JSON.stringify({
      testFiles: [{ filename: 'tests/tc-001.spec.ts', code: "import { test, expect } from '../fixtures/base.fixture'\ntest('a', async ({ login }) => { await login.logIn() })" }],
      pageMethods: [{ page: 'Login', code: 'async logIn() {\n  await this.locators.logInButton.click()\n}' }]
    })
    const chunk2 = JSON.stringify({
      testFiles: [{ filename: 'tests/tc-006.spec.ts', code: "import { test, expect } from '../fixtures/base.fixture'\ntest('b', async ({ login }) => { await login.logIn() })" }],
      // Second chunk tries to re-author the SAME method name – must not duplicate
      pageMethods: [{ page: 'Login', code: 'async logIn() {\n  // a different implementation\n}' }]
    })
    mockComplete.mockResolvedValueOnce(chunk1).mockResolvedValueOnce(chunk2)

    const result = await buildAutomationSuite({
      provider: 'gemini', apiKey: 'k', model: 'm', projectName: 'x',
      testCases: many, context: { elements }
    })
    expect(mockComplete).toHaveBeenCalledTimes(2) // 6 cases / 5 per chunk
    const pageFile = result.testFiles.find(f => f.filename === 'pages/login.page.ts')!
    // Only one "async logIn()" definition, and it's the FIRST chunk's version
    expect(pageFile.code.match(/async logIn\(\)/g)?.length).toBe(1)
    expect(pageFile.code).toContain('this.locators.logInButton.click()')
    expect(pageFile.code).not.toContain('a different implementation')
  })

  it('drops pageMethods referencing an unknown page instead of creating bogus files', async () => {
    const response = JSON.stringify({
      testFiles: [{ filename: 'tests/tc-001.spec.ts', code: "import { test, expect } from '../fixtures/base.fixture'\ntest('a', async ({ app }) => {})" }],
      pageMethods: [{ page: 'NoSuchPage', code: 'async ghost() {}' }]
    })
    mockComplete.mockResolvedValueOnce(response)
    const result = await buildAutomationSuite({
      provider: 'gemini', apiKey: 'k', model: 'm', projectName: 'x', testCases: [testCase]
    })
    expect(result.testFiles.some(f => f.filename.includes('nosuchpage'))).toBe(false)
  })

  it('degrades to fixme skeletons when translation fails, without touching page objects', async () => {
    mockComplete.mockRejectedValueOnce(new Error('boom'))
    const result = await buildAutomationSuite({
      provider: 'gemini', apiKey: 'k', model: 'm',
      projectName: 'x', testCases: [testCase]
    })
    const spec = result.testFiles.find(f => f.filename === 'tests/tc-001.spec.ts')
    expect(spec).toBeDefined()
    expect(spec!.code).toContain('test.fixme')
    expect(spec!.code).toContain('TODO-SELECTOR')
    // No grounding at all -> falls back to the single "App" page, still scaffolded
    expect(result.pageObjectNames).toEqual(['App'])
  })

  it('does not let generic component boilerplate drag down the grounding rate', async () => {
    // The component files (modal/toast/tooltip/navbar) always contain several
    // generic, ungrounded page.getByRole(...) calls by design – they must not
    // be counted against the grounding percentage.
    mockComplete.mockResolvedValueOnce(specResponse)
    const result = await buildAutomationSuite({
      provider: 'gemini', apiKey: 'k', model: 'm', projectName: 'x',
      testCases: [testCase], context: { elements }
    })
    // The only real grounded/ungrounded locators are in locators.ts (1 grounded)
    // and the spec/page-object files – should be 100%, not dragged down by components.
    expect(result.selectorGroundingRate).toBe(1)
  })

  it('chunks translation for large suites (5 cases per call)', async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ ...testCase, id: `TC-${String(i + 1).padStart(3, '0')}` }))
    mockComplete.mockResolvedValue(JSON.stringify({ testFiles: [{ filename: 'tests/x.spec.ts', code: 'x' }] }))
    await buildAutomationSuite({ provider: 'gemini', apiKey: 'k', model: 'm', projectName: 'x', testCases: many })
    expect(mockComplete).toHaveBeenCalledTimes(3) // 12 cases / 5 per chunk
  })

  it('downgrades a spec that authors a raw, ungrounded locator directly instead of going through a page object', async () => {
    // Real defect, found by generating from a spec doc and running the result:
    // a spec asserted page.locator('.dashboard-container') for a dashboard
    // that does not exist anywhere in the grounded app – invented, and written
    // directly in the spec, bypassing the page-object pattern entirely.
    mockComplete.mockResolvedValueOnce(JSON.stringify({
      testFiles: [{
        filename: 'tests/tc-001.spec.ts',
        code: "import { test, expect } from '../fixtures/base.fixture'\n\ntest('TC-001: Verify login', async ({ page, login }) => {\n  await login.logIn()\n  await expect(page.locator('.dashboard-container')).toBeVisible()\n})\n"
      }],
      pageMethods: [{ page: 'Login', code: "async logIn() {\n    await this.locators.logInButton.click()\n  }" }]
    }))
    const result = await buildAutomationSuite({
      provider: 'gemini', apiKey: 'k', model: 'm',
      projectName: 'x',
      testCases: [testCase],
      context: { elements, baseUrl: 'https://app.example.com' }
    })
    const spec = result.testFiles.find(f => f.filename === 'tests/tc-001.spec.ts')!
    expect(spec.code).toContain('test.fixme(')
    expect(spec.code).toContain('not present anywhere in the grounded app')
    expect(spec.code).not.toContain('.dashboard-container')
  })

  it('does NOT flag a spec that uses a grounded collection locator directly', async () => {
    // The critical-rule violation of writing page.* directly in a spec is a
    // style issue we don't statically enforce; only INVENTED locators are a
    // real defect. `.card` here IS grounded (in the allow-list), so a bare
    // `page.locator('.card')` in a spec must be left alone.
    mockComplete.mockResolvedValueOnce(JSON.stringify({
      testFiles: [{
        filename: 'tests/tc-001.spec.ts',
        code: "import { test, expect } from '../fixtures/base.fixture'\n\ntest('TC-001: Verify login', async ({ page }) => {\n  const cards = page.locator('.card')\n  await expect(cards).toHaveCount(4)\n})\n"
      }],
      pageMethods: []
    }))
    const result = await buildAutomationSuite({
      provider: 'gemini', apiKey: 'k', model: 'm',
      projectName: 'x',
      testCases: [testCase],
      context: {
        elements,
        collections: [{ name: 'card', itemSelector: '.card', count: 4, fields: [] }],
        baseUrl: 'https://app.example.com'
      }
    })
    const spec = result.testFiles.find(f => f.filename === 'tests/tc-001.spec.ts')!
    expect(spec.code).not.toContain('test.fixme(')
    expect(spec.code).toContain("page.locator('.card')")
  })

  it('corrects a spec that misuses todoSelector() on an already-grounded collection', async () => {
    // Real defect, found by generating from a real SCREENSHOT and running the
    // result: a spec called `home.todoSelector('.card')` directly (no page
    // method involved at all – a DIFFERENT call site than the page-method case
    // fixMisusedTodoSelector already covered) even though '.card' was a
    // genuinely grounded Home-page collection. The first fix only matched
    // `this.todoSelector(...)`; a spec calls it through the fixture variable
    // (`home.todoSelector(...)`), which the regex silently missed until fixed.
    mockComplete.mockResolvedValueOnce(JSON.stringify({
      testFiles: [{
        filename: 'tests/tc-001.spec.ts',
        code: "import { test, expect } from '../fixtures/base.fixture'\n\ntest('TC-001: Verify card', async ({ home, page }) => {\n  await page.goto('/')\n  const card = home.todoSelector('.card').filter({ hasText: 'Bon Bons' })\n  await expect(card).toBeVisible()\n})\n"
      }],
      pageMethods: []
    }))
    const result = await buildAutomationSuite({
      provider: 'gemini', apiKey: 'k', model: 'm',
      projectName: 'x',
      testCases: [testCase],
      context: {
        elements,
        collections: [{ name: 'card', itemSelector: '.card', count: 4, fields: [] }],
        baseUrl: 'https://app.example.com'
      }
    })
    const spec = result.testFiles.find(f => f.filename === 'tests/tc-001.spec.ts')!
    expect(spec.code).not.toContain('test.fixme(')
    expect(spec.code).toContain("home.page.locator('.card')")
    expect(spec.code).not.toContain('todoSelector')
  })

  it('downgrades a spec that asserts a single-element check on a raw collection locator (AST audit, end-to-end)', async () => {
    // Real defect, found by generating from a spec doc and running the result
    // against the live site: expect(cards).toBeVisible() on a 16-match
    // locator throws "strict mode violation" at RUNTIME. No regex can catch
    // this – the variable is declared on one line and misused several lines
    // later. This proves the full wiring: buildAutomationSuite -> the AST
    // audit -> fixme, not just the isolated auditLocatorCardinality unit.
    mockComplete.mockResolvedValueOnce(JSON.stringify({
      testFiles: [{
        filename: 'tests/tc-001.spec.ts',
        code: "import { test, expect } from '../fixtures/base.fixture'\n\ntest('TC-001: Verify all cards', async ({ page }) => {\n  await page.goto('/sweets')\n  const cards = page.locator('.card')\n  await expect(cards).toHaveCount(16)\n  await expect(cards).toBeVisible()\n})\n"
      }],
      pageMethods: []
    }))
    const result = await buildAutomationSuite({
      provider: 'gemini', apiKey: 'k', model: 'm',
      projectName: 'x',
      testCases: [testCase],
      context: {
        elements,
        collections: [{ name: 'card', itemSelector: '.card', count: 16, fields: [] }],
        baseUrl: 'https://app.example.com'
      }
    })
    const spec = result.testFiles.find(f => f.filename === 'tests/tc-001.spec.ts')!
    expect(spec.code).toContain('test.fixme(')
    expect(spec.code).toContain('strict mode violation')
  })

  it('does NOT downgrade the correct pattern: toHaveCount + per-item .all() iteration', async () => {
    mockComplete.mockResolvedValueOnce(JSON.stringify({
      testFiles: [{
        filename: 'tests/tc-001.spec.ts',
        code: "import { test, expect } from '../fixtures/base.fixture'\n\ntest('TC-001: Verify all cards', async ({ page }) => {\n  await page.goto('/sweets')\n  const cards = page.locator('.card')\n  await expect(cards).toHaveCount(16)\n  for (const card of await cards.all()) {\n    await expect(card).toBeVisible()\n  }\n})\n"
      }],
      pageMethods: []
    }))
    const result = await buildAutomationSuite({
      provider: 'gemini', apiKey: 'k', model: 'm',
      projectName: 'x',
      testCases: [testCase],
      context: {
        elements,
        collections: [{ name: 'card', itemSelector: '.card', count: 16, fields: [] }],
        baseUrl: 'https://app.example.com'
      }
    })
    const spec = result.testFiles.find(f => f.filename === 'tests/tc-001.spec.ts')!
    expect(spec.code).not.toContain('test.fixme(')
  })
})

describe('computeGroundingStats', () => {
  it('measures grounded vs invented locators and counts TODOs across all files', () => {
    const files = [{
      filename: 'pages/locators/login.locators.ts',
      code: "this.logInButton = page.getByRole('button', { name: 'Log in' })" // grounded
    }, {
      filename: 'pages/login.page.ts',
      code: "const el = page.locator('#made-up-selector') // TODO-SELECTOR"
    }]
    const stats = computeGroundingStats(files, { elements })
    expect(stats.rate).toBe(0.5)
    expect(stats.todoCount).toBe(1)
  })
})

describe('hasExecutableTodoSelector (never ship an ungrounded selector as code)', () => {
  it('detects a TODO-SELECTOR embedded inside a locator string', () => {
    // Real defect: page.locator('// TODO-SELECTOR: .product-title') made
    // Playwright throw NamespaceError at runtime.
    expect(hasExecutableTodoSelector(`this.page.locator('// TODO-SELECTOR: .product-title')`)).toBe(true)
    expect(hasExecutableTodoSelector(`card.getByRole('button', { name: 'x' }) // TODO-SELECTOR`)).toBe(false)
  })

  it('detects it across the getBy* family and backticks', () => {
    expect(hasExecutableTodoSelector('page.getByTestId(`TODO-SELECTOR: foo`)')).toBe(true)
    expect(hasExecutableTodoSelector(`page.getByPlaceholder("TODO-SELECTOR: Search")`)).toBe(true)
  })

  it('leaves a plain comment marker alone', () => {
    expect(hasExecutableTodoSelector('// TODO-SELECTOR: wire this up\nawait this.locators.loginButton.click()')).toBe(false)
  })
})

describe('buildFixmeStub', () => {
  it('emits a loudly-skipped test instead of a broken selector', () => {
    const code = buildFixmeStub('tests/tc-011.spec.ts', 'ungrounded selector')
    expect(code).toContain('test.fixme(')
    expect(code).toContain('TC-011')
    expect(code).toContain('ungrounded selector')
    expect(hasExecutableTodoSelector(code)).toBe(false)
  })
})

describe('extractGotoPaths / isRouteMissing', () => {
  it('extracts every goto target, relative and absolute', () => {
    const code = `await page.goto('/sweets'); await page.goto("https://sweetshop.example.com/products")`
    expect(extractGotoPaths(code)).toEqual(['/sweets', 'https://sweetshop.example.com/products'])
  })

  it('treats 404/410/unreachable as missing but NOT auth-gated routes', () => {
    expect(isRouteMissing(404)).toBe(true)
    expect(isRouteMissing(410)).toBe(true)
    expect(isRouteMissing(0)).toBe(true)   // DNS failure / unreachable
    expect(isRouteMissing(200)).toBe(false)
    expect(isRouteMissing(401)).toBe(false) // exists, needs auth
    expect(isRouteMissing(403)).toBe(false) // exists, forbidden
  })
})

describe('findUngroundedLocators (invented-feature guard)', () => {
  const allowList = new Set([`page.getByRole('button',{name:'Add'})`.replace(/\s+/g, '')])

  it('flags a raw locator that is not in the grounded allow-list', () => {
    // The real defect: a search box that does not exist anywhere in the app.
    const code = `async searchForProduct(n) { await this.page.getByPlaceholder('Search').fill(n) }`
    expect(findUngroundedLocators(code, allowList)).toHaveLength(1)
  })

  it('accepts a grounded locator and ignores this.locators.* properties', () => {
    expect(findUngroundedLocators(`page.getByRole('button', { name: 'Add' })`, allowList)).toHaveLength(0)
    expect(findUngroundedLocators(`await this.locators.loginButton.click()`, allowList)).toHaveLength(0)
  })
})

describe('desyncLocatorGetter', () => {
  it('strips async from a getter that only returns a Locator', () => {
    const out = desyncLocatorGetter(`async getCard(name: string): Promise<Locator> {\n  return this.locators.card\n}`)
    expect(out.startsWith('async')).toBe(false)
    expect(out).toContain(': Locator')
  })

  it('leaves genuinely async methods alone', () => {
    const code = `async getTitle() {\n  await this.page.waitForLoadState()\n  return this.locators.title\n}`
    expect(desyncLocatorGetter(code)).toBe(code)
  })

  it('leaves non-getters alone', () => {
    const code = `async clickAdd() {\n  return this.locators.add.click()\n}`
    expect(desyncLocatorGetter(code)).toBe(code)
  })
})

describe('degradeUngroundedLocators (degrade, do not discard)', () => {
  const allowList = new Set([`page.getByRole('button',{name:'Add'})`.replace(/\s+/g, '')])

  it('converts a TODO-SELECTOR smuggled into a locator string into todoSelector()', () => {
    const { code, replaced } = degradeUngroundedLocators(
      `getCard(n) { return this.page.locator('// TODO-SELECTOR: .product-title') }`,
      allowList, true
    )
    expect(replaced).toBe(1)
    expect(code).toContain("this.todoSelector('.product-title')")
    expect(hasExecutableTodoSelector(code)).toBe(false)
  })

  it('replaces only the ungrounded locator, keeping grounded ones intact', () => {
    const src = `async run() {\n  await page.getByRole('button', { name: 'Add' }).click()\n  await this.page.getByPlaceholder('Search').fill('x')\n}`
    const { code, replaced } = degradeUngroundedLocators(src, allowList, true)
    expect(replaced).toBe(1)
    expect(code).toContain(`getByRole('button', { name: 'Add' })`) // grounded survives
    expect(code).toContain('this.todoSelector(')                    // invented stubbed
  })

  it('does not enforce the allow-list when there is no grounding', () => {
    const src = `async run() { await this.page.getByPlaceholder('Search').fill('x') }`
    expect(degradeUngroundedLocators(src, new Set(), false).replaced).toBe(0)
  })
})

describe('findMissingPageMethods (spec/page-object drift)', () => {
  it('flags a method the page object never defined', () => {
    // Real defect: TypeError: home.getAllProductCards is not a function
    const spec = `await home.getAllProductCards(); await home.clickAdd()`
    expect(findMissingPageMethods(spec, 'home', new Set(['clickAdd']))).toEqual(['getAllProductCards'])
  })

  it('allows inherited BasePage methods and locator property access', () => {
    const spec = `await home.goto('/x'); await home.todoSelector('y'); await home.locators.basketLink.click()`
    expect(findMissingPageMethods(spec, 'home', new Set())).toEqual([])
  })
})

describe('enforceTestTitle', () => {
  it('rewrites the title to the canonical TC-XXX: <summary> form', () => {
    const out = enforceTestTitle(`test('Verify Add to Basket button visibility', async () => {})`, 'tc-004', 'Add to basket')
    expect(out).toContain(`test('TC-004: Add to basket'`)
  })

  it('preserves modifiers like test.fixme', () => {
    const out = enforceTestTitle(`test.fixme('old', async () => {})`, 'tc-001', 'Thing')
    expect(out).toContain(`test.fixme('TC-001: Thing'`)
  })
})

describe('isGroundedLocator (chained locators must not be stubbed)', () => {
  const allowList = new Set([`page.locator('.card')`.replace(/\s+/g, '')])

  it('accepts a locator chained off a grounded collection base', () => {
    expect(isGroundedLocator(`page.locator('.card').filter({ hasText: 'Bon Bons' })`, allowList)).toBe(true)
    expect(isGroundedLocator(`this.page.locator('.card')`, allowList)).toBe(true)
  })

  it('rejects an entirely different locator', () => {
    expect(isGroundedLocator(`page.getByPlaceholder('Search')`, allowList)).toBe(false)
  })
})

describe('fixMisusedTodoSelector (grounded collection called through the wrong escape hatch)', () => {
  const collections = [
    { name: 'card', itemSelector: '.card', count: 4, fields: [{ name: 'addItem', selector: '.addItem', kind: 'other' as const }] }
  ]

  it('rewrites todoSelector(itemSelector) to the real locator', () => {
    // Real defect, found by actually generating and running a framework:
    // this.todoSelector('.card') resolves to [data-todo=".card"] — matching
    // nothing — even though '.card' is a genuinely grounded collection.
    const src = `getCardByName(name) {\n  const item = this.todoSelector('.card').filter({ hasText: name })\n  return item\n}`
    const { code, fixed } = fixMisusedTodoSelector(src, collections as any)
    expect(fixed).toBe(1)
    expect(code).toContain(`this.page.locator('.card')`)
    expect(code).not.toContain('todoSelector')
  })

  it('accepts the argument with or without a leading dot', () => {
    const { fixed } = fixMisusedTodoSelector(`this.todoSelector('card')`, collections as any)
    expect(fixed).toBe(1)
  })

  it('leaves a genuine todoSelector call alone (no matching collection)', () => {
    const src = `this.todoSelector('a filter dropdown with no stable hook')`
    const { code, fixed } = fixMisusedTodoSelector(src, collections as any)
    expect(fixed).toBe(0)
    expect(code).toBe(src)
  })

  it('also catches the call through a fixture variable, not just "this" (spec-file case)', () => {
    // Real defect: a SPEC calls it through the fixture (`home.todoSelector`),
    // not `this` (that's only valid inside a page-object method). The first
    // version of this regex was `this\.todoSelector` only and silently missed
    // this – found by generating from a real screenshot and running the result.
    const src = `home.todoSelector('.card').filter({ hasText: 'Bon Bons' })`
    const { code, fixed } = fixMisusedTodoSelector(src, collections as any)
    expect(fixed).toBe(1)
    expect(code).toContain(`home.page.locator('.card')`)
    expect(code).not.toContain('todoSelector')
  })
})

describe('findMissingLocatorProperties (property-access drift)', () => {
  it('flags access to a locator property that was never grounded', () => {
    // Real defect, found live: the model assumed a COLLECTION was also exposed
    // as sweets.locators.card, like individual grounded elements are. It is
    // not - tsc rejected it (TS2339), failing the whole framework's typecheck.
    const spec = `await expect(sweets.locators.card).toHaveCount(16)`
    expect(findMissingLocatorProperties(spec, 'sweets', new Set(['loginButton']))).toEqual(['card'])
  })

  it('allows access to a property that IS grounded', () => {
    const spec = `await expect(sweets.locators.addToBasketButton).toBeVisible()`
    expect(findMissingLocatorProperties(spec, 'sweets', new Set(['addToBasketButton']))).toEqual([])
  })
})
