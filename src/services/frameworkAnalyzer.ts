import JSZip from 'jszip'

// ─── Framework-aware generation ──────────────────────────────────────────────
// The user drops in their existing Playwright repo (zip or directory picker).
// We parse it entirely in the browser — no upload, no server round-trip — and
// distil it into a compact FrameworkProfile that gets injected into the
// generation prompt. The model then writes specs that call the user's OWN page
// classes and follow their OWN conventions instead of inventing generic ones.

export interface PageObjectMethod {
  name: string
  params: string
  isAsync: boolean
}

export interface PageObjectClass {
  className: string
  filePath: string
  /** Named exports/properties that resolve to Playwright locators. */
  locators: string[]
  methods: PageObjectMethod[]
  extendsClass?: string
  /**
   * Verbatim contents of the file this class lives in. Retained so the
   * generator can splice newly-authored methods into the user's real class and
   * hand back a complete, drop-in file — never a fragment they have to merge.
   */
  source: string
}

export interface FixtureEntry {
  name: string
  type: string
  filePath: string
}

export interface FrameworkConventions {
  /** e.g. "login.page.ts" | "LoginPage.ts" | "login-page.ts" */
  pageFileNaming: string
  /** e.g. "login.spec.ts" | "login.test.ts" */
  specFileNaming: string
  /** Directory that holds page objects, relative to repo root. */
  pageDir: string
  /** Directory that holds specs. */
  specDir: string
  /** Dominant locator strategy observed across the repo. */
  locatorStrategy: string
  /** How specs import the test runner, verbatim. */
  testImport: string
  indentation: string
  quoteStyle: 'single' | 'double'
  usesSemicolons: boolean
}

export interface FrameworkProfile {
  projectName: string
  fileCount: number
  pages: PageObjectClass[]
  fixtures: FixtureEntry[]
  conventions: FrameworkConventions
  baseUrl?: string
  /** Files the user supplied that we recognised but did not model. */
  otherFiles: string[]
  warnings: string[]
}

export interface RawFile {
  path: string
  content: string
}

const CODE_EXT = /\.(ts|tsx|js|mjs|cjs)$/i
const IGNORED_DIRS = /(^|\/)(node_modules|\.git|dist|build|coverage|playwright-report|test-results|\.next|\.turbo)(\/|$)/
const MAX_FILES = 400
const MAX_FILE_BYTES = 300_000

function isAnalyzable(path: string): boolean {
  return CODE_EXT.test(path) && !IGNORED_DIRS.test(path)
}

/** Strips the single common top-level folder a zip usually wraps everything in. */
function stripCommonRoot(files: RawFile[]): RawFile[] {
  if (files.length === 0) return files
  const firstSegments = new Set(files.map(f => f.path.split('/')[0]))
  if (firstSegments.size !== 1) return files
  const root = [...firstSegments][0]
  if (!files.every(f => f.path.startsWith(`${root}/`))) return files
  return files.map(f => ({ ...f, path: f.path.slice(root.length + 1) }))
}

export async function readZip(file: File): Promise<RawFile[]> {
  const zip = await JSZip.loadAsync(file)
  const entries = Object.values(zip.files).filter(e => !e.dir && isAnalyzable(e.name))
  if (entries.length === 0) {
    throw new Error('No TypeScript/JavaScript source files found in that archive.')
  }
  const picked = entries.slice(0, MAX_FILES)
  const files = await Promise.all(
    picked.map(async e => ({ path: e.name, content: await e.async('string') }))
  )
  return stripCommonRoot(files.filter(f => f.content.length <= MAX_FILE_BYTES))
}

export async function readDirectory(fileList: FileList | File[]): Promise<RawFile[]> {
  const all = Array.from(fileList)
  const candidates = all
    .map(f => ({ file: f, path: (f as any).webkitRelativePath || f.name }))
    .filter(({ path }) => isAnalyzable(path))
    .slice(0, MAX_FILES)

  if (candidates.length === 0) {
    throw new Error('No TypeScript/JavaScript source files found in that folder.')
  }
  const files = await Promise.all(
    candidates.map(async ({ file, path }) => ({ path, content: await file.text() }))
  )
  return stripCommonRoot(files.filter(f => f.content.length <= MAX_FILE_BYTES))
}

/** Removes comments and string bodies so scanners can't match on prose. */
function stripNoise(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

const LOCATOR_CALL = /\b(page|this\.page)\s*\.\s*(locator|getBy\w+|frameLocator)\s*\(/

export function extractPageObjects(files: RawFile[]): PageObjectClass[] {
  const pages: PageObjectClass[] = []

  for (const file of files) {
    const source = stripNoise(file.content)
    const classRe = /(?:export\s+(?:default\s+)?)?class\s+([A-Za-z_$][\w$]*)(?:\s+extends\s+([A-Za-z_$][\w$.]*))?\s*{/g
    let match: RegExpExecArray | null

    while ((match = classRe.exec(source)) !== null) {
      const [, className, extendsClass] = match
      const body = sliceClassBody(source, classRe.lastIndex - 1)
      if (!body) continue

      const locators = extractLocators(body)
      const methods = extractMethods(body)

      // A page object is a class that owns locators, or one that lives in a
      // pages/ directory and exposes async methods.
      const looksLikePage =
        locators.length > 0 ||
        (/(^|\/)(pages|page-objects|pageobjects|po)\//i.test(file.path) && methods.some(m => m.isAsync))
      if (!looksLikePage) continue

      pages.push({ className, filePath: file.path, locators, methods, extendsClass, source: file.content })
    }
  }

  return pages
}

/**
 * Inserts newly-authored methods just before a class's closing brace, in the
 * user's own file. Indentation is inferred from the file so the result matches
 * the surrounding style. Returns null when the class can't be located, so the
 * caller can fall back to emitting a standalone file rather than corrupting
 * the original.
 */
export function spliceMethodsIntoClass(
  source: string,
  className: string,
  methods: string[],
  indent = '  '
): string | null {
  if (methods.length === 0) return source

  const classRe = new RegExp(`class\\s+${className}\\b[^{]*{`)
  const match = classRe.exec(source)
  if (!match) return null

  const openBraceIndex = match.index + match[0].length - 1
  let depth = 0
  let closeBraceIndex = -1
  for (let i = openBraceIndex; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) {
        closeBraceIndex = i
        break
      }
    }
  }
  if (closeBraceIndex === -1) return null

  const block = methods
    .map(code =>
      code
        .trim()
        .split('\n')
        .map(line => (line.trim() ? indent + line.replace(/^\s{0,4}/, '') : line))
        .join('\n')
    )
    .join('\n\n')

  return `${source.slice(0, closeBraceIndex).replace(/\s*$/, '\n\n')}${block}\n${source.slice(closeBraceIndex)}`
}

/** Given the index of a class body's opening brace, returns the balanced body. */
function sliceClassBody(source: string, openBraceIndex: number): string | null {
  let depth = 0
  for (let i = openBraceIndex; i < source.length; i++) {
    const ch = source[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return source.slice(openBraceIndex + 1, i)
    }
  }
  return null
}

function extractLocators(classBody: string): string[] {
  const names = new Set<string>()

  // readonly login = this.page.getByRole(...)  /  private submit: Locator = ...
  const fieldRe = /(?:readonly|private|public|protected|static|\s)*([A-Za-z_$][\w$]*)\s*(?::\s*[^=;\n]+)?\s*=\s*([^\n;]+)/g
  let m: RegExpExecArray | null
  while ((m = fieldRe.exec(classBody)) !== null) {
    if (LOCATOR_CALL.test(m[2])) names.add(m[1])
  }

  // get submitButton(): Locator { return this.page.locator(...) }
  const getterRe = /get\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^{;]+)?{([^}]*)}/g
  while ((m = getterRe.exec(classBody)) !== null) {
    if (LOCATOR_CALL.test(m[2])) names.add(m[1])
  }

  // submitButton: Locator   (declared, assigned in the constructor)
  const declRe = /(?:readonly|private|public|protected)\s+([A-Za-z_$][\w$]*)\s*:\s*Locator\b/g
  while ((m = declRe.exec(classBody)) !== null) names.add(m[1])

  return [...names]
}

const NON_METHOD_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'constructor', 'get', 'set'])

function extractMethods(classBody: string): PageObjectMethod[] {
  const methods: PageObjectMethod[] = []
  const seen = new Set<string>()
  const methodRe = /(?:^|\n)\s*(?:public\s+|private\s+|protected\s+|static\s+)*(async\s+)?([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*(?::\s*[^{;]+)?{/g
  let m: RegExpExecArray | null

  while ((m = methodRe.exec(classBody)) !== null) {
    const [, asyncKeyword, name, params] = m
    if (NON_METHOD_KEYWORDS.has(name) || seen.has(name)) continue
    seen.add(name)
    methods.push({ name, params: params.trim(), isAsync: Boolean(asyncKeyword) })
  }

  return methods
}

export function extractFixtures(files: RawFile[]): FixtureEntry[] {
  const fixtures: FixtureEntry[] = []
  const seen = new Set<string>()

  for (const file of files) {
    const source = stripNoise(file.content)
    // The base test is commonly aliased (`test as base`), so match on the
    // `.extend<…>` / `.extend(…)` call itself rather than on a receiver name.
    if (!/\bextend\s*[<(]/.test(source)) continue

    // base.extend<{ loginPage: LoginPage; cartPage: CartPage }>({ ... })
    const genericRe = /extend\s*<\s*{([^}]*)}\s*>/g
    let m: RegExpExecArray | null
    while ((m = genericRe.exec(source)) !== null) {
      for (const entry of m[1].split(/[;,\n]/)) {
        const pair = entry.trim().match(/^([A-Za-z_$][\w$]*)\s*:\s*([\w$.<>[\]]+)/)
        if (!pair || seen.has(pair[1])) continue
        seen.add(pair[1])
        fixtures.push({ name: pair[1], type: pair[2], filePath: file.path })
      }
    }
  }

  return fixtures
}

function majority<T extends string>(values: T[], fallback: T): T {
  if (values.length === 0) return fallback
  const counts = new Map<T, number>()
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0]
}

function fileNamePattern(paths: string[], fallback: string): string {
  const names = paths.map(p => p.split('/').pop() || '')
  const patterns = names.map(n => {
    if (/\.page\.(ts|js)$/i.test(n)) return 'login.page.ts'
    if (/\.po\.(ts|js)$/i.test(n)) return 'login.po.ts'
    if (/^[A-Z]/.test(n)) return 'LoginPage.ts'
    if (/-page\.(ts|js)$/i.test(n)) return 'login-page.ts'
    return n.includes('.') ? n : fallback
  })
  return majority(patterns, fallback)
}

function detectLocatorStrategy(files: RawFile[]): string {
  const tally: Record<string, number> = {}
  const bump = (key: string, n: number) => { tally[key] = (tally[key] || 0) + n }

  for (const file of files) {
    const source = stripNoise(file.content)
    bump('getByTestId', (source.match(/getByTestId\(/g) || []).length)
    bump('getByRole', (source.match(/getByRole\(/g) || []).length)
    bump('getByLabel', (source.match(/getByLabel\(/g) || []).length)
    bump('getByText', (source.match(/getByText\(/g) || []).length)
    bump('data-testid CSS', (source.match(/locator\(\s*['"`]\[data-test/g) || []).length)
    bump('CSS/XPath locator()', (source.match(/locator\(\s*['"`](?!\[data-test)/g) || []).length)
  }

  const ranked = Object.entries(tally).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1])
  if (ranked.length === 0) return 'getByRole (no locators detected — Playwright default)'
  return ranked.slice(0, 2).map(([k, n]) => `${k} (${n} uses)`).join(', ')
}

function detectTestImport(files: RawFile[]): string {
  const imports: string[] = []
  for (const file of files) {
    const m = file.content.match(/^import\s+{[^}]*\btest\b[^}]*}\s+from\s+['"][^'"]+['"];?/m)
    if (m) imports.push(m[0].trim())
  }
  return majority(imports, "import { test, expect } from '@playwright/test'")
}

function detectFormatting(files: RawFile[]) {
  let tabs = 0
  let twoSpace = 0
  let fourSpace = 0
  let singles = 0
  let doubles = 0
  let semiLines = 0
  let noSemiLines = 0

  for (const file of files) {
    for (const line of file.content.split('\n')) {
      const indent = line.match(/^([ \t]+)\S/)
      if (indent) {
        if (indent[1].includes('\t')) tabs++
        else if (indent[1].length % 4 === 0) fourSpace++
        else if (indent[1].length % 2 === 0) twoSpace++
      }
      const trimmed = line.trim()
      if (/^import\s|^export\s|;\s*$/.test(trimmed)) {
        if (trimmed.endsWith(';')) semiLines++
        else if (/^(import|export)\s/.test(trimmed)) noSemiLines++
      }
    }
    singles += (file.content.match(/'/g) || []).length
    doubles += (file.content.match(/"/g) || []).length
  }

  const indentation = tabs > twoSpace && tabs > fourSpace ? 'tab' : fourSpace > twoSpace ? '4 spaces' : '2 spaces'
  return {
    indentation,
    quoteStyle: (singles >= doubles ? 'single' : 'double') as 'single' | 'double',
    usesSemicolons: semiLines >= noSemiLines
  }
}

function detectDir(paths: string[], fallback: string): string {
  const dirs = paths.map(p => p.split('/').slice(0, -1).join('/')).filter(Boolean)
  return majority(dirs, fallback)
}

function detectBaseUrl(files: RawFile[]): string | undefined {
  for (const file of files) {
    if (!/playwright\.config\.(ts|js|mjs)$/i.test(file.path)) continue
    const m = file.content.match(/baseURL\s*:\s*(?:process\.env\.\w+\s*(?:\|\||\?\?)\s*)?['"`]([^'"`]+)['"`]/)
    if (m) return m[1]
  }
  return undefined
}

export function analyzeFramework(files: RawFile[], projectName: string): FrameworkProfile {
  const warnings: string[] = []
  const pages = extractPageObjects(files)
  const fixtures = extractFixtures(files)

  const specPaths = files.map(f => f.path).filter(p => /\.(spec|test)\.(ts|js)$/i.test(p))
  const pagePaths = pages.map(p => p.filePath)

  if (pages.length === 0) {
    warnings.push(
      'No page-object classes were detected. Generation will still follow your naming and locator conventions, but it cannot reuse existing page classes.'
    )
  }
  if (specPaths.length === 0) {
    warnings.push('No .spec.ts / .test.ts files found — spec naming and layout fall back to Playwright defaults.')
  }
  if (files.length >= MAX_FILES) {
    warnings.push(`Only the first ${MAX_FILES} source files were analysed.`)
  }

  const formatting = detectFormatting(files)

  return {
    projectName,
    fileCount: files.length,
    pages,
    fixtures,
    baseUrl: detectBaseUrl(files),
    otherFiles: files
      .map(f => f.path)
      .filter(p => !pagePaths.includes(p) && !specPaths.includes(p))
      .slice(0, 40),
    conventions: {
      pageFileNaming: fileNamePattern(pagePaths, 'login.page.ts'),
      specFileNaming: fileNamePattern(specPaths, 'login.spec.ts'),
      pageDir: detectDir(pagePaths, 'pages'),
      specDir: detectDir(specPaths, 'tests'),
      locatorStrategy: detectLocatorStrategy(files),
      testImport: detectTestImport(files),
      ...formatting
    },
    warnings
  }
}

/**
 * Renders the profile as the prompt fragment injected into generation. Kept
 * compact and budget-bounded: page signatures are what the model needs, not
 * whole files.
 */
export function buildFrameworkPromptContext(profile: FrameworkProfile, maxPages = 25): string {
  const c = profile.conventions
  const lines: string[] = []

  lines.push('### EXISTING TEST FRAMEWORK (the user\'s own repository)')
  lines.push(`Project: ${profile.projectName} — ${profile.fileCount} source files analysed.`)
  lines.push('')
  lines.push('CONVENTIONS TO MATCH EXACTLY:')
  lines.push(`- Page object files live in \`${c.pageDir}/\` and are named like \`${c.pageFileNaming}\``)
  lines.push(`- Spec files live in \`${c.specDir}/\` and are named like \`${c.specFileNaming}\``)
  lines.push(`- Locator strategy in use: ${c.locatorStrategy}`)
  lines.push(`- Test runner import (copy verbatim): ${c.testImport}`)
  lines.push(`- Indentation: ${c.indentation}; ${c.quoteStyle} quotes; ${c.usesSemicolons ? 'semicolons required' : 'no semicolons'}`)
  if (profile.baseUrl) lines.push(`- playwright.config baseURL: ${profile.baseUrl} (use relative paths in goto())`)

  if (profile.fixtures.length > 0) {
    lines.push('')
    lines.push('AVAILABLE TEST FIXTURES (destructure these in test callbacks):')
    for (const f of profile.fixtures.slice(0, 30)) {
      lines.push(`- ${f.name}: ${f.type}   (from ${f.filePath})`)
    }
  }

  if (profile.pages.length > 0) {
    lines.push('')
    lines.push('EXISTING PAGE OBJECTS — REUSE THESE, DO NOT REDEFINE THEM:')
    for (const page of profile.pages.slice(0, maxPages)) {
      lines.push('')
      lines.push(`class ${page.className}${page.extendsClass ? ` extends ${page.extendsClass}` : ''}   // ${page.filePath}`)
      if (page.locators.length > 0) {
        lines.push(`  locators: ${page.locators.slice(0, 30).join(', ')}`)
      }
      for (const m of page.methods.slice(0, 30)) {
        lines.push(`  ${m.isAsync ? 'async ' : ''}${m.name}(${m.params})`)
      }
    }
    if (profile.pages.length > maxPages) {
      lines.push('')
      lines.push(`…and ${profile.pages.length - maxPages} more page classes.`)
    }
  }

  lines.push('')
  lines.push('FRAMEWORK-AWARE RULES (highest priority):')
  lines.push('1. If an existing page class already covers a screen, import and call it. NEVER re-declare it.')
  lines.push('2. Only call methods listed above. If a needed action has no method, add it to that page class and return the updated file in `pageObjects`.')
  lines.push('3. Only reference locator properties listed above. Do not invent selectors on existing pages.')
  lines.push('4. Use the exact import path style, file naming, indentation, and quote style shown above.')
  lines.push('5. If fixtures exist, prefer them over manually instantiating page objects.')

  return lines.join('\n')
}
