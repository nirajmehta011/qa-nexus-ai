import { describe, it, expect } from 'vitest'
import {
  toSafeIdentifier,
  slugify, pascalCase, camelCase, derivePropertyName,
  actionsToElements, groupTargetsByPage, buildPageDefinitions,
  buildLocatorsFile, buildPageObjectShell, assemblePageObjectFile,
  extractMethodName, buildComponentFiles, buildFixturesFile,
  type PageDefinition
} from './pomBuilder'
import type { ElementEntry } from './domDistiller'
import type { RecordedAction } from './codegenParser'

describe('naming helpers', () => {
  it('slugify produces kebab-case, handling camelCase input', () => {
    expect(slugify('Login Page')).toBe('login-page')
    expect(slugify('DashboardHome')).toBe('dashboard-home')
    expect(slugify('  Weird!! Name__ ')).toBe('weird-name')
  })

  it('pascalCase and camelCase produce class/property-safe names', () => {
    expect(pascalCase('login page')).toBe('LoginPage')
    expect(camelCase('Login Page')).toBe('loginPage')
  })

  it('falls back to App for empty/unusable names', () => {
    expect(pascalCase('')).toBe('App')
    expect(pascalCase('!!!')).toBe('App')
  })
})

describe('toSafeIdentifier (JS identifiers may not start with a digit)', () => {
  it('strips leading digits from UI-text-derived names', () => {
    // Real defect: a basket badge reading "0 Basket" emitted `0BasketLink`,
    // a SyntaxError that broke every spec importing the locators file.
    expect(toSafeIdentifier('0BasketLink')).toBe('basketLink')
    expect(toSafeIdentifier('123')).toBe('element')
  })

  it('drops characters that are illegal in identifiers', () => {
    expect(toSafeIdentifier('add-to basket!')).toBe('addtobasket')
  })
})

describe('derivePropertyName', () => {
  it('never emits an identifier starting with a digit (regression: 0BasketLink)', () => {
    const name = derivePropertyName('0 Basket', 'link', new Set())
    expect(name).toBe('basketLink')
    expect(name).toMatch(/^[A-Za-z_$]/)
  })

  it('appends a kind suffix based on element type', () => {
    const used = new Set<string>()
    expect(derivePropertyName('Email address', 'input', used)).toBe('emailAddressInput')
    expect(derivePropertyName('Log in', 'button', used)).toBe('logInButton')
    expect(derivePropertyName('Settings', 'link', used)).toBe('settingsLink')
  })

  it('does not double the suffix if the label already ends with it', () => {
    const used = new Set<string>()
    expect(derivePropertyName('Submit Button', 'button', used)).toBe('submitButton')
  })

  it('dedupes collisions with a numeric suffix', () => {
    const used = new Set<string>()
    const first = derivePropertyName('Name', 'input', used)
    const second = derivePropertyName('Name', 'input', used)
    expect(first).not.toBe(second)
    expect(second).toBe(`${first}2`)
  })
})

describe('actionsToElements', () => {
  const actions: RecordedAction[] = [
    { locator: "page.getByTestId('save-btn')", action: 'click', page: 'Settings' },
    { locator: "page.getByRole('button', { name: 'Log in' })", action: 'click', page: 'Login' },
    { locator: "page.getByPlaceholder('Email')", action: 'fill', value: 'a@b.com', page: 'Login' },
    { locator: "page.getByLabel('Remember me')", action: 'check', page: 'Login' },
    { locator: "page.locator('#theme-select')", action: 'selectOption', page: 'Settings' }
  ]

  it('extracts a readable label from each locator style', () => {
    const [testId, role, placeholder, label] = actionsToElements(actions)
    expect(testId.label).toBe('save-btn')
    expect(role.label).toBe('Log in')
    expect(placeholder.label).toBe('Email')
    expect(label.label).toBe('Remember me')
  })

  it('infers kind from the action verb / locator shape', () => {
    const els = actionsToElements(actions)
    expect(els[1].kind).toBe('button') // click on getByRole('button', ...)
    expect(els[2].kind).toBe('input')  // fill
    expect(els[3].kind).toBe('checkbox') // check
    expect(els[4].kind).toBe('select') // selectOption
  })

  it('preserves the page tag', () => {
    const els = actionsToElements(actions)
    expect(els[0].page).toBe('Settings')
    expect(els[1].page).toBe('Login')
  })
})

describe('groupTargetsByPage', () => {
  const elements: ElementEntry[] = [
    { selector: "page.getByTestId('email')", tag: 'input', label: 'Email', kind: 'input', page: 'Login' }
  ]
  const actions: RecordedAction[] = [
    { locator: "page.getByTestId('email')", action: 'fill', value: 'x', page: 'Login' }, // dup of above
    { locator: "page.getByRole('button', { name: 'Log out' })", action: 'click', page: 'Dashboard' }
  ]

  it('merges elements and actions, deduping by selector within a page', () => {
    const grouped = groupTargetsByPage(elements, actions)
    expect(grouped.get('Login')).toHaveLength(1) // deduped
    expect(grouped.get('Dashboard')).toHaveLength(1)
  })

  it('buckets untagged targets under "App"', () => {
    const untagged: ElementEntry[] = [{ selector: "page.getByText('Hi')", tag: 'div', label: 'Hi', kind: 'other' }]
    const grouped = groupTargetsByPage(untagged, [])
    expect(grouped.get('App')).toHaveLength(1)
  })
})

describe('buildPageDefinitions', () => {
  it('creates one page per distinct page tag with deduped property names', () => {
    const elements: ElementEntry[] = [
      { selector: "page.getByTestId('email')", tag: 'input', label: 'Email', kind: 'input', page: 'Login' },
      { selector: "page.getByRole('button', { name: 'Log in' })", tag: 'button', label: 'Log in', kind: 'button', page: 'Login' },
      { selector: "page.getByTestId('logout')", tag: 'button', label: 'Log out', kind: 'button', page: 'Dashboard' }
    ]
    const pages = buildPageDefinitions(elements, [])
    expect(pages.map(p => p.className).sort()).toEqual(['Dashboard', 'Login'])
    const login = pages.find(p => p.name === 'Login')!
    expect(login.properties.map(p => p.name)).toEqual(['emailInput', 'logInButton'])
  })

  it('falls back to a single empty App page when there is no grounding at all', () => {
    const pages = buildPageDefinitions([], [])
    expect(pages).toHaveLength(1)
    expect(pages[0].name).toBe('App')
    expect(pages[0].properties).toHaveLength(0)
  })
})

describe('buildLocatorsFile', () => {
  it('generates a deterministic locators class with readonly fields and constructor init', () => {
    const page: PageDefinition = {
      name: 'Login', slug: 'login', className: 'Login',
      properties: [{ name: 'emailInput', selector: "page.getByTestId('email')", label: 'Email', kind: 'input' }]
    }
    const file = buildLocatorsFile(page)
    expect(file.filename).toBe('pages/locators/login.locators.ts')
    expect(file.code).toContain('readonly emailInput: Locator')
    expect(file.code).toContain("this.emailInput = page.getByTestId('email')")
    expect(file.code).toContain('export class LoginLocators')
  })

  it('handles a page with zero properties gracefully', () => {
    const page: PageDefinition = { name: 'App', slug: 'app', className: 'App', properties: [] }
    const file = buildLocatorsFile(page)
    expect(file.code).toContain('No grounded elements were provided')
  })
})

describe('page object assembly', () => {
  const page: PageDefinition = {
    name: 'Login', slug: 'login', className: 'Login',
    properties: [{ name: 'emailInput', selector: "page.getByTestId('email')", label: 'Email', kind: 'input' }]
  }

  it('shell composes the locators class and extends BasePage', () => {
    const { header, footer } = buildPageObjectShell(page)
    expect(header).toContain("import { LoginLocators } from './locators/login.locators'")
    expect(header).toContain('export class Login extends BasePage')
    expect(footer.trim().endsWith('}')).toBe(true)
  })

  it('splices deduped method blocks into the shell', () => {
    const file = assemblePageObjectFile(page, [
      '  async fillEmail(value: string) {\n    await this.locators.emailInput.fill(value)\n  }'
    ])
    expect(file.filename).toBe('pages/login.page.ts')
    expect(file.code).toContain('async fillEmail(value: string)')
    expect(file.code).toContain('this.locators.emailInput.fill(value)')
  })

  it('shows a friendly placeholder when no methods were authored', () => {
    const file = assemblePageObjectFile(page, [])
    expect(file.code).toContain('call locators directly')
  })
})

describe('extractMethodName', () => {
  it('extracts plain and async method names', () => {
    expect(extractMethodName('login(email, password) {}')).toBe('login')
    expect(extractMethodName('  async requestReset(email: string) {\n...\n}')).toBe('requestReset')
  })

  it('returns null for unparseable input', () => {
    expect(extractMethodName('not a method')).toBeNull()
  })
})

describe('buildComponentFiles', () => {
  it('generates the standard set of reusable UI components', () => {
    const files = buildComponentFiles()
    const names = files.map(f => f.filename)
    expect(names).toEqual([
      'components/modal.component.ts',
      'components/toast.component.ts',
      'components/tooltip.component.ts',
      'components/navbar.component.ts'
    ])
    expect(files.every(f => f.code.includes('export class'))).toBe(true)
  })
})

describe('buildFixturesFile', () => {
  it('wires one fixture per page plus the shared components', () => {
    const pages: PageDefinition[] = [
      { name: 'Login', slug: 'login', className: 'Login', properties: [] },
      { name: 'Dashboard', slug: 'dashboard', className: 'Dashboard', properties: [] }
    ]
    const file = buildFixturesFile(pages)
    expect(file.filename).toBe('fixtures/base.fixture.ts')
    expect(file.code).toContain("import { Login } from '../pages/login.page'")
    expect(file.code).toContain("import { Dashboard } from '../pages/dashboard.page'")
    expect(file.code).toContain('login: Login')
    expect(file.code).toContain('dashboard: Dashboard')
    expect(file.code).toContain('modal: ModalComponent')
    expect(file.code).toContain("new Login(page)")
  })
})
