import type { PlaywrightAutomationFile } from './aiService'
import type { ElementEntry } from './domDistiller'
import type { RecordedAction } from './codegenParser'

// Builds a proper industry-standard Page Object Model framework:
//   pages/locators/<page>.locators.ts   – ONLY locators, deterministic, zero LLM
//   pages/<page>.page.ts                – composes locators, exposes action methods
//   components/*.component.ts           – shared reusable widgets (modal/toast/tooltip/navbar)
//   fixtures/base.fixture.ts            – one fixture per page object + component
// The LLM's only job is authoring page-object METHOD bodies and the spec
// files that call them – it never touches the locators layer, so that layer
// can never be hallucinated.

export interface PageProperty {
  name: string
  selector: string
  label: string
  kind: ElementEntry['kind']
}

export interface PageDefinition {
  name: string
  slug: string
  className: string
  properties: PageProperty[]
}

// ── Naming helpers ─────────────────────────────────────────────────────────

export function slugify(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'app'
}

export function pascalCase(name: string): string {
  const words = name.replace(/([a-z])([A-Z])/g, '$1 $2').split(/[^a-zA-Z0-9]+/).filter(Boolean)
  return words.map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join('') || 'App'
}

export function camelCase(name: string): string {
  const pascal = pascalCase(name)
  return pascal.charAt(0).toLowerCase() + pascal.slice(1)
}

const KIND_SUFFIX: Record<ElementEntry['kind'], string> = {
  button: 'Button', link: 'Link', input: 'Input', select: 'Select',
  textarea: 'Textarea', checkbox: 'Checkbox', radio: 'Radio', other: 'Element'
}

// A JS identifier may not start with a digit. UI text is piped into property
// names, so a basket badge reading "0 Basket" produced `0BasketLink` – a
// SyntaxError that fails the whole locators file (and therefore every spec that
// imports it). Strip leading digits; fall back to a safe name if nothing remains.
export function toSafeIdentifier(raw: string): string {
  const stripped = raw.replace(/[^A-Za-z0-9_$]/g, '').replace(/^[0-9]+/, '')
  if (!stripped) return 'element'
  return stripped.charAt(0).toLowerCase() + stripped.slice(1)
}

// Deterministic, collision-safe property name: "Email address" + input -> emailAddressInput
export function derivePropertyName(label: string, kind: ElementEntry['kind'], used: Set<string>): string {
  const base = camelCase(label.replace(/[^a-zA-Z0-9 ]/g, ' ')) || 'element'
  const suffix = KIND_SUFFIX[kind]
  let candidate = base.toLowerCase().endsWith(suffix.toLowerCase()) ? base : `${base}${suffix}`
  candidate = toSafeIdentifier(candidate)
  if (!used.has(candidate)) {
    used.add(candidate)
    return candidate
  }
  let i = 2
  while (used.has(`${candidate}${i}`)) i++
  const deduped = `${candidate}${i}`
  used.add(deduped)
  return deduped
}

// ── Unifying grounded targets from both sources ────────────────────────────

const LOCATOR_LABEL_RE = /(?:name|text)\s*:\s*['"`]([^'"`]+)['"`]|getByTestId\(\s*['"`]([^'"`]+)['"`]|getByLabel\(\s*['"`]([^'"`]+)['"`]|getByPlaceholder\(\s*['"`]([^'"`]+)['"`]/

function actionKind(action: string, locator: string): ElementEntry['kind'] {
  if (action === 'fill' || action === 'type') return 'input'
  if (action === 'check' || action === 'uncheck' || action === 'setChecked') return 'checkbox'
  if (action === 'selectOption') return 'select'
  if (locator.includes("getByRole('link'")) return 'link'
  if (locator.includes("getByRole('button'")) return 'button'
  return 'other'
}

export function actionsToElements(actions: RecordedAction[]): ElementEntry[] {
  return actions.map(a => {
    const match = a.locator.match(LOCATOR_LABEL_RE)
    const label = match ? (match[1] || match[2] || match[3] || match[4]) : a.locator.slice(0, 40)
    return {
      selector: a.locator,
      tag: 'recorded',
      label,
      kind: actionKind(a.action, a.locator),
      page: a.page
    }
  })
}

// Groups distilled elements + recorded actions into one target list per page,
// deduped by selector (an element and a recorded action for the same control
// collapse into one entry).
export function groupTargetsByPage(
  elements: ElementEntry[],
  actions: RecordedAction[]
): Map<string, ElementEntry[]> {
  const all = [...elements, ...actionsToElements(actions)]
  const byPage = new Map<string, Map<string, ElementEntry>>()
  for (const el of all) {
    const page = el.page || 'App'
    if (!byPage.has(page)) byPage.set(page, new Map())
    byPage.get(page)!.set(el.selector, el)
  }
  const result = new Map<string, ElementEntry[]>()
  for (const [page, map] of byPage) result.set(page, [...map.values()])
  return result
}

export function buildPageDefinitions(elements: ElementEntry[], actions: RecordedAction[]): PageDefinition[] {
  const grouped = groupTargetsByPage(elements, actions)
  const pages: PageDefinition[] = []
  const usedClassNames = new Set<string>()

  for (const [name, targets] of grouped) {
    let className = pascalCase(name)
    if (usedClassNames.has(className)) className = `${className}${usedClassNames.size + 1}`
    usedClassNames.add(className)

    const used = new Set<string>()
    const properties = targets.map(t => ({
      name: derivePropertyName(t.label, t.kind, used),
      selector: t.selector,
      label: t.label,
      kind: t.kind
    }))
    pages.push({ name, slug: slugify(name), className, properties })
  }

  if (pages.length === 0) {
    pages.push({ name: 'App', slug: 'app', className: 'App', properties: [] })
  }
  return pages
}

// ── Deterministic file generation ──────────────────────────────────────────

export function buildLocatorsFile(page: PageDefinition): PlaywrightAutomationFile {
  const propLines = page.properties
    .map(p => `  readonly ${p.name}: Locator`)
    .join('\n')
  const initLines = page.properties
    .map(p => `    this.${p.name} = ${p.selector}`)
    .join('\n')

  return {
    filename: `pages/locators/${page.slug}.locators.ts`,
    code: `import { Page, Locator } from '@playwright/test'

/**
 * Locators ONLY for ${page.className} – no actions/assertions here.
 * Generated deterministically from grounded selectors; never edited by the LLM.
 */
export class ${page.className}Locators {
${propLines || '  // No grounded elements were provided for this page.'}

  constructor(protected readonly page: Page) {
${initLines || '    // Add locators here once you provide a DOM snapshot or codegen recording for this page.'}
  }
}
`
  }
}

const METHODS_START = '  // ── LLM-authored action methods ──────────────────────────────'
const METHODS_END = '  // ── end action methods ───────────────────────────────────────'

export function buildPageObjectShell(page: PageDefinition): { header: string; footer: string } {
  const header = `import { Page } from '@playwright/test'
import { BasePage } from './base.page'
import { ${page.className}Locators } from './locators/${page.slug}.locators'

/**
 * Page Object for ${page.name}. Composes ${page.className}Locators (the only
 * place selectors live) and exposes semantic action methods for tests to call.
 * Tests should not reach into .locators directly except for simple one-off
 * assertions – prefer adding a named method below for anything reused.
 */
export class ${page.className} extends BasePage {
  readonly locators: ${page.className}Locators

  constructor(page: Page) {
    super(page)
    this.locators = new ${page.className}Locators(page)
  }

${METHODS_START}
`
  const footer = `
${METHODS_END}
}
`
  return { header, footer }
}

// Splices deduped LLM-authored methods into the deterministic shell.
export function assemblePageObjectFile(page: PageDefinition, methodBlocks: string[]): PlaywrightAutomationFile {
  const { header, footer } = buildPageObjectShell(page)
  const body = methodBlocks.length > 0
    ? methodBlocks.map(m => m.trimEnd()).join('\n\n')
    : '  // No reusable methods yet – call locators directly, e.g. this.locators.someButton.click()'
  return {
    filename: `pages/${page.slug}.page.ts`,
    code: `${header}${body}${footer}`
  }
}

// Extracts the method name from an authored method block, for dedup across chunks.
export function extractMethodName(code: string): string | null {
  const match = code.match(/(?:async\s+)?(\w+)\s*\(/)
  return match ? match[1] : null
}

// ── Shared reusable components (generic – not tied to any specific app) ────

export function buildComponentFiles(): PlaywrightAutomationFile[] {
  return [
    {
      filename: 'components/modal.component.ts',
      code: `import { Page, Locator, expect } from '@playwright/test'

/** Generic modal/dialog helper. Adjust selectors if your app's modal markup differs. */
export class ModalComponent {
  readonly dialog: Locator

  constructor(protected readonly page: Page) {
    this.dialog = page.getByRole('dialog')
  }

  async expectVisible(titleText?: string | RegExp) {
    await expect(this.dialog).toBeVisible()
    if (titleText) await expect(this.dialog.getByRole('heading', { name: titleText })).toBeVisible()
  }

  async confirm() {
    await this.dialog.getByRole('button', { name: /confirm|ok|yes|save/i }).click()
  }

  async cancel() {
    await this.dialog.getByRole('button', { name: /cancel|no|close/i }).click()
  }

  async close() {
    await this.dialog.getByRole('button', { name: /close/i }).or(this.dialog.getByLabel(/close/i)).click()
  }
}
`
    },
    {
      filename: 'components/toast.component.ts',
      code: `import { Page, expect } from '@playwright/test'

/** Generic toast/snackbar helper for role="status"/role="alert" notifications. */
export class ToastComponent {
  constructor(protected readonly page: Page) {}

  private locator() {
    return this.page.getByRole('status').or(this.page.getByRole('alert'))
  }

  async expectMessage(text: string | RegExp) {
    await expect(this.locator().filter({ hasText: text }).first()).toBeVisible()
  }

  async dismiss() {
    const toast = this.locator().first()
    const closeBtn = toast.getByRole('button', { name: /close|dismiss/i })
    if (await closeBtn.count() > 0) await closeBtn.click()
  }
}
`
    },
    {
      filename: 'components/tooltip.component.ts',
      code: `import { Page, Locator, expect } from '@playwright/test'

/** Generic tooltip helper – hover a trigger and read the tooltip content. */
export class TooltipComponent {
  constructor(protected readonly page: Page) {}

  async textFor(trigger: Locator): Promise<string> {
    await trigger.hover()
    const tooltip = this.page.getByRole('tooltip')
    await expect(tooltip).toBeVisible()
    return (await tooltip.textContent()) || ''
  }
}
`
    },
    {
      filename: 'components/navbar.component.ts',
      code: `import { Page } from '@playwright/test'

/** Generic top/side navigation helper – adjust if your nav isn't a <nav> landmark. */
export class NavbarComponent {
  constructor(protected readonly page: Page) {}

  private nav() {
    return this.page.getByRole('navigation')
  }

  async goTo(linkName: string | RegExp) {
    await this.nav().getByRole('link', { name: linkName }).click()
  }
}
`
    }
  ]
}

const COMPONENT_FIXTURES = [
  { name: 'ModalComponent', file: 'modal.component', fixture: 'modal' },
  { name: 'ToastComponent', file: 'toast.component', fixture: 'toast' },
  { name: 'TooltipComponent', file: 'tooltip.component', fixture: 'tooltip' },
  { name: 'NavbarComponent', file: 'navbar.component', fixture: 'navbar' }
]

export function buildFixturesFile(pages: PageDefinition[]): PlaywrightAutomationFile {
  const pageImports = pages.map(p => `import { ${p.className} } from '../pages/${p.slug}.page'`).join('\n')
  const componentImports = COMPONENT_FIXTURES.map(c => `import { ${c.name} } from '../components/${c.file}'`).join('\n')

  const pageFixtureNames = pages.map(p => camelCase(p.name))
  const interfaceLines = [
    ...pages.map((p, i) => `  ${pageFixtureNames[i]}: ${p.className}`),
    ...COMPONENT_FIXTURES.map(c => `  ${c.fixture}: ${c.name}`)
  ].join('\n')

  const implLines = [
    ...pages.map((p, i) => `  ${pageFixtureNames[i]}: async ({ page }, use) => { await use(new ${p.className}(page)) },`),
    ...COMPONENT_FIXTURES.map(c => `  ${c.fixture}: async ({ page }, use) => { await use(new ${c.name}(page)) },`)
  ].join('\n')

  return {
    filename: 'fixtures/base.fixture.ts',
    code: `import { test as base } from '@playwright/test'
${pageImports}
${componentImports}

interface Fixtures {
${interfaceLines}
}

export const test = base.extend<Fixtures>({
${implLines}
})

export { expect } from '@playwright/test'
`
  }
}
