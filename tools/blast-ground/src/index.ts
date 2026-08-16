#!/usr/bin/env tsx
/**
 * blast-ground — verify Playwright locators against a LIVE page.
 *
 * Static HTML parsing can only propose selectors. It cannot know that a browser
 * assigns no ARIA role to an <a> without href, or that `.card-title` matches
 * four nodes rather than one. This CLI drives a real headless browser, asks it
 * `locator.count()` for every candidate, and keeps only what resolves to
 * exactly one element.
 *
 * It runs on YOUR machine, so it can ground localhost, VPN-only staging, and
 * pages behind a login — targets a hosted service structurally cannot reach.
 *
 * Output: grounding.json → import it in the app's "Automation grounding" panel.
 */
import { writeFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright'

// domDistiller calls DOMParser at request time; give it one before importing.
globalThis.DOMParser = new JSDOM().window.DOMParser as unknown as typeof globalThis.DOMParser

const { distillCandidates, detectCollections } = await import('../../../src/services/domDistiller.ts')
const { resolveElements, resolveCollection, isOrderNonDeterministic, parseLocatorExpression } = await import(
  '../../../src/services/groundingResolver.ts'
)
const { verifySuite, printReport } = await import('./verifySuite.ts')

// ── CLI args ──────────────────────────────────────────────────────────────────

interface Target { url: string; page: string }

interface Options {
  targets: Target[]
  out: string
  storageState?: string
  waitFor?: string
  waitMs: number
  headed: boolean
  checkRoutes: boolean
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { targets: [], out: 'grounding.json', waitMs: 0, headed: false, checkRoutes: true }
  const rest: string[] = []

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => argv[++i]
    if (arg === '--page') opts.targets.push({ url: '', page: next() })
    else if (arg === '--also') {
      const [url, name] = next().split('=')
      opts.targets.push({ url, page: name || derivePageName(url) })
    } else if (arg === '--out') opts.out = next()
    else if (arg === '--storage-state') opts.storageState = next()
    else if (arg === '--wait-for') opts.waitFor = next()
    else if (arg === '--wait') opts.waitMs = Number(next())
    else if (arg === '--headed') opts.headed = true
    else if (arg === '--no-routes') opts.checkRoutes = false
    else if (arg.startsWith('-')) throw new Error(`Unknown flag: ${arg}`)
    else rest.push(arg)
  }

  const primaryUrl = rest[0]
  if (!primaryUrl) {
    throw new Error(
      'Usage: blast-ground <url> [--page Name] [--also url=Name] [--out grounding.json]\n' +
      '       blast-ground verify-suite <dir> [--base-url URL]'
    )
  }

  // A bare `--page Name` names the primary URL.
  const named = opts.targets.find(t => !t.url)
  if (named) named.url = primaryUrl
  else opts.targets.unshift({ url: primaryUrl, page: derivePageName(primaryUrl) })

  return opts
}

function derivePageName(url: string): string {
  try {
    const segment = new URL(url).pathname.split('/').filter(Boolean).pop() || 'Home'
    return segment.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
  } catch {
    return 'App'
  }
}

// ── Live verification ─────────────────────────────────────────────────────────

/**
 * Rebuild a locator from *parsed intent*, passing page-derived values to
 * Playwright as DATA.
 *
 * SECURITY: these expressions embed content from the target page (class names,
 * data-* values, visible text). Evaluating them (eval / new Function) would let
 * a malicious page run arbitrary code on the machine running this CLI. So we
 * accept only the closed grammar our distiller emits and reject the rest —
 * an unparseable candidate is simply skipped, never executed.
 */
function buildLocator(page: Page, expression: string): Locator | null {
  const intent = parseLocatorExpression(expression)
  if (!intent) return null
  switch (intent.kind) {
    case 'testId': return page.getByTestId(intent.value)
    case 'label': return page.getByLabel(intent.value)
    case 'placeholder': return page.getByPlaceholder(intent.value)
    case 'text': return page.getByText(intent.value, { exact: true })
    case 'role': return page.getByRole(intent.role, { name: intent.name })
    case 'roleRegex': return page.getByRole(intent.role, { name: new RegExp(intent.pattern) })
    case 'css': return page.locator(intent.selector)
  }
}

function makeCountProbe(page: Page) {
  return async (expression: string): Promise<number> => {
    const locator = buildLocator(page, expression)
    if (!locator) throw new Error(`Unsupported locator expression: ${expression}`)
    return locator.count()
  }
}

// Structured probes: CSS selectors go straight into the Playwright API as data.
function makeCollectionProbe(page: Page) {
  return {
    countItems: (itemSelector: string) => page.locator(itemSelector).count(),
    countFieldInFirstItem: (itemSelector: string, fieldSelector: string) =>
      page.locator(itemSelector).first().locator(fieldSelector).count()
  }
}

async function itemTexts(page: Page, itemSelector: string): Promise<string[]> {
  return page.locator(itemSelector).allInnerTexts()
}

async function groundPage(context: BrowserContext, target: Target, opts: Options) {
  const page = await context.newPage()
  await page.goto(target.url, { waitUntil: 'networkidle' })
  if (opts.waitFor) await page.waitForSelector(opts.waitFor, { timeout: 15_000 })
  if (opts.waitMs) await page.waitForTimeout(opts.waitMs)

  const html = await page.content() // post-JS DOM, not the pre-render shell
  const count = makeCountProbe(page)
  const collectionProbe = makeCollectionProbe(page)

  // 1. Elements: browser adjudicates which candidate is correct.
  const { elements, unresolved } = await resolveElements(distillCandidates(html, target.page), count)

  // 2. Collections: keep only fields that truly resolve inside an item.
  const collections = []
  const warnings: string[] = []
  for (const candidate of detectCollections(html, target.page)) {
    const resolved = await resolveCollection(candidate, collectionProbe)
    if (!resolved) continue

    // 3. Two loads: does the list reshuffle itself?
    const firstPass = await itemTexts(page, resolved.itemSelector)
    await page.reload({ waitUntil: 'networkidle' })
    if (opts.waitFor) await page.waitForSelector(opts.waitFor, { timeout: 15_000 })
    const secondPass = await itemTexts(page, resolved.itemSelector)
    const shuffles = isOrderNonDeterministic(firstPass, secondPass)
    if (shuffles) {
      warnings.push(
        `[${target.page}] "${resolved.itemSelector}" reorders itself between loads — address items by text (.filter({ hasText })), never by index.`
      )
    }
    collections.push({ ...resolved, nondeterministicOrder: shuffles })
  }

  // 4. Routes actually present on the page (never guessed).
  let routes: { valid: string[]; missing: string[] } = { valid: [], missing: [] }
  if (opts.checkRoutes) routes = await discoverRoutes(page, target.url)

  await page.close()
  return { elements, unresolved, collections, routes, warnings }
}

async function discoverRoutes(page: Page, baseUrl: string) {
  const origin = new URL(baseUrl).origin
  const hrefs: string[] = await page.$$eval('a[href]', anchors =>
    anchors.map(a => (a as HTMLAnchorElement).href)
  )
  const sameOrigin = [...new Set(hrefs.filter(h => h.startsWith(origin)))]

  const valid: string[] = []
  const missing: string[] = []
  for (const href of sameOrigin.slice(0, 40)) {
    const path = new URL(href).pathname
    try {
      const response = await page.request.get(href, { timeout: 10_000 })
      // 401/403 mean the route EXISTS but is gated – never treat those as missing.
      if (response.status() === 404 || response.status() === 410) missing.push(path)
      else valid.push(path)
    } catch {
      missing.push(path)
    }
  }
  return { valid: [...new Set(valid)], missing: [...new Set(missing)] }
}

// ── verify-suite subcommand ─────────────────────────────────────────────────

interface VerifySuiteOptions {
  dir: string
  baseUrl?: string
  skipBrowserInstall: boolean
}

function parseVerifySuiteArgs(argv: string[]): VerifySuiteOptions {
  let dir: string | undefined
  let baseUrl: string | undefined
  let skipBrowserInstall = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--base-url') baseUrl = argv[++i]
    else if (arg === '--skip-browser-install') skipBrowserInstall = true
    else if (arg.startsWith('-')) throw new Error(`Unknown flag: ${arg}`)
    else if (!dir) dir = arg
  }
  if (!dir) throw new Error('Usage: blast-ground verify-suite <dir> [--base-url URL] [--skip-browser-install]')
  return { dir, baseUrl, skipBrowserInstall }
}

async function runVerifySuite(argv: string[]) {
  const opts = parseVerifySuiteArgs(argv)
  const report = await verifySuite(opts.dir, { baseUrl: opts.baseUrl, skipBrowserInstall: opts.skipBrowserInstall })
  printReport(report)
  if (!report.ok) process.exit(1)
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (process.argv[2] === 'verify-suite') {
    return runVerifySuite(process.argv.slice(3))
  }

  const opts = parseArgs(process.argv.slice(2))
  let browser: Browser | undefined

  try {
    browser = await chromium.launch({ headless: !opts.headed })
    const context = await browser.newContext(
      opts.storageState ? { storageState: opts.storageState } : undefined
    )

    const grounding = {
      version: 1 as const,
      generatedAt: new Date().toISOString(),
      baseUrl: new URL(opts.targets[0].url).origin,
      pages: opts.targets.map(t => ({ name: t.page, url: t.url })),
      elements: [] as unknown[],
      collections: [] as unknown[],
      routes: { valid: [] as string[], missing: [] as string[] },
      unresolved: [] as unknown[],
      warnings: [] as string[]
    }

    // One bad page must not discard the pages already grounded.
    for (const target of opts.targets) {
      process.stderr.write(`→ grounding ${target.page} (${target.url})\n`)
      try {
        const result = await groundPage(context, target, opts)
        grounding.elements.push(...result.elements)
        grounding.collections.push(...result.collections)
        grounding.unresolved.push(...result.unresolved)
        grounding.warnings.push(...result.warnings)
        grounding.routes.valid.push(...result.routes.valid)
        grounding.routes.missing.push(...result.routes.missing)

        process.stderr.write(
          `  ✓ ${result.elements.length} verified · ${result.collections.length} collection(s) · ` +
          `${result.unresolved.length} unresolved · ${result.routes.missing.length} dead route(s)\n`
        )
      } catch (err: any) {
        const message = `[${target.page}] grounding failed: ${err.message}`
        grounding.warnings.push(message)
        process.stderr.write(`  ✗ ${message}\n`)
      }
    }

    grounding.routes.valid = [...new Set(grounding.routes.valid)]
    grounding.routes.missing = [...new Set(grounding.routes.missing)]

    writeFileSync(opts.out, JSON.stringify(grounding, null, 2))
    process.stderr.write(`\nWrote ${opts.out}\n`)
    if (grounding.unresolved.length > 0) {
      process.stderr.write(
        `${grounding.unresolved.length} element(s) could not be verified — they'll become todoSelector() stubs, not guesses.\n`
      )
    }
    for (const warning of grounding.warnings) process.stderr.write(`! ${warning}\n`)
  } finally {
    await browser?.close()
  }
}

main().catch(err => {
  process.stderr.write(`blast-ground failed: ${err.message}\n`)
  process.exit(1)
})
