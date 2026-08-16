import axios from 'axios'
import aiService, { GenerationAbortedError, type TestCase, type PlaywrightAutomationData, type PlaywrightAutomationFile } from './aiService'
import type { AIProvider } from '../context/SettingsContext'
import { parseWithRepair } from './jsonParser'
import { z } from 'zod'
import { auditLocatorCardinality, findRawCollectionMethods } from './astLocatorAudit'
import {
  buildPackageJson,
  buildTsconfig,
  buildPlaywrightConfig,
  buildBasePage,
  buildReadme,
  buildAuthSetupFile,
  buildGitignore,
  buildEnvExample,
  buildCIWorkflow
} from './automationTemplates'
import {
  buildPageDefinitions,
  buildLocatorsFile,
  assemblePageObjectFile,
  buildComponentFiles,
  buildFixturesFile,
  extractMethodName,
  camelCase,
  type PageDefinition
} from './pomBuilder'
import type { ElementEntry, CollectionEntry } from './domDistiller'
import type { RecordedAction } from './codegenParser'
import {
  buildFrameworkPromptContext,
  spliceMethodsIntoClass,
  type FrameworkProfile
} from './frameworkAnalyzer'

const API_BASE = (import.meta as any).env?.VITE_API_URL || (typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') ? 'http://localhost:3001/api' : '/api')

export interface AutomationContext {
  elements?: ElementEntry[]
  /** Repeating structures (product grids, result lists) – see domDistiller.detectCollections */
  collections?: CollectionEntry[]
  recordedActions?: RecordedAction[]
  baseUrl?: string
  /**
   * Set when grounding came from the `blast-ground` CLI: every selector was
   * resolved against a live page (exactly one match) and every route confirmed.
   * The builder then trusts the data and skips its own HTTP route probing.
   */
  verified?: boolean
  /** Routes the CLI proved do not exist (404/410/unreachable). */
  knownMissingRoutes?: string[]
  /** Elements the live browser could not pin down – left as todoSelector stubs. */
  unresolvedLabels?: string[]
  /** Page name -> the exact URL it was grounded at, e.g. for auth setup to navigate there. */
  pageUrls?: Record<string, string>
}

export interface AutomationBuildResult extends PlaywrightAutomationData {
  /** Share of generated locator usages that came from the grounded allow-list */
  selectorGroundingRate: number
  todoSelectorCount: number
  /** Page objects the suite was organized into (for UI display) */
  pageObjectNames: string[]
  /** Every generation-time rejection/correction, surfaced in the UI as well as the README. */
  warnings: string[]
  /** Page classes reused from the user's uploaded framework rather than generated. */
  reusedPageClasses: string[]
}

const PageMethodSchema = z.object({ page: z.string(), code: z.string() }).passthrough()

const TestFileSchema = z.object({ filename: z.string(), code: z.string() }).passthrough()

const ChunkResponseSchema = z.preprocess(v => {
  if (Array.isArray(v)) return { testFiles: v, pageMethods: [] }
  if (v && typeof v === 'object' && !('testFiles' in v) && Array.isArray((v as any).files)) {
    return { testFiles: (v as any).files, pageMethods: (v as any).pageMethods || [] }
  }
  return v
}, z.object({
  testFiles: z.array(TestFileSchema).min(1),
  pageMethods: z.array(PageMethodSchema).optional().default([])
}).passthrough())

const CHUNK_SIZE = 5

function describePages(pages: PageDefinition[], knownMethods: Map<string, string[]>): string {
  return pages.map(p => {
    const fixtureName = camelCase(p.name)
    const propLines = p.properties.length > 0
      ? p.properties.map(prop => `      - ${fixtureName}.locators.${prop.name}  (${prop.kind}: "${prop.label}")`).join('\n')
      : '      (none grounded yet)'
    const methods = knownMethods.get(p.slug) || []
    const methodLines = methods.length > 0
      ? methods.map(m => `      - ${fixtureName}.${m}`).join('\n')
      : '      (none authored yet – add one to pageMethods if a step needs a reusable action)'
    return `  Page "${p.name}" – fixture "${fixtureName}":\n    Grounded locator properties:\n${propLines}\n    Existing methods:\n${methodLines}`
  }).join('\n\n')
}

// Repeating structures are what most test cases actually operate on, yet they
// are invisible to interactive-element extraction. Describe them explicitly and
// forbid index-based addressing (list order is frequently randomised at runtime).
function describeCollections(collections: CollectionEntry[]): string {
  if (collections.length === 0) return ''
  const blocks = collections.map(c => {
    const fields = c.fields.map(f => `      - ${f.name}: item.locator('${f.selector}')`).join('\n')
    const shuffles = c.nondeterministicOrder
      ? '\n      !! VERIFIED: this list is in a DIFFERENT ORDER on every page load. Any .nth()/.first() on it is intermittently wrong.'
      : ''
    return `  * ${c.name} (${c.count} items on the page)${shuffles}
      collection: page.locator('${c.itemSelector}')
      one item by its text: page.locator('${c.itemSelector}').filter({ hasText: '<name>' })
      fields within an item:
${fields}`
  })
  return `
A repeating structure below is NEVER a "fixtureName.locators.X" property – it is ONLY reachable via "page.locator('<itemSelector>')" or a page-object method you author. "fixtureName.locators" contains ONLY the individually grounded elements listed under "Available pages" below.

REPEATING STRUCTURES (grounded – prefer these over inventing locators):
${blocks.join('\n')}
- Address a single item by TEXT: .filter({ hasText: '<name>' }). NEVER use .nth(i) or .first() to pick a specific item – these lists are often shuffled on every page load, which produces intermittently-failing tests.
- A field assertion must target the field locator itself (item.locator('.card-title')), not the whole item, or you'll assert the concatenation of every child's text.
- A collection locator (the bare, unfiltered "collection:" expression above) matches MULTIPLE elements. NEVER pass it directly to a single-element assertion (toBeVisible/toHaveText/toBeEnabled/etc.) – Playwright throws "strict mode violation" at runtime, every time, with no exception. To assert on the whole collection use toHaveCount(); to assert on each item, iterate: \`for (const item of await collection.all()) { await expect(item).toBeVisible() }\`; to assert on one item, narrow it first with .filter({ hasText }).
- If you assert an exact toHaveCount(N) on a collection listed above, N MUST be the exact number stated ("N items on the page") – never invent a different count.
`
}

function buildTranslationPrompt(
  cases: TestCase[],
  pages: PageDefinition[],
  knownMethods: Map<string, string[]>,
  hasGrounding: boolean,
  collections: CollectionEntry[]
): string {
  const fixtureNames = pages.map(p => camelCase(p.name))
  return `You are a senior SDET writing Playwright TypeScript tests using a Page Object Model (POM) framework that is ALREADY SCAFFOLDED.

Project conventions (already generated – do NOT redefine them):
- Fixtures are imported from '../fixtures/base.fixture' and provide one Page Object per app page: ${fixtureNames.join(', ')}. Destructure exactly the ones you need: test('...', async ({ ${fixtureNames.slice(0, 2).join(', ')} }) => {...}).
- Also available: 'page' (raw Playwright page, for goto/waiting only), and shared component fixtures: modal, toast, tooltip, navbar.
- One spec file per test case: tests/<tc-id-lowercase>.spec.ts

CRITICAL RULE – NEVER write "page.getByRole/getByLabel/getByTestId/locator(...)" directly inside a spec file. ALL locator interactions go through a page object:
- Prefer an EXISTING method listed below (call it: await ${fixtureNames[0] || 'somePage'}.someMethod(...)).
- If no existing method fits, use the grounded property directly: await ${fixtureNames[0] || 'somePage'}.locators.somePropInput.fill(...).
- If a step needs an interaction with NO grounded property (nothing listed below covers it), you MUST add a new reusable method to the most relevant page via the "pageMethods" array in your response (see schema) – put the raw locator INSIDE that method and call the method from the spec. Never author page.* calls directly in a spec file.
- For a locator you genuinely cannot ground, call the inherited escape hatch: \`this.todoSelector('describe the element')\`. It returns a Locator, so the surrounding test still compiles and fails loudly on that one step.
- NEVER call todoSelector() with a CSS selector that already appears above (e.g. todoSelector('.card')) – that is GROUNDED, so write \`this.page.locator('.card')\` directly. todoSelector() is only for something with NO selector listed anywhere in this prompt.
- "TODO-SELECTOR" is ONLY ever a "//" comment on its own line. NEVER put it inside a selector string. \`page.locator('// TODO-SELECTOR: .x')\` is invalid – Playwright parses it as a selector engine and throws at runtime.

API CONSISTENCY (specs and page objects must agree):
- A spec may ONLY call a page-object method that you define in "pageMethods" in this same response, or one already listed as authored below, or the inherited BasePage methods: goto(), todoSelector(), expectToast().
- Never call a method you have not defined – it becomes "TypeError: x is not a function" at runtime.

NAVIGATION (never fabricate a host or a path):
- Always navigate with a RELATIVE path: await page.goto('/sweets'). playwright.config.ts already sets baseURL.
- NEVER write an absolute URL (no 'https://…') in a goto() – a fabricated domain fails with ERR_NAME_NOT_RESOLVED.
- Only use a path that appears in the grounded page/recording data below. Do not guess plausible-looking routes (e.g. '/products') – if no route is known, navigate to '/' .

GROUNDED FEATURES ONLY (do not invent behaviour):
- Only generate a step if the element it needs actually exists in the grounded properties below. If a test case's prose mentions a feature (e.g. a search box) but no such element is grounded, SKIP that step rather than inventing a locator for it – an invented step hangs until timeout.

ASSERTION SCOPE:
- A text assertion must describe exactly ONE DOM node's own text. Never concatenate a heading with its sibling paragraph (e.g. do not expect a title to contain the product description).

PAGE-OBJECT METHOD SHAPE:
- A getter that just returns a Locator must be SYNCHRONOUS and return Locator (never "async", never Promise<Locator>). Playwright's web-first assertions reject a Promise: "toBeVisible can be only used with Locator object, was called with Promise".
- Only actions that await something (click, fill, goto) may be async.
- ONE signature per method name. Never author the same method name twice with different parameter types – if two cases need different inputs, accept a union (target: string | Locator) in a single method.
${hasGrounding ? '' : '\nNo DOM snapshot or recording was provided – every page has zero grounded properties, so essentially all interactions require a new TODO-SELECTOR method via pageMethods. Base locator guesses on the step text using getByRole/getByLabel/getByPlaceholder.\n'}
TEST INDEPENDENCE (critical for CI reliability):
- Each spec file must be fully independent – never assume another test file ran first or left behind state. If a case's precondition requires existing data, create that data within the test itself (or note the assumption in a comment) rather than depending on execution order.
- Prefer web-first assertions (await expect(locator)...) over manual waits/timeouts – they auto-retry and don't create flaky race conditions.
- Do not reuse mutable variables across tests in the same file; each test() callback should set up everything it needs.
${describeCollections(collections)}
Available pages, their grounded locator properties, and already-authored methods:
${describePages(pages, knownMethods)}

Return ONLY valid JSON in this exact shape:
{
  "testFiles": [{"filename": "tests/tc-001.spec.ts", "code": "import { test, expect } from '../fixtures/base.fixture'\\n..."}],
  "pageMethods": [{"page": "<exact page name from the list above>", "code": "async methodName(args) {\\n  await this.locators.someProp.click()\\n}"}]
}
Omit "pageMethods" or leave it an empty array if no new methods are needed for this batch.

Test cases to translate:
${JSON.stringify(
    cases.map(tc => ({
      id: tc.id,
      summary: tc.summary,
      precondition: tc.precondition,
      steps: tc.steps
    })),
    null,
    2
  )}`
}

// A TODO-SELECTOR marker must live in a `//` comment, never inside a selector
// string – Playwright parses `locator('// TODO-SELECTOR: .x')` as a selector
// engine and throws NamespaceError at runtime. Ungrounded code must fail
// loudly (test.fixme), never ship as a broken executable selector.
const EXECUTABLE_TODO_RE =
  /(?:locator|frameLocator|getByRole|getByText|getByLabel|getByPlaceholder|getByTestId|getByTitle|getByAltText)\s*\(\s*(['"`])[^'"`]*TODO-SELECTOR/

export function hasExecutableTodoSelector(code: string): boolean {
  return EXECUTABLE_TODO_RE.test(code)
}

// Every path passed to page.goto(). Absolute URLs are captured too so a
// fabricated host (https://sweetshop.example.com) can be rejected as well.
export function extractGotoPaths(code: string): string[] {
  const re = /\.goto\(\s*(['"`])([^'"`]+)\1/g
  const paths: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(code)) !== null) paths.push(m[2])
  return paths
}

// A route is invalid when the origin says it doesn't exist (404/410) or is
// unreachable (status 0 = DNS failure). 401/403 mean the route EXISTS but is
// auth-gated – never reject those.
export function isRouteMissing(status: number): boolean {
  return status === 0 || status === 404 || status === 410
}

// Resolve every goto() path against baseUrl and HTTP-check it. Best-effort: if
// verification itself fails we return an empty set rather than fixme'ing
// everything. Skipped entirely when no baseUrl is configured.
export async function verifyRoutes(baseUrl: string | undefined, paths: string[]): Promise<Set<string>> {
  const missing = new Set<string>()
  if (!baseUrl || paths.length === 0) return missing
  for (const path of [...new Set(paths)]) {
    let target: string
    try {
      target = new URL(path, baseUrl).toString()
    } catch {
      missing.add(path) // unparseable – definitely not navigable
      continue
    }
    try {
      const { data } = await axios.post(`${API_BASE}/check-url`, { url: target }, { timeout: 15000 })
      if (isRouteMissing(Number(data?.status))) missing.add(path)
    } catch {
      // Proxy/network failure on OUR side – don't punish the generated test.
    }
  }
  return missing
}

// Title template matches the README table exactly: `TC-XXX: <case title>`.
export function buildFixmeStub(filename: string, reason: string, summary = 'implement manually'): string {
  const id = filename.replace(/^tests\//, '').replace(/\.spec\.ts$/, '').toUpperCase()
  return `import { test, expect } from '../fixtures/base.fixture'

// NOT RUNNABLE: ${reason}
// Fix the cause above, then remove test.fixme.
test.fixme('${id}: ${summary.replace(/'/g, "\\'")}', async ({ page }) => {})
`
}

// Raw page-level locator calls inside a page-object method that were NOT in the
// grounded allow-list are invented elements (the `searchForProduct` class of
// defect: a search box that doesn't exist, hanging the test until timeout).
// Grounded properties (`this.locators.x`) never match this pattern.
const RAW_LOCATOR_RE = /(?:this\s*\.\s*)?page\s*\.\s*(?:getBy\w+|locator|frameLocator)\s*\((?:[^()]|\([^()]*\))*\)/g

export function findUngroundedLocators(methodCode: string, allowList: Set<string>): string[] {
  const found: string[] = []
  for (const match of methodCode.match(RAW_LOCATOR_RE) || []) {
    const normalized = match.replace(/\s+/g, '').replace(/^this\./, '')
    if (!allowList.has(normalized)) found.push(match)
  }
  return found
}

// Methods every page object inherits from BasePage.
export const BASE_PAGE_METHODS = new Set(['goto', 'todoSelector', 'expectToast'])

const TODO_IN_STRING_RE =
  /(?:this\s*\.\s*)?page\s*\.\s*(?:getBy\w+|locator|frameLocator)\s*\(\s*(['"`])([^'"`]*TODO-SELECTOR[^'"`]*)\1\s*\)/g

// Degrade gracefully instead of discarding work: an ungrounded locator becomes
// BasePage.todoSelector(), so the method and its test keep their shape and fail
// loudly on exactly the one piece a human must supply. Dropping whole test cases
// (the previous behaviour) threw away the 90% that was correctly grounded.
export function degradeUngroundedLocators(
  methodCode: string,
  allowList: Set<string>,
  enforceAllowList: boolean
): { code: string; replaced: number } {
  let replaced = 0

  // 1. A TODO-SELECTOR smuggled inside a selector string (NamespaceError at runtime).
  let code = methodCode.replace(TODO_IN_STRING_RE, (_m, _q, raw: string) => {
    replaced++
    const desc = raw.replace(/^\/\/\s*TODO-SELECTOR:\s*/, '').trim().slice(0, 80)
    return `this.todoSelector('${desc.replace(/'/g, "\\'")}')`
  })

  // 2. Raw locators absent from the grounded allow-list (invented elements).
  if (enforceAllowList) {
    code = code.replace(RAW_LOCATOR_RE, match => {
      if (isGroundedLocator(match, allowList)) return match
      replaced++
      return `this.todoSelector('${match.replace(/'/g, "\\'").slice(0, 80)}')`
    })
  }
  return { code, replaced }
}

// A spec must only call page-object methods that actually exist. The spec stage
// and the page-object stage are separate LLM outputs, so they can drift –
// producing `TypeError: home.getAllProductCards is not a function` at runtime.
export function findMissingPageMethods(
  specCode: string,
  fixtureName: string,
  definedMethods: Set<string>
): string[] {
  const re = new RegExp(`\\b${fixtureName}\\s*\\.\\s*(\\w+)\\s*\\(`, 'g')
  const missing = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(specCode)) !== null) {
    if (!definedMethods.has(m[1]) && !BASE_PAGE_METHODS.has(m[1])) missing.add(m[1])
  }
  return [...missing]
}

// Same drift class as findMissingPageMethods, but for PROPERTY access instead
// of a method call. Found live: the model assumed a grounded COLLECTION was
// also exposed as `sweets.locators.card` (like individual grounded elements
// are) – it is not; a collection is only reachable via page.locator(itemSelector)
// or a page-object method. `tsc` correctly rejects it (TS2339), but by then
// the whole framework fails to compile instead of just this one spec.
export function findMissingLocatorProperties(
  specCode: string,
  fixtureName: string,
  definedProperties: Set<string>
): string[] {
  const re = new RegExp(`\\b${fixtureName}\\s*\\.\\s*locators\\s*\\.\\s*(\\w+)\\b`, 'g')
  const missing = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(specCode)) !== null) {
    if (!definedProperties.has(m[1])) missing.add(m[1])
  }
  return [...missing]
}

// One title template everywhere, generated from the same source as the README
// table, so README / HTML report / CI annotations can never drift.
export function enforceTestTitle(code: string, tcId: string, summary: string): string {
  const title = `${tcId.toUpperCase()}: ${summary}`.replace(/'/g, "\\'")
  return code.replace(
    /\btest(\.\w+)?\(\s*(['"`])(?:[^'"`\\]|\\.)*\2/,
    (_m, modifier: string | undefined) => `test${modifier || ''}('${title}'`
  )
}

// A getter that merely returns a Locator must not be async: Playwright's
// Found by actually generating and running a real framework: the model called
// `this.todoSelector('.card')` for a collection whose item selector WAS
// grounded (page.locator('.card') is in the allow-list) – todoSelector()
// resolves to `[data-todo=".card"]`, which matches nothing, so the test hangs
// on a live element that genuinely exists. Our static checks never catch this:
// `todoSelector(...)` is the SANCTIONED escape hatch, so it looks intentional.
// Detect the specific case where its argument is itself a grounded selector
// and rewrite to the real locator instead of guessing why the model did this.
//
// The prefix varies by WHERE the call lives: inside a page-object method it's
// `this.todoSelector(...)`; inside a spec file it's called through whichever
// fixture is in scope, e.g. `home.todoSelector(...)`. Both must be caught –
// found live in a spec, where a naive `this.`-only regex silently misses it.
const TODO_SELECTOR_CALL_RE = /\b(this|[a-zA-Z_$][\w$]*)\.todoSelector\(\s*'((?:[^'\\]|\\.)*)'\s*\)/g

export function fixMisusedTodoSelector(methodCode: string, collections: CollectionEntry[]): { code: string; fixed: number } {
  let fixed = 0
  const itemSelectors = new Set(collections.map(c => c.itemSelector))
  const code = methodCode.replace(TODO_SELECTOR_CALL_RE, (whole, prefix: string, arg: string) => {
    const candidate = arg.startsWith('.') ? arg : `.${arg}`
    if (!itemSelectors.has(candidate)) return whole
    fixed++
    return `${prefix}.page.locator('${candidate}')`
  })
  return { code, fixed }
}

// web-first assertions reject a Promise —
// "toBeVisible can be only used with Locator object, was called with Promise".
// Only strip `async` when the body genuinely never awaits.
export function desyncLocatorGetter(methodCode: string): string {
  if (!/^\s*async\s+get[A-Z]\w*\s*\(/.test(methodCode)) return methodCode
  if (/\bawait\b/.test(methodCode)) return methodCode
  return methodCode.replace(/^(\s*)async\s+/, '$1').replace(/:\s*Promise\s*<\s*([^>]+?)\s*>/, ': $1')
}

export function buildAllowList(context: AutomationContext, framework?: FrameworkProfile | null): Set<string> {
  return new Set([
    ...(context.elements || []).map(e => e.selector.replace(/\s+/g, '')),
    ...(context.recordedActions || []).map(a => a.locator.replace(/\s+/g, '')),
    // Repeating structures are grounded as a set locator; tests then narrow by
    // text (never by index – list order is often randomised at runtime).
    ...(context.collections || []).map(c => `page.locator('${c.itemSelector}')`.replace(/\s+/g, '')),
    // A locator already living in the user's own framework is grounded by
    // definition – it ships in code they run today. Without this, every
    // legitimate call into their page objects would be flagged as invented.
    ...(framework?.pages || []).flatMap(page =>
      page.locators.map(name => `this.${name}`.replace(/\s+/g, ''))
    )
  ])
}

// A locator is grounded if it IS an allow-listed expression, or is CHAINED off
// one — `page.locator('.card').filter({hasText:'X'}).locator('.card-title')`
// is grounded because its base is. Exact matching alone would stub every
// legitimate collection/`.first()`/`.filter()` chain.
export function isGroundedLocator(expression: string, allowList: Set<string>): boolean {
  const normalized = expression.replace(/\s+/g, '').replace(/^this\./, '')
  if (allowList.has(normalized)) return true
  for (const allowed of allowList) {
    if (normalized.startsWith(allowed)) return true
  }
  return false
}

export function computeGroundingStats(
  files: PlaywrightAutomationFile[],
  context: AutomationContext
): { rate: number; todoCount: number } {
  const allowList = new Set([
    ...(context.elements || []).map(e => e.selector.replace(/\s+/g, '')),
    ...(context.recordedActions || []).map(a => a.locator.replace(/\s+/g, ''))
  ])
  const locatorRe = /page\s*\.\s*(?:getBy\w+|locator|frameLocator)\s*\((?:[^()]|\([^()]*\))*\)/g

  let total = 0
  let grounded = 0
  let todoCount = 0
  for (const file of files) {
    todoCount += (file.code.match(/TODO-SELECTOR/g) || []).length
    for (const match of file.code.match(locatorRe) || []) {
      total++
      if (allowList.has(match.replace(/\s+/g, ''))) grounded++
    }
  }
  return { rate: total === 0 ? 0 : grounded / total, todoCount }
}

async function buildGeneratedPomSuite(cfg: {
  provider: AIProvider
  apiKey: string
  model: string
  projectName: string
  testCases: TestCase[]
  context?: AutomationContext
  maxTokens?: number
  signal?: AbortSignal
  onProgress?: (detail: string) => void
}): Promise<AutomationBuildResult> {
  const { provider, apiKey, model, testCases } = cfg
  const context = cfg.context || {}
  const hasGrounding = !!(context.elements?.length || context.recordedActions?.length || context.collections?.length)
  const repair = aiService.makeRepairFn(provider, apiKey, model)

  // Organize grounding into named pages – always at least one ("App").
  const pages = buildPageDefinitions(context.elements || [], context.recordedActions || [])
  const knownPageNames = new Map(pages.map(p => [p.name.toLowerCase(), p]))
  const methodsByPage = new Map<string, { name: string; code: string }[]>()

  // Deterministic layers – zero tokens, never hallucinated.
  const componentFiles = buildComponentFiles()
  const locatorsFiles = pages.map(buildLocatorsFile)

  const scaffold: PlaywrightAutomationData = {
    frameworkAware: false,
    readme: buildReadme(cfg.projectName, testCases, hasGrounding),
    packageJson: buildPackageJson(cfg.projectName.toLowerCase().replace(/[^a-z0-9-]+/g, '-')),
    tsconfigJson: buildTsconfig(),
    playwrightConfig: '', // finalized below once we know whether an auth setup project is needed
    testFiles: [
      { filename: 'pages/base.page.ts', code: buildBasePage() },
      ...componentFiles,
      ...locatorsFiles
    ]
  }

  // LLM translates steps into spec files AND (only when needed) authors new
  // page-object methods, constrained to the grounded property allow-list.
  const specFiles: PlaywrightAutomationFile[] = []
  const genWarnings: string[] = []
  const allowList = buildAllowList(context)
  for (let i = 0; i < testCases.length; i += CHUNK_SIZE) {
    if (cfg.signal?.aborted) {
      const remaining = testCases.length - i
      genWarnings.push(`Stopped by user — ${remaining} test case(s) were not translated to automation.`)
      break
    }
    const chunk = testCases.slice(i, i + CHUNK_SIZE)
    cfg.onProgress?.(`translating cases ${i + 1}-${i + chunk.length}/${testCases.length}`)

    const knownMethodNames = new Map(
      [...methodsByPage.entries()].map(([slug, methods]) => [slug, methods.map(m => m.name)])
    )
    try {
      const raw = await aiService.complete(
        provider, apiKey, model,
        buildTranslationPrompt(chunk, pages, knownMethodNames, hasGrounding, context.collections || []),
        { json: true, temperature: 0.2, maxTokens: cfg.maxTokens ?? 8000, signal: cfg.signal }
      )
      const parsed = await parseWithRepair(raw, ChunkResponseSchema, repair)
      specFiles.push(...(parsed.testFiles as PlaywrightAutomationFile[]))

      for (const pm of parsed.pageMethods) {
        const page = knownPageNames.get(pm.page.toLowerCase())
        if (!page) continue // model referenced an unknown page – drop rather than create bogus files
        const name = extractMethodName(pm.code)
        if (!name) continue
        // Correct a misused escape hatch first: todoSelector('.card') where
        // '.card' is actually a grounded collection selector resolves to
        // `[data-todo=".card"]`, matching nothing, on an element that's real.
        const { code: corrected, fixed } = fixMisusedTodoSelector(pm.code, context.collections || [])
        if (fixed > 0) {
          genWarnings.push(`${page.name}.${name}(): ${fixed} call(s) to todoSelector() referenced an already-grounded collection – rewritten to the real locator.`)
        }
        // Degrade, don't discard: an ungrounded locator becomes todoSelector()
        // so the rest of the method (and its test) survives. Only when we HAVE
        // grounding can we claim a raw locator was invented.
        const { code: degraded, replaced } = degradeUngroundedLocators(corrected, allowList, hasGrounding)
        if (replaced > 0) {
          genWarnings.push(`${page.name}.${name}(): ${replaced} ungrounded locator(s) replaced with todoSelector() – supply the real locator; the rest of the test is intact.`)
        }
        const code = desyncLocatorGetter(degraded)
        const existing = methodsByPage.get(page.slug) || []
        const clash = existing.find(m => m.name === name)
        if (clash) {
          if (clash.code !== code) {
            genWarnings.push(`${page.name}.${name}() was authored twice with different bodies – kept the first. Callers expecting the other signature will fail to compile.`)
          }
          continue // keep the first authored version
        }
        methodsByPage.set(page.slug, [...existing, { name, code }])
      }
    } catch (err: any) {
      if (err instanceof GenerationAbortedError) {
        const remaining = testCases.length - i
        genWarnings.push(`Stopped by user — ${remaining} test case(s) were not translated to automation.`)
        break
      }
      for (const tc of chunk) {
        specFiles.push({
          filename: `tests/${tc.id.toLowerCase()}.spec.ts`,
          code: `import { test, expect } from '../fixtures/base.fixture'\n\n// GENERATION FAILED for ${tc.id}: ${String(err.message).slice(0, 120)}\n// TODO-SELECTOR: implement manually\ntest.fixme('${tc.id}: ${tc.summary.replace(/'/g, "\\'")}', async ({ page }) => {})\n`
        })
      }
    }
  }

  // Verify every goto() target actually exists before shipping it. Guessed
  // routes ('/products' → 404) and fabricated hosts are the single biggest
  // source of "the whole spec fails at line 1". Best-effort: skipped without a
  // baseUrl, and a proxy failure never punishes the generated test.
  const allGotoPaths = specFiles.flatMap(f => extractGotoPaths(f.code))
  let missingRoutes: Set<string>
  if (context.verified) {
    // The grounding CLI already probed every route with a real browser; don't
    // re-hit the network, and don't second-guess it.
    const known = new Set(context.knownMissingRoutes || [])
    missingRoutes = new Set(allGotoPaths.filter(p => known.has(p)))
  } else {
    cfg.onProgress?.('verifying navigation routes')
    missingRoutes = await verifyRoutes(context.baseUrl, allGotoPaths)
  }
  for (const path of missingRoutes) {
    genWarnings.push(`Route "${path}" does not exist on ${context.baseUrl} (404 / unreachable) – specs navigating to it were disabled.`)
  }
  for (const label of context.unresolvedLabels || []) {
    genWarnings.push(`"${label}" could not be uniquely resolved on the live page – any step needing it is a todoSelector() stub, not a guess.`)
  }

  // The spec stage and the page-object stage are separate LLM outputs and can
  // drift. Diff "methods specs call" against "methods page objects define" –
  // an undefined call is a guaranteed `TypeError: x is not a function`.
  const definedByFixture = new Map<string, Set<string>>()
  const propertiesByFixture = new Map<string, Set<string>>()
  for (const page of pages) {
    const fixtureName = camelCase(page.name)
    definedByFixture.set(fixtureName, new Set((methodsByPage.get(page.slug) || []).map(m => m.name)))
    propertiesByFixture.set(fixtureName, new Set(page.properties.map(p => p.name)))
  }

  const summaryById = new Map(testCases.map(tc => [tc.id.toLowerCase(), tc.summary]))

  // AST-based check (regex genuinely cannot do this one): a collection locator
  // matches MULTIPLE elements, and passing it to a single-element assertion
  // (expect(x).toBeVisible() etc.) throws "strict mode violation" at runtime –
  // verified live against a real site. Catching it requires tracking a
  // variable's identity across separate statements, which needs a real parser.
  const collectionItemSelectors = new Set((context.collections || []).map(c => c.itemSelector))
  const allAuthoredMethods = [...methodsByPage.values()].flat()
  const rawCollectionMethods = await findRawCollectionMethods(allAuthoredMethods, collectionItemSelectors)

  for (let i = 0; i < specFiles.length; i++) {
    const file = specFiles[i]
    const tcId = file.filename.replace(/^tests\//, '').replace(/\.spec\.ts$/, '')
    const summary = summaryById.get(tcId) || 'implement manually'

    // Same correction as page methods, applied here too: found live, a spec
    // called `home.todoSelector('.card')` directly (no page method involved at
    // all) for a collection that WAS grounded – todoSelector() resolves to
    // `[data-todo=".card"]`, matching nothing real.
    const { code: correctedCode, fixed: todoFixed } = fixMisusedTodoSelector(file.code, context.collections || [])
    if (todoFixed > 0) {
      genWarnings.push(`${tcId.toUpperCase()}: ${todoFixed} call(s) to todoSelector() in the spec referenced an already-grounded collection – rewritten to the real locator.`)
    }

    const missingCalls: string[] = []
    for (const [fixtureName, defined] of definedByFixture) {
      missingCalls.push(...findMissingPageMethods(correctedCode, fixtureName, defined).map(m => `${fixtureName}.${m}()`))
    }
    for (const [fixtureName, props] of propertiesByFixture) {
      missingCalls.push(...findMissingLocatorProperties(correctedCode, fixtureName, props).map(p => `${fixtureName}.locators.${p}`))
    }
    const badRoute = extractGotoPaths(correctedCode).find(p => missingRoutes.has(p))
    // A spec must never author its own raw locator (the CRITICAL RULE says so
    // explicitly) – but nothing previously enforced it. Found live: a spec
    // asserted `page.locator('.dashboard-container')` for a dashboard that
    // does not exist anywhere in the grounded app – a fully invented element,
    // written directly in the spec instead of routed through a page object.
    const invented = hasGrounding ? findUngroundedLocators(correctedCode, allowList) : []

    let reason: string | null = null
    if (hasExecutableTodoSelector(correctedCode)) {
      reason = 'a spec-level locator embedded an ungrounded TODO-SELECTOR'
    } else if (missingCalls.length > 0) {
      reason = `it calls page-object method(s) that were never defined: ${missingCalls.join(', ')}`
      genWarnings.push(`${tcId.toUpperCase()}: spec/page-object drift – ${missingCalls.join(', ')} not defined.`)
    } else if (invented.length > 0) {
      reason = `it authors ${invented.length} raw locator(s) directly in the spec for element(s) not present anywhere in the grounded app`
      genWarnings.push(`${tcId.toUpperCase()}: spec authored an ungrounded raw locator directly (bypassing the page object) – likely an invented element.`)
    } else if (badRoute) {
      reason = `it navigates to "${badRoute}", which does not exist on the target site`
    } else {
      const cardinalityViolations = await auditLocatorCardinality(correctedCode, collectionItemSelectors, rawCollectionMethods)
      if (cardinalityViolations.length > 0) {
        reason = `it asserts a single-element check on a collection locator (line ${cardinalityViolations[0].line}) – Playwright throws "strict mode violation" at runtime`
        genWarnings.push(`${tcId.toUpperCase()}: ${cardinalityViolations.map(v => `line ${v.line}: ${v.message}`).join(' | ')}`)
      }
    }

    specFiles[i] = reason
      ? { filename: file.filename, code: buildFixmeStub(file.filename, reason, summary) }
      : { filename: file.filename, code: enforceTestTitle(correctedCode, tcId, summary) }
  }

  // Assemble final page-object files: deterministic shell + accumulated LLM methods.
  const pageObjectFiles = pages.map(page =>
    assemblePageObjectFile(page, (methodsByPage.get(page.slug) || []).map(m => m.code))
  )
  const fixturesFile = buildFixturesFile(pages)

  // Auth setup project: only scaffolded when a login-like page was actually
  // grounded, so we're not inventing a login flow that doesn't exist.
  const loginPage = pages.find(p => /log.?in|sign.?in/i.test(p.name) && p.properties.length > 0)
  const loginMethods = loginPage ? (methodsByPage.get(loginPage.slug) || []) : []
  const loginMethod = loginMethods.find(m => /log.?in|sign.?in|authenticate/i.test(m.name))
  // Found by actually running a generated framework: the setup file called the
  // login method WITHOUT EVER NAVIGATING there first. On the default blank
  // start page, `.fill()`/`.click()` wait for an element that will never
  // appear, timing out the full 45s test budget instead of failing instantly.
  // Only emit a real path when we KNOW it (never guess a route – same rule as
  // goto() verification elsewhere in this file).
  const loginUrl = loginPage ? context.pageUrls?.[loginPage.name] : undefined
  const loginPath = loginUrl ? new URL(loginUrl).pathname + new URL(loginUrl).search : undefined
  if (loginPage && !loginPath) {
    genWarnings.push(`Auth setup for "${loginPage.name}" has no known URL – add "await page.goto('/your-login-path')" to tests/auth.setup.ts manually before the login call.`)
  }
  const authSetupFile = loginPage
    ? buildAuthSetupFile({ fixtureName: camelCase(loginPage.name), methodName: loginMethod?.name, loginPath })
    : null

  scaffold.playwrightConfig = buildPlaywrightConfig(context.baseUrl, !!authSetupFile)

  // Surface every generation-time rejection in the README – a silently smaller
  // suite is worse than a visibly-annotated one.
  if (genWarnings.length > 0) {
    scaffold.readme += `\n\n## ⚠️ Generation warnings (${genWarnings.length})\n\nThese were rejected rather than shipped as broken code. Each disabled spec is marked \`test.fixme\` — fill in the real selector/route, then remove \`fixme\`.\n\n${genWarnings.map(w => `- ${w}`).join('\n')}\n`
  }

  const supportFiles: PlaywrightAutomationFile[] = [
    { filename: '.gitignore', code: buildGitignore() },
    { filename: '.env.example', code: buildEnvExample() },
    { filename: '.github/workflows/playwright.yml', code: buildCIWorkflow() },
    ...(authSetupFile ? [authSetupFile] : [])
  ]

  const allFiles = [...scaffold.testFiles, ...pageObjectFiles, fixturesFile, ...supportFiles, ...specFiles]
  // Grounding % only reflects the parts that vary with user-provided context –
  // shared components/base-page are intentionally generic boilerplate and
  // would otherwise wrongly drag the ratio down.
  const groundableFiles = [...locatorsFiles, ...pageObjectFiles, ...specFiles]
  const stats = computeGroundingStats(groundableFiles, context)

  return {
    ...scaffold,
    testFiles: allFiles,
    frameworkAware: false,
    selectorGroundingRate: hasGrounding ? stats.rate : 0,
    todoSelectorCount: stats.todoCount,
    pageObjectNames: pages.map(p => p.className),
    warnings: genWarnings,
    reusedPageClasses: []
  }
}

// ─── Framework-aware path ────────────────────────────────────────────────────
// When the user supplies their own repository we do NOT scaffold a Page Object
// Model — theirs already exists. The model writes specs against their classes
// and fixtures, and any method it has to add is spliced into their real file so
// what comes out is a drop-in diff, not a parallel framework to reconcile.

interface FrameworkChunkResult {
  specFiles: PlaywrightAutomationFile[]
  /** className -> authored method bodies, in first-authored order. */
  methodsByClass: Map<string, { name: string; code: string }[]>
  warnings: string[]
}

function buildFrameworkTranslationPrompt(
  cases: TestCase[],
  framework: FrameworkProfile,
  context: AutomationContext,
  knownMethods: Map<string, string[]>
): string {
  const c = framework.conventions
  const groundedBlock =
    (context.elements || []).length > 0
      ? `\nGROUNDED SELECTORS (verified to exist on the live page — use these when you must add a new method):\n${(context.elements || [])
          .slice(0, 120)
          .map(e => `  - ${e.selector}   // ${e.kind}: "${e.label}"${e.page ? ` [${e.page}]` : ''}`)
          .join('\n')}\n`
      : '\nNo DOM snapshot or recording was supplied, so no selector is verified. Base any new locator on the step text using getByRole/getByLabel/getByPlaceholder, and mark it with a "// TODO-SELECTOR" comment on its own line.\n'

  const collections = describeCollections(context.collections || [])

  const authoredBlock = [...knownMethods.entries()]
    .filter(([, methods]) => methods.length > 0)
    .map(([className, methods]) => `  ${className}: ${methods.join(', ')}`)
    .join('\n')

  return `You are a senior SDET adding tests to an EXISTING Playwright TypeScript repository. The framework is already built — your job is to write specs that fit into it as if a member of that team wrote them.

${buildFrameworkPromptContext(framework)}
${groundedBlock}${collections}
${authoredBlock ? `\nMETHODS YOU ALREADY AUTHORED EARLIER IN THIS RUN (call them, do not re-author):\n${authoredBlock}\n` : ''}
OUTPUT RULES:
- One spec file per test case, named to match the repo convention (\`${c.specFileNaming}\`) and placed in \`${c.specDir}/\`.
- Import the test runner exactly as the repo does: ${c.testImport}
- ${framework.fixtures.length > 0
      ? `Destructure the repo's fixtures in the test callback — available: ${framework.fixtures.map(f => f.name).join(', ')}. Do NOT instantiate page objects manually.`
      : 'Instantiate page objects the way the existing specs do.'}
- Match the repo's formatting: ${c.indentation} indentation, ${c.quoteStyle} quotes, ${c.usesSemicolons ? 'semicolons' : 'no semicolons'}.
- NEVER write a raw locator (page.getByRole/locator/…) inside a spec file. Every interaction goes through a page-object method or an existing locator property.
- Every test title must begin with its test case id, e.g. test('TC-001 — …').

WHEN A NEEDED ACTION HAS NO METHOD:
- Add it via the "pageMethods" array below, keyed by the EXACT existing class name it belongs to. It will be inserted into that class's real file.
- Inside a new method, reference the class's existing locator properties (this.someLocator) wherever one fits. Only introduce a new locator when nothing existing covers it, and prefer a grounded selector from the list above.
- Do not re-declare a class, re-declare an existing method, or change an existing method's signature.

NAVIGATION:
- Navigate with RELATIVE paths only (await page.goto('/checkout')). ${framework.baseUrl ? `The repo's baseURL is ${framework.baseUrl}.` : 'playwright.config.ts supplies the baseURL.'}
- Never write an absolute URL, and never guess a route that appears nowhere above.

TEST INDEPENDENCE:
- Each spec must stand alone — no reliance on another file having run first.
- Use web-first assertions (await expect(locator)…). Never use waitForTimeout or manual sleeps.

Return ONLY valid JSON in this exact shape:
{
  "testFiles": [{"filename": "${c.specDir}/login.spec.ts", "code": "<full file contents>"}],
  "pageMethods": [{"page": "<exact existing class name>", "code": "async methodName(args) {\\n  await this.someLocator.click()\\n}"}]
}
Omit "pageMethods" or leave it empty if no new methods are needed.

Test cases to translate:
${JSON.stringify(
  cases.map(tc => ({ id: tc.id, summary: tc.summary, precondition: tc.precondition, steps: tc.steps })),
  null,
  2
)}`
}

async function translateAgainstFramework(cfg: {
  provider: AIProvider
  apiKey: string
  model: string
  testCases: TestCase[]
  framework: FrameworkProfile
  context: AutomationContext
  maxTokens?: number
  signal?: AbortSignal
  onProgress?: (detail: string) => void
}): Promise<FrameworkChunkResult> {
  const { provider, apiKey, model, testCases, framework, context } = cfg
  const repair = aiService.makeRepairFn(provider, apiKey, model)
  const allowList = buildAllowList(context, framework)
  const classNames = new Map(framework.pages.map(p => [p.className.toLowerCase(), p.className]))

  const specFiles: PlaywrightAutomationFile[] = []
  const methodsByClass = new Map<string, { name: string; code: string }[]>()
  const warnings: string[] = []

  for (let i = 0; i < testCases.length; i += CHUNK_SIZE) {
    if (cfg.signal?.aborted) {
      warnings.push(`Stopped by user — ${testCases.length - i} test case(s) were not translated to automation.`)
      break
    }
    const chunk = testCases.slice(i, i + CHUNK_SIZE)
    cfg.onProgress?.(`translating cases ${i + 1}-${i + chunk.length}/${testCases.length} against ${framework.projectName}`)

    const knownMethods = new Map(
      [...methodsByClass.entries()].map(([cls, methods]) => [cls, methods.map(m => m.name)])
    )
    // Existing repo methods count as known too, so the model is told not to re-author them.
    for (const page of framework.pages) {
      const authored = knownMethods.get(page.className) || []
      knownMethods.set(page.className, [...new Set([...page.methods.map(m => m.name), ...authored])])
    }

    try {
      const raw = await aiService.complete(
        provider,
        apiKey,
        model,
        buildFrameworkTranslationPrompt(chunk, framework, context, knownMethods),
        { json: true, temperature: 0.2, maxTokens: cfg.maxTokens ?? 8000, signal: cfg.signal }
      )
      const parsed = await parseWithRepair(raw, ChunkResponseSchema, repair)
      specFiles.push(...(parsed.testFiles as PlaywrightAutomationFile[]))

      for (const pm of parsed.pageMethods) {
        const className = classNames.get(String(pm.page).toLowerCase())
        if (!className) {
          warnings.push(`Dropped a method authored for "${pm.page}", which is not a class in your framework.`)
          continue
        }
        const name = extractMethodName(pm.code)
        if (!name) continue

        const page = framework.pages.find(p => p.className === className)!
        if (page.methods.some(m => m.name === name)) {
          warnings.push(`${className}.${name}() already exists in your framework – the model's re-authored version was discarded, yours is kept.`)
          continue
        }

        const { code: corrected, fixed } = fixMisusedTodoSelector(pm.code, context.collections || [])
        if (fixed > 0) {
          warnings.push(`${className}.${name}(): ${fixed} todoSelector() call(s) referenced an already-grounded collection – rewritten to the real locator.`)
        }
        const { code: degraded, replaced } = degradeUngroundedLocators(
          corrected,
          allowList,
          (context.elements || []).length > 0
        )
        if (replaced > 0) {
          warnings.push(`${className}.${name}(): ${replaced} ungrounded locator(s) replaced with todoSelector() – supply the real locator; the rest of the test is intact.`)
        }
        const code = desyncLocatorGetter(degraded)

        const existing = methodsByClass.get(className) || []
        if (existing.some(m => m.name === name)) continue
        methodsByClass.set(className, [...existing, { name, code }])
      }
    } catch (err: any) {
      if (err instanceof GenerationAbortedError) {
        warnings.push(`Stopped by user — ${testCases.length - i} test case(s) were not translated to automation.`)
        break
      }
      for (const tc of chunk) {
        specFiles.push({
          filename: `${framework.conventions.specDir}/${tc.id.toLowerCase()}.spec.ts`,
          code: buildFixmeStub(
            `${tc.id}.spec.ts`,
            `generation failed: ${String(err?.message ?? err).slice(0, 120)}`,
            tc.summary
          )
        })
      }
      warnings.push(`Batch ${i / CHUNK_SIZE + 1} failed to generate and was stubbed as test.fixme: ${String(err?.message ?? err).slice(0, 160)}`)
    }
  }

  return { specFiles, methodsByClass, warnings }
}

async function buildFrameworkAwareSuite(cfg: {
  provider: AIProvider
  apiKey: string
  model: string
  projectName: string
  testCases: TestCase[]
  framework: FrameworkProfile
  context?: AutomationContext
  maxTokens?: number
  signal?: AbortSignal
  onProgress?: (detail: string) => void
}): Promise<AutomationBuildResult> {
  const { framework, testCases } = cfg
  const context = cfg.context || {}
  const warnings: string[] = [...framework.warnings]

  const { specFiles, methodsByClass, warnings: genWarnings } = await translateAgainstFramework({
    ...cfg,
    context
  })
  warnings.push(...genWarnings)

  // Splice authored methods into the user's real files, so each touched page
  // object comes back complete and drop-in rather than as a fragment to merge.
  const updatedPageFiles: PlaywrightAutomationFile[] = []
  for (const [className, methods] of methodsByClass) {
    const page = framework.pages.find(p => p.className === className)
    if (!page) continue
    const indent = framework.conventions.indentation === 'tab' ? '\t' : framework.conventions.indentation === '4 spaces' ? '    ' : '  '
    const spliced = spliceMethodsIntoClass(page.source, className, methods.map(m => m.code), indent)
    if (spliced) {
      updatedPageFiles.push({ filename: page.filePath, code: spliced })
    } else {
      warnings.push(`Could not locate class ${className} in ${page.filePath} to insert ${methods.length} new method(s) — they are listed in the README instead.`)
    }
  }

  // Same route verification as the generated-POM path: a guessed goto() is the
  // single biggest cause of "the whole spec fails at line 1".
  cfg.onProgress?.('verifying navigation routes')
  const baseUrl = context.baseUrl || framework.baseUrl
  const missingRoutes = context.verified
    ? new Set((context.knownMissingRoutes || []).filter(p => specFiles.some(f => extractGotoPaths(f.code).includes(p))))
    : await verifyRoutes(baseUrl, specFiles.flatMap(f => extractGotoPaths(f.code)))
  for (const path of missingRoutes) {
    warnings.push(`Route "${path}" does not exist on ${baseUrl} (404 / unreachable) – specs navigating to it were disabled.`)
  }

  // Validate specs against the framework's real API plus anything authored now.
  const definedByFixture = new Map<string, Set<string>>()
  const propertiesByFixture = new Map<string, Set<string>>()
  for (const fixture of framework.fixtures) {
    const page = framework.pages.find(p => p.className === fixture.type)
    if (!page) continue
    const authored = (methodsByClass.get(page.className) || []).map(m => m.name)
    definedByFixture.set(fixture.name, new Set([...page.methods.map(m => m.name), ...authored]))
    propertiesByFixture.set(fixture.name, new Set(page.locators))
  }

  const summaryById = new Map(testCases.map(tc => [tc.id.toLowerCase(), tc.summary]))
  const collectionItemSelectors = new Set((context.collections || []).map(c => c.itemSelector))
  const rawCollectionMethods = await findRawCollectionMethods(
    [...methodsByClass.values()].flat(),
    collectionItemSelectors
  )

  const checkedSpecs: PlaywrightAutomationFile[] = []
  for (const file of specFiles) {
    const tcId =
      testCases.find(tc => file.code.includes(tc.id))?.id.toLowerCase() ||
      file.filename.split('/').pop()!.replace(/\.(spec|test)\.ts$/, '')
    const summary = summaryById.get(tcId) || 'implement manually'

    const { code: correctedCode, fixed: todoFixed } = fixMisusedTodoSelector(file.code, context.collections || [])
    if (todoFixed > 0) {
      warnings.push(`${tcId.toUpperCase()}: ${todoFixed} todoSelector() call(s) in the spec referenced an already-grounded collection – rewritten to the real locator.`)
    }

    const missingCalls: string[] = []
    for (const [fixtureName, defined] of definedByFixture) {
      missingCalls.push(...findMissingPageMethods(correctedCode, fixtureName, defined).map(m => `${fixtureName}.${m}()`))
    }
    for (const [fixtureName, props] of propertiesByFixture) {
      missingCalls.push(...findMissingLocatorProperties(correctedCode, fixtureName, props).map(p => `${fixtureName}.locators.${p}`))
    }
    const badRoute = extractGotoPaths(correctedCode).find(p => missingRoutes.has(p))

    let reason: string | null = null
    if (hasExecutableTodoSelector(correctedCode)) {
      reason = 'a spec-level locator embedded an ungrounded TODO-SELECTOR'
    } else if (missingCalls.length > 0) {
      reason = `it calls page-object member(s) your framework does not define: ${missingCalls.join(', ')}`
      warnings.push(`${tcId.toUpperCase()}: spec/framework drift – ${missingCalls.join(', ')} not defined.`)
    } else if (badRoute) {
      reason = `it navigates to "${badRoute}", which does not exist on the target site`
    } else {
      const violations = await auditLocatorCardinality(correctedCode, collectionItemSelectors, rawCollectionMethods)
      if (violations.length > 0) {
        reason = `it asserts a single-element check on a collection locator (line ${violations[0].line}) – Playwright throws "strict mode violation" at runtime`
        warnings.push(`${tcId.toUpperCase()}: ${violations.map(v => `line ${v.line}: ${v.message}`).join(' | ')}`)
      }
    }

    checkedSpecs.push(
      reason
        ? { filename: file.filename, code: buildFixmeStub(file.filename, reason, summary) }
        : { filename: file.filename, code: enforceTestTitle(correctedCode, tcId, summary) }
    )
  }

  const covered = new Set(testCases.filter(tc => checkedSpecs.some(f => f.code.includes(tc.id))).map(tc => tc.id))
  const uncovered = testCases.filter(tc => !covered.has(tc.id)).map(tc => tc.id)
  if (uncovered.length > 0) {
    warnings.push(`${uncovered.length} test case(s) produced no spec: ${uncovered.slice(0, 8).join(', ')}${uncovered.length > 8 ? '…' : ''}`)
  }

  const stats = computeGroundingStats([...updatedPageFiles, ...checkedSpecs], context)

  let readme = buildFrameworkReadme(cfg.projectName, testCases, framework, updatedPageFiles, checkedSpecs)
  if (warnings.length > 0) {
    readme += `\n\n## ⚠️ Generation warnings (${warnings.length})\n\nThese were rejected or corrected rather than shipped as broken code. Each disabled spec is marked \`test.fixme\` — fill in the real selector/route, then remove \`fixme\`.\n\n${warnings.map(w => `- ${w}`).join('\n')}\n`
  }

  return {
    frameworkAware: true,
    readme,
    packageJson: buildPackageJson(cfg.projectName.toLowerCase().replace(/[^a-z0-9-]+/g, '-')),
    tsconfigJson: buildTsconfig(),
    playwrightConfig: buildPlaywrightConfig(baseUrl),
    testFiles: [
      ...updatedPageFiles,
      ...checkedSpecs,
      { filename: '.env.example', code: buildEnvExample() },
      { filename: '.github/workflows/playwright.yml', code: buildCIWorkflow() }
    ],
    selectorGroundingRate: (context.elements || []).length > 0 ? stats.rate : 0,
    todoSelectorCount: stats.todoCount,
    pageObjectNames: framework.pages.map(p => p.className),
    warnings,
    reusedPageClasses: [...new Set([...methodsByClass.keys()])]
  }
}

function buildFrameworkReadme(
  projectName: string,
  testCases: TestCase[],
  framework: FrameworkProfile,
  updatedPageFiles: PlaywrightAutomationFile[],
  specs: PlaywrightAutomationFile[]
): string {
  const caseList = testCases.map(tc => `- **${tc.id}** — ${tc.summary} (${tc.scenarioType})`).join('\n')
  return `# ${projectName} — tests for ${framework.projectName}

Generated by **QA Nexus AI** against your existing framework (\`${framework.projectName}\`, ${framework.fileCount} source files analysed). These files are meant to be dropped straight into that repository.

## What to copy where

${specs.length > 0 ? `**New spec files** (${specs.length}) → \`${framework.conventions.specDir}/\`\n${specs.map(f => `- \`${f.filename}\``).join('\n')}` : '_No spec files were produced._'}

${updatedPageFiles.length > 0
    ? `**Updated page objects** (${updatedPageFiles.length}) — these are your original files with new methods appended, so they replace the existing ones wholesale:\n${updatedPageFiles.map(f => `- \`${f.filename}\``).join('\n')}`
    : '**No page objects were modified** — every action the tests needed already existed in your framework.'}

\`package.json\`, \`tsconfig.json\` and \`playwright.config.ts\` are included only as a standalone fallback. **Keep your own** — yours are already configured.

## What was reused

- Page classes: ${framework.pages.length > 0 ? framework.pages.map(p => `\`${p.className}\``).join(', ') : 'none detected'}
- Fixtures: ${framework.fixtures.length > 0 ? framework.fixtures.map(f => `\`${f.name}\``).join(', ') : 'none detected'}
- Locator strategy: ${framework.conventions.locatorStrategy}
- Naming: \`${framework.conventions.pageFileNaming}\` / \`${framework.conventions.specFileNaming}\`
- Formatting: ${framework.conventions.indentation}, ${framework.conventions.quoteStyle} quotes, ${framework.conventions.usesSemicolons ? 'semicolons' : 'no semicolons'}

## Covered test cases

${caseList}
`
}

/**
 * Single entry point. Routes to the framework-aware path when the user supplied
 * their own repository, and to the deterministic Page Object Model scaffold
 * otherwise.
 */
export async function buildAutomationSuite(cfg: {
  provider: AIProvider
  apiKey: string
  model: string
  projectName: string
  testCases: TestCase[]
  context?: AutomationContext
  framework?: FrameworkProfile | null
  maxTokens?: number
  signal?: AbortSignal
  onProgress?: (detail: string) => void
}): Promise<AutomationBuildResult> {
  if (cfg.framework && cfg.framework.pages.length > 0) {
    return buildFrameworkAwareSuite({ ...cfg, framework: cfg.framework })
  }
  return buildGeneratedPomSuite(cfg)
}
