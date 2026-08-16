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
import { buildAutomationSuite } from './automationBuilder'
import { analyzeFramework } from './frameworkAnalyzer'
import type { TestCase } from './aiService'

const mockComplete = aiService.complete as ReturnType<typeof vi.fn>

const frameworkFiles = [
  {
    path: 'src/pages/login.page.ts',
    content: `import { Locator, Page } from '@playwright/test';

export class LoginPage {
  readonly emailInput: Locator = this.page.getByTestId('email');
  readonly submitButton: Locator = this.page.getByTestId('submit');

  constructor(readonly page: Page) {}

  async login(email: string, password: string) {
    await this.emailInput.fill(email);
    await this.submitButton.click();
  }
}
`
  },
  {
    path: 'src/fixtures/base.fixture.ts',
    content: `import { test as base } from '@playwright/test';
import { LoginPage } from '../pages/login.page';

export const test = base.extend<{ loginPage: LoginPage }>({
  loginPage: async ({ page }, use) => { await use(new LoginPage(page)); }
});
export { expect } from '@playwright/test';
`
  },
  {
    path: 'src/tests/smoke.spec.ts',
    content: "import { test, expect } from '../fixtures/base.fixture';\n\ntest('smoke', async () => {});\n"
  }
]

const testCase = (id: string, summary: string): TestCase => ({
  id,
  summary,
  issueType: 'Test',
  priority: 'High',
  labels: 'functional',
  testType: 'Functional',
  precondition: '',
  steps: [{ stepNumber: 1, action: 'sign in', testData: '', expectedResult: 'dashboard' }],
  status: 'Not Executed',
  component: 'Auth',
  estimatedTime: '5m',
  scenarioType: 'happy_path'
})

const framework = () => analyzeFramework(frameworkFiles, 'shop-e2e')

const build = (overrides: Record<string, unknown> = {}) =>
  buildAutomationSuite({
    provider: 'gemini',
    apiKey: 'k',
    model: 'm',
    projectName: 'shop',
    testCases: [testCase('TC-001', 'user signs in')],
    framework: framework(),
    ...overrides
  })

beforeEach(() => mockComplete.mockReset())

describe('framework-aware suite generation', () => {
  it('writes specs against the user’s fixtures and does not scaffold a parallel POM', async () => {
    mockComplete.mockResolvedValueOnce(
      JSON.stringify({
        testFiles: [
          {
            filename: 'src/tests/login.spec.ts',
            code: "import { test, expect } from '../fixtures/base.fixture';\n\ntest('TC-001 user signs in', async ({ loginPage }) => {\n  await loginPage.login('a@b.com', 'pw');\n});\n"
          }
        ]
      })
    )

    const suite = await build()
    const names = suite.testFiles.map(f => f.filename)

    expect(suite.frameworkAware).toBe(true)
    expect(names).toContain('src/tests/login.spec.ts')
    // The user's framework already provides these – generating our own would collide.
    expect(names).not.toContain('pages/base.page.ts')
    expect(names).not.toContain('fixtures/base.fixture.ts')
    expect(names.some(n => n.startsWith('pages/locators/'))).toBe(false)

    const prompt = mockComplete.mock.calls[0][3] as string
    expect(prompt).toContain('class LoginPage')
    expect(prompt).toContain('async login(email: string, password: string)')
    expect(prompt).toContain('loginPage')
  })

  it('splices a newly authored method into the user’s real page-object file', async () => {
    mockComplete.mockResolvedValueOnce(
      JSON.stringify({
        testFiles: [
          {
            filename: 'src/tests/login.spec.ts',
            code: "import { test, expect } from '../fixtures/base.fixture';\n\ntest('TC-001 user signs in', async ({ loginPage }) => {\n  await loginPage.loginAsAdmin();\n});\n"
          }
        ],
        pageMethods: [
          { page: 'LoginPage', code: 'async loginAsAdmin() {\n  await this.emailInput.fill(\'admin@example.com\');\n  await this.submitButton.click();\n}' }
        ]
      })
    )

    const suite = await build()
    const updated = suite.testFiles.find(f => f.filename === 'src/pages/login.page.ts')

    expect(updated).toBeDefined()
    // Original content preserved, new method added – a drop-in replacement.
    expect(updated!.code).toContain('async login(email: string, password: string)')
    expect(updated!.code).toContain('async loginAsAdmin()')
    expect(suite.reusedPageClasses).toEqual(['LoginPage'])
    // The spec calls a method that now exists, so it must not be stubbed out.
    const spec = suite.testFiles.find(f => f.filename === 'src/tests/login.spec.ts')!
    expect(spec.code).not.toContain('test.fixme')
  })

  it('keeps the user’s implementation when the model re-authors an existing method', async () => {
    mockComplete.mockResolvedValueOnce(
      JSON.stringify({
        testFiles: [
          { filename: 'src/tests/login.spec.ts', code: "import { test, expect } from '../fixtures/base.fixture';\ntest('TC-001 a', async ({ loginPage }) => { await loginPage.login('a', 'b'); });" }
        ],
        pageMethods: [{ page: 'LoginPage', code: 'async login(email: string) {\n  // a worse implementation\n}' }]
      })
    )

    const suite = await build()
    expect(suite.testFiles.find(f => f.filename === 'src/pages/login.page.ts')).toBeUndefined()
    expect(suite.warnings.join(' ')).toMatch(/already exists in your framework/)
  })

  it('stubs a spec that calls a method neither the framework nor this run defines', async () => {
    mockComplete.mockResolvedValueOnce(
      JSON.stringify({
        testFiles: [
          { filename: 'src/tests/login.spec.ts', code: "import { test, expect } from '../fixtures/base.fixture';\ntest('TC-001 a', async ({ loginPage }) => { await loginPage.doesNotExist(); });" }
        ]
      })
    )

    const suite = await build()
    const spec = suite.testFiles.find(f => f.filename === 'src/tests/login.spec.ts')!
    expect(spec.code).toContain('test.fixme')
    expect(suite.warnings.join(' ')).toMatch(/loginPage\.doesNotExist\(\)/)
  })

  it('reports test cases that produced no spec instead of silently dropping them', async () => {
    mockComplete.mockResolvedValueOnce(
      JSON.stringify({
        testFiles: [
          { filename: 'src/tests/login.spec.ts', code: "import { test, expect } from '../fixtures/base.fixture';\ntest('TC-001 a', async ({ loginPage }) => { await loginPage.login('a','b'); });" }
        ]
      })
    )

    const suite = await buildAutomationSuite({
      provider: 'gemini',
      apiKey: 'k',
      model: 'm',
      projectName: 'shop',
      testCases: [testCase('TC-001', 'signs in'), testCase('TC-002', 'shows an error')],
      framework: framework()
    })
    expect(suite.warnings.join(' ')).toMatch(/TC-002/)
  })

  it('falls back to the generated POM scaffold when no framework is supplied', async () => {
    mockComplete.mockResolvedValueOnce(
      JSON.stringify({
        testFiles: [{ filename: 'tests/tc-001.spec.ts', code: "import { test, expect } from '../fixtures/base.fixture'\ntest('TC-001 a', async ({ app }) => {})" }]
      })
    )

    const suite = await buildAutomationSuite({
      provider: 'gemini',
      apiKey: 'k',
      model: 'm',
      projectName: 'shop',
      testCases: [testCase('TC-001', 'user signs in')]
    })
    expect(suite.frameworkAware).toBe(false)
    expect(suite.testFiles.map(f => f.filename)).toContain('pages/base.page.ts')
  })
})
