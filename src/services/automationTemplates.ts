import type { TestCase, PlaywrightAutomationFile } from './aiService'

// Deterministic scaffolding for the generated Playwright project. Framework
// structure is identical every time – templates do it perfectly; the LLM is
// reserved for the only part that varies: translating case steps into actions.

export function buildPackageJson(projectName: string): string {
  return JSON.stringify(
    {
      name: projectName,
      version: '1.0.0',
      private: true,
      scripts: {
        test: 'playwright test',
        'test:headed': 'playwright test --headed',
        'test:ui': 'playwright test --ui',
        'test:debug': 'playwright test --debug',
        report: 'playwright show-report'
      },
      devDependencies: {
        '@playwright/test': '^1.48.0',
        // Playwright's own type defs reference Node globals (Buffer,
        // child_process). Without @types/node, `tsc --noEmit` fails on a fresh
        // install of EVERY generated project, before any test code is involved.
        '@types/node': '^22.7.0',
        typescript: '^5.5.0',
        dotenv: '^16.4.5'
      }
    },
    null,
    2
  )
}

export function buildTsconfig(): string {
  return JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        module: 'commonjs',
        moduleResolution: 'node',
        strict: true,
        sourceMap: true,
        outDir: './dist'
      },
      include: ['tests', 'pages', 'fixtures']
    },
    null,
    2
  )
}

export function buildPlaywrightConfig(baseUrl?: string, hasAuthSetup?: boolean): string {
  const authProject = hasAuthSetup
    ? `    { name: 'setup', testMatch: /.*\\.setup\\.ts/ },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], storageState: 'playwright/.auth/user.json' },
      dependencies: ['setup']
    }`
    : `    { name: 'chromium', use: { ...devices['Desktop Chrome'] } }`
  return `import { defineConfig, devices } from '@playwright/test'
import 'dotenv/config'

export default defineConfig({
  testDir: './tests',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: [['html', { open: 'never' }], ['list']],
  use: {
    // BASE_URL must win: the README, .env.example and the CI workflow all tell
    // the user to set it. A bare literal here would silently ignore all three.
    baseURL: process.env.BASE_URL || '${baseUrl || 'http://localhost:3000'}',
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure'
  },
  projects: [
${authProject}
  ]
})
`
}

// Only scaffolded when a login-like page was actually grounded – logs in
// ONCE and reuses the session across every test (Playwright's official
// recommended auth pattern), instead of each test re-authenticating.
export function buildAuthSetupFile(login?: { fixtureName: string; methodName?: string; loginPath?: string }): PlaywrightAutomationFile | null {
  if (!login) return null
  // Found by actually running a generated framework: this file called the
  // login method WITHOUT navigating to the login page first. On Playwright's
  // default blank start page, `.fill()`/`.click()` wait for an element that
  // will never appear, timing out the FULL test budget (45s) instead of
  // failing fast. Only emit a real goto() when the login page's URL is
  // actually known – never guess a route (same rule as goto() verification
  // elsewhere in this generator).
  const goto = login.loginPath
    ? `  await page.goto('${login.loginPath}')\n`
    : `  // TODO: this page's URL was not grounded – navigate to the login page here, e.g. await page.goto('/login')\n`

  // Call the LLM's ACTUAL method name, never a hardcoded guess like `.logIn()` –
  // the authored method is just as likely to be named `submitLogin`, `signIn`,
  // etc., and a hardcoded call compiles against nothing (TS2339) or silently
  // calls the wrong method if one of that exact name happens to exist elsewhere.
  const loginCall = login.methodName
    ? `${goto}  // Uses the grounded login page object's method.
  await ${login.fixtureName}.${login.methodName}(process.env.TEST_USER_EMAIL!, process.env.TEST_USER_PASSWORD!)`
    : `${goto}  // TODO-SELECTOR: no login method was authored for this page – wire up the real
  // fill/click steps here, e.g.:
  // await page.getByLabel('Email').fill(process.env.TEST_USER_EMAIL!)
  // await page.getByLabel('Password').fill(process.env.TEST_USER_PASSWORD!)
  // await page.getByRole('button', { name: 'Log in' }).click()`

  return {
    filename: 'tests/auth.setup.ts',
    code: `import { test as setup } from '../fixtures/base.fixture'

const authFile = 'playwright/.auth/user.json'

// Runs once before all other tests (see the "setup" project + "dependencies"
// in playwright.config.ts). Every other test reuses this saved session
// instead of re-logging-in, which is faster and avoids login-flow flakiness
// leaking into unrelated tests.
setup('authenticate', async ({ page, ${login.fixtureName} }) => {
${loginCall}
  await page.context().storageState({ path: authFile })
})
`
  }
}

export function buildGitignore(): string {
  return `node_modules/
test-results/
playwright-report/
playwright/.auth/
blob-report/
.env
`
}

export function buildEnvExample(): string {
  return `# Copy to .env and fill in real values – never commit .env itself.
BASE_URL=https://your-app.example.com
TEST_USER_EMAIL=test-user@example.com
TEST_USER_PASSWORD=change-me
`
}

export function buildCIWorkflow(): string {
  return `name: Playwright Tests
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
jobs:
  test:
    timeout-minutes: 30
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Install dependencies
        run: npm ci
      - name: Install Playwright browsers
        run: npx playwright install --with-deps chromium
      - name: Run Playwright tests
        run: npx playwright test
        env:
          BASE_URL: \${{ secrets.BASE_URL }}
          TEST_USER_EMAIL: \${{ secrets.TEST_USER_EMAIL }}
          TEST_USER_PASSWORD: \${{ secrets.TEST_USER_PASSWORD }}
      - uses: actions/upload-artifact@v4
        if: \${{ !cancelled() }}
        with:
          name: playwright-report
          path: playwright-report/
          retention-days: 14
`
}

export function buildBasePage(): string {
  return `import { Page, Locator, expect } from '@playwright/test'

/**
 * Base page object. Selectors marked TODO-SELECTOR were not found in the
 * provided element map / recording – replace them with real locators before
 * running.
 */
export class BasePage {
  // Public, not protected: standard Playwright POM convention – specs
  // occasionally need somePage.page as an escape hatch (e.g. a one-off
  // assertion with no dedicated method yet), and it must be reachable from
  // OUTSIDE the class, not just from subclasses.
  constructor(readonly page: Page) {}

  async goto(path = '/') {
    await this.page.goto(path)
  }

  /** Placeholder locator for elements the generator could not ground. */
  todoSelector(description: string): Locator {
    // TODO-SELECTOR: replace with a real locator for: ${'${description}'}
    return this.page.locator(\`[data-todo="\${description}"]\`)
  }

  async expectToast(message: string | RegExp) {
    await expect(this.page.getByText(message).first()).toBeVisible()
  }
}
`
}

export function buildReadme(projectName: string, testCases: TestCase[], groundedSelectors: boolean): string {
  const caseList = testCases.map(tc => `- **${tc.id}** – ${tc.summary} (${tc.scenarioType})`).join('\n')
  return `# ${projectName} – Playwright Test Suite

Generated by BLAST FW from ${testCases.length} test case(s), structured as a proper Page Object Model (POM) framework.

## Setup

\`\`\`bash
npm install
npx playwright install chromium
cp .env.example .env   # fill in BASE_URL and test credentials
npm test
\`\`\`

## Framework structure

\`\`\`
pages/
  base.page.ts             Shared base class every page object extends
  locators/<page>.locators.ts   ONLY locators for that page – deterministic, never hand-edited
  <page>.page.ts            Composes the locators class, exposes semantic action methods
components/
  modal.component.ts        Generic dialog/modal helper
  toast.component.ts        Generic toast/snackbar helper
  tooltip.component.ts       Generic tooltip helper
  navbar.component.ts        Generic navigation helper
fixtures/
  base.fixture.ts           One fixture per page object + shared components
tests/
  auth.setup.ts             (only if a login page was grounded) logs in once, reused by every test
  <tc-id>.spec.ts           One spec per test case – calls fixtures/methods only, no raw selectors
.github/workflows/
  playwright.yml            CI workflow – runs on push/PR, uploads the HTML report as an artifact
\`\`\`

Test files should never contain \`page.getByRole(...)\` etc. directly – every interaction goes through
a page object property (\`loginPage.locators.emailInput\`) or a semantic method (\`loginPage.login(...)\`).
This keeps spec files short and readable, and means a selector only needs to be fixed in one place if the
app's markup changes.

Each test is independent by design – none rely on another test's leftover state, so they're safe to run
in parallel or in any order (see \`playwright.config.ts\`'s \`workers\`/\`retries\` settings for CI).

If a login page was grounded, \`tests/auth.setup.ts\` signs in once and every other test reuses that
session via \`storageState\` (see \`playwright.config.ts\`) instead of re-logging-in per test – set
\`TEST_USER_EMAIL\`/\`TEST_USER_PASSWORD\` in \`.env\` (or as CI secrets) for this to work.

## Selector grounding

${groundedSelectors
    ? 'Selectors in `pages/locators/*.ts` were grounded in a provided DOM snapshot / recorded session / fetched URL. Spot-check anything marked `TODO-SELECTOR` inside page-object methods – those targets were not present in the provided context.'
    : '**No DOM snapshot, recording, or URL was provided** – locators are conventions/guesses, authored as page-object methods marked `TODO-SELECTOR`. Provide a DOM snapshot or codegen recording and regenerate for real, verified selectors.'}

## Covered test cases

${caseList}
`
}
