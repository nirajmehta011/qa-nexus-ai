import { describe, it, expect } from 'vitest'
import {
  buildPlaywrightConfig,
  buildAuthSetupFile,
  buildGitignore,
  buildEnvExample,
  buildCIWorkflow,
  buildPackageJson
} from './automationTemplates'

describe('buildPlaywrightConfig', () => {
  it('uses a single chromium project with no auth setup by default', () => {
    const config = buildPlaywrightConfig('https://app.example.com', false)
    expect(config).not.toContain("name: 'setup'")
    expect(config).not.toContain('storageState')
    expect(config).toContain("baseURL: process.env.BASE_URL || 'https://app.example.com'")
  })

  it('adds a setup project + storageState dependency when auth setup is requested', () => {
    const config = buildPlaywrightConfig('https://app.example.com', true)
    expect(config).toContain("name: 'setup'")
    expect(config).toContain("storageState: 'playwright/.auth/user.json'")
    expect(config).toContain("dependencies: ['setup']")
  })

  it('loads dotenv and falls back to BASE_URL env var when no baseUrl given', () => {
    const config = buildPlaywrightConfig(undefined, false)
    expect(config).toContain("import 'dotenv/config'")
    expect(config).toContain('process.env.BASE_URL')
  })
})

describe('buildAuthSetupFile', () => {
  it('returns null when no login page was grounded', () => {
    expect(buildAuthSetupFile(undefined)).toBeNull()
  })

  it('calls the ACTUAL authored method name, not a hardcoded guess', () => {
    // Real defect, found by generating a live framework and running it: the
    // LLM authored `submitLogin(...)`, but this template hardcoded `.logIn(...)`
    // regardless — tsc failed with "Property 'logIn' does not exist on type
    // 'Login'" because no such method was ever generated.
    const file = buildAuthSetupFile({ fixtureName: 'login', methodName: 'submitLogin', loginPath: '/login' })
    expect(file).not.toBeNull()
    expect(file!.filename).toBe('tests/auth.setup.ts')
    expect(file!.code).toContain('login.submitLogin(')
    expect(file!.code).not.toContain('login.logIn(')
    expect(file!.code).toContain("storageState({ path: authFile })")
  })

  it('navigates to the known login path before calling the login method', () => {
    // Real defect, found by actually running a generated framework: this file
    // called the login method with the browser still on about:blank, so
    // .fill() waited for an element that would never appear, timing out the
    // FULL 45s test budget instead of failing instantly.
    const file = buildAuthSetupFile({ fixtureName: 'login', methodName: 'submitLogin', loginPath: '/login' })
    const code = file!.code
    const gotoIndex = code.indexOf("page.goto('/login')")
    const callIndex = code.indexOf('login.submitLogin(')
    expect(gotoIndex).toBeGreaterThan(-1)
    expect(gotoIndex).toBeLessThan(callIndex) // navigation happens BEFORE the login call
  })

  it('never guesses a login path when none was grounded – flags it instead', () => {
    const file = buildAuthSetupFile({ fixtureName: 'login', methodName: 'submitLogin', loginPath: undefined })
    // No EXECUTABLE goto (a commented TODO mentioning the idea is fine/expected).
    expect(file!.code).not.toMatch(/^\s*await page\.goto\(/m)
    expect(file!.code).toMatch(/TODO.*navigate to the login page/)
  })

  it('falls back to a TODO-SELECTOR scaffold when no login method was authored', () => {
    const file = buildAuthSetupFile({ fixtureName: 'login', methodName: undefined })
    expect(file!.code).toContain('TODO-SELECTOR')
    expect(file!.code).not.toContain('login.logIn(')
  })
})

describe('support file templates', () => {
  it('gitignore excludes secrets and generated artifacts', () => {
    const gi = buildGitignore()
    expect(gi).toContain('.env')
    expect(gi).toContain('playwright/.auth/')
    expect(gi).toContain('node_modules/')
  })

  it('env example documents required variables without real secrets', () => {
    const env = buildEnvExample()
    expect(env).toContain('BASE_URL=')
    expect(env).toContain('TEST_USER_EMAIL=')
    expect(env).toContain('TEST_USER_PASSWORD=')
  })

  it('CI workflow installs browsers, runs tests, and uploads the report', () => {
    const ci = buildCIWorkflow()
    expect(ci).toContain('npx playwright install --with-deps chromium')
    expect(ci).toContain('npx playwright test')
    expect(ci).toContain('actions/upload-artifact')
  })

  it('package.json declares dotenv as a dependency for env-based config', () => {
    const pkg = JSON.parse(buildPackageJson('my-suite'))
    expect(pkg.devDependencies.dotenv).toBeDefined()
  })
})

describe('generated project template defects', () => {
  it('includes @types/node so tsc --noEmit passes on a fresh install', () => {
    // Playwright's type defs reference Node globals; without this every
    // generated project fails typecheck before any test code is involved.
    expect(JSON.parse(buildPackageJson('demo')).devDependencies).toHaveProperty('@types/node')
  })

  it('honours BASE_URL over the grounded literal', () => {
    expect(buildPlaywrightConfig('https://grounded.example.com')).toContain(
      "baseURL: process.env.BASE_URL || 'https://grounded.example.com'"
    )
  })
})
