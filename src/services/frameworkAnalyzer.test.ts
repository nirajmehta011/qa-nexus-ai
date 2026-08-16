import { describe, it, expect } from 'vitest'
import {
  analyzeFramework,
  buildFrameworkPromptContext,
  extractFixtures,
  extractPageObjects,
  spliceMethodsIntoClass,
  type RawFile
} from './frameworkAnalyzer'

const loginPage: RawFile = {
  path: 'src/pages/login.page.ts',
  content: `import { Page, Locator, expect } from '@playwright/test';
import { BasePage } from './base.page';

export class LoginPage extends BasePage {
  readonly emailInput: Locator = this.page.getByTestId('login-email');
  readonly passwordInput = this.page.getByTestId('login-password');
  private submitButton: Locator;

  constructor(page: Page) {
    super(page);
    this.submitButton = page.getByRole('button', { name: 'Sign in' });
  }

  // A comment mentioning this.page.locator('fake') must not create a locator.
  async login(email: string, password: string) {
    await this.emailInput.fill(email);
    await this.passwordInput.fill(password);
    await this.submitButton.click();
  }

  async expectLoginError(message: string) {
    await expect(this.page.getByRole('alert')).toHaveText(message);
  }
}
`
}

const cartPage: RawFile = {
  path: 'src/pages/cart.page.ts',
  content: `import { Locator } from '@playwright/test';

export class CartPage {
  get checkoutButton(): Locator {
    return this.page.getByRole('button', { name: 'Checkout' });
  }

  async removeItem(sku: string) {
    await this.page.getByTestId(\`remove-\${sku}\`).click();
  }
}
`
}

const fixtures: RawFile = {
  path: 'src/fixtures/base.fixture.ts',
  content: `import { test as base } from '@playwright/test';
import { LoginPage } from '../pages/login.page';
import { CartPage } from '../pages/cart.page';

export const test = base.extend<{ loginPage: LoginPage; cartPage: CartPage }>({
  loginPage: async ({ page }, use) => { await use(new LoginPage(page)); },
  cartPage: async ({ page }, use) => { await use(new CartPage(page)); }
});
export { expect } from '@playwright/test';
`
}

const spec: RawFile = {
  path: 'src/tests/login.spec.ts',
  content: `import { test, expect } from '../fixtures/base.fixture';

test('TC-001 user signs in', async ({ loginPage }) => {
  await loginPage.login('a@b.com', 'pw');
});
`
}

const config: RawFile = {
  path: 'playwright.config.ts',
  content: `import { defineConfig } from '@playwright/test';
export default defineConfig({ use: { baseURL: process.env.BASE_URL || 'https://shop.example.com' } });
`
}

const files = [loginPage, cartPage, fixtures, spec, config]

describe('extractPageObjects', () => {
  it('finds classes, their locators and their methods', () => {
    const pages = extractPageObjects(files)
    const login = pages.find(p => p.className === 'LoginPage')

    expect(login).toBeDefined()
    expect(login!.extendsClass).toBe('BasePage')
    expect(login!.locators).toEqual(expect.arrayContaining(['emailInput', 'passwordInput', 'submitButton']))
    expect(login!.methods.map(m => m.name)).toEqual(expect.arrayContaining(['login', 'expectLoginError']))
    expect(login!.methods.find(m => m.name === 'login')!.isAsync).toBe(true)
  })

  it('treats a locator getter as a locator, not a method', () => {
    const cart = extractPageObjects(files).find(p => p.className === 'CartPage')!
    expect(cart.locators).toContain('checkoutButton')
    expect(cart.methods.map(m => m.name)).toContain('removeItem')
  })

  it('ignores locator calls that only appear inside comments', () => {
    const login = extractPageObjects(files).find(p => p.className === 'LoginPage')!
    expect(login.locators).not.toContain('fake')
  })

  it('does not treat a plain data class as a page object', () => {
    const pages = extractPageObjects([
      { path: 'src/utils/user.ts', content: 'export class User { constructor(public name: string) {} }' }
    ])
    expect(pages).toHaveLength(0)
  })
})

describe('extractFixtures', () => {
  it('reads fixture names and their page-object types', () => {
    expect(extractFixtures(files)).toEqual([
      { name: 'loginPage', type: 'LoginPage', filePath: 'src/fixtures/base.fixture.ts' },
      { name: 'cartPage', type: 'CartPage', filePath: 'src/fixtures/base.fixture.ts' }
    ])
  })
})

describe('analyzeFramework', () => {
  it('derives conventions from the repository layout', () => {
    const profile = analyzeFramework(files, 'shop-e2e')

    expect(profile.conventions.pageFileNaming).toBe('login.page.ts')
    expect(profile.conventions.specFileNaming).toBe('login.spec.ts')
    expect(profile.conventions.pageDir).toBe('src/pages')
    expect(profile.conventions.specDir).toBe('src/tests')
    expect(profile.conventions.locatorStrategy).toMatch(/getByTestId|getByRole/)
    expect(profile.conventions.quoteStyle).toBe('single')
    expect(profile.conventions.usesSemicolons).toBe(true)
    expect(profile.baseUrl).toBe('https://shop.example.com')
    expect(profile.warnings).toHaveLength(0)
  })

  it('warns instead of failing when no page objects are present', () => {
    const profile = analyzeFramework(
      [{ path: 'tests/smoke.spec.ts', content: "import { test } from '@playwright/test'\ntest('a', async () => {})" }],
      'bare'
    )
    expect(profile.pages).toHaveLength(0)
    expect(profile.warnings.join(' ')).toMatch(/No page-object classes/)
  })
})

describe('buildFrameworkPromptContext', () => {
  it('lists reusable classes, methods and fixtures for the prompt', () => {
    const context = buildFrameworkPromptContext(analyzeFramework(files, 'shop-e2e'))

    expect(context).toContain('class LoginPage extends BasePage')
    expect(context).toContain('async login(email: string, password: string)')
    expect(context).toContain('loginPage: LoginPage')
    expect(context).toContain('REUSE THESE, DO NOT REDEFINE THEM')
    expect(context).toContain('src/pages/')
  })
})

describe('spliceMethodsIntoClass', () => {
  const source = `import { Page } from '@playwright/test';

export class LoginPage extends BasePage {
  readonly emailInput = this.page.getByTestId('email');

  async login(email: string) {
    await this.emailInput.fill(email);
  }
}
`

  it('inserts new methods before the class closing brace', () => {
    const result = spliceMethodsIntoClass(source, 'LoginPage', [
      "async loginAsAdmin() {\n  await this.login('admin@example.com');\n}"
    ])!

    expect(result).toContain('async login(email: string)')
    expect(result).toContain('async loginAsAdmin()')
    // the original method must still come first, and the class must still close
    expect(result.indexOf('async login(email')).toBeLessThan(result.indexOf('async loginAsAdmin'))
    expect(result.trimEnd().endsWith('}')).toBe(true)
    // brace balance preserved
    expect((result.match(/{/g) || []).length).toBe((result.match(/}/g) || []).length)
  })

  it('indents inserted methods to match the file', () => {
    const result = spliceMethodsIntoClass(source, 'LoginPage', ['async ping() {\n  return 1;\n}'], '  ')!
    expect(result).toContain('\n  async ping() {')
  })

  it('returns the source unchanged when there is nothing to add', () => {
    expect(spliceMethodsIntoClass(source, 'LoginPage', [])).toBe(source)
  })

  it('returns null for an unknown class rather than corrupting the file', () => {
    expect(spliceMethodsIntoClass(source, 'CheckoutPage', ['async x() {}'])).toBeNull()
  })

  it('picks the right class when a file declares several', () => {
    const multi = 'class A {\n  async a() {}\n}\n\nclass B {\n  async b() {}\n}\n'
    const result = spliceMethodsIntoClass(multi, 'A', ['async added() {}'])!
    expect(result.indexOf('async added')).toBeLessThan(result.indexOf('class B'))
  })
})
