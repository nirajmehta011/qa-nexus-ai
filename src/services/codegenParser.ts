// Parses a Playwright codegen script (npx playwright codegen output) into
// the recorded locators and actions – ground truth selectors for the flows
// the user actually recorded.

export interface RecordedAction {
  /** Full locator expression as recorded, e.g. page.getByRole('button', { name: 'Log in' }) */
  locator: string
  action: string
  value?: string
  /** Which app page/screen this action happened on (segmented by goto() calls) */
  page?: string
}

// Matches page.<locatorMethod>(...).<action>(args?) including chained
// locators like page.getByRole(...).filter(...).click()
const ACTION_RE = /(page\s*\.\s*(?:getBy\w+|locator|frameLocator)\s*\((?:[^()]|\([^()]*\))*\)(?:\s*\.\s*(?:filter|first|last|nth)\s*\((?:[^()]|\([^()]*\))*\))*)\s*\.\s*(click|dblclick|fill|type|press|check|uncheck|selectOption|setInputFiles|hover|focus|dragTo|tap|selectText|setChecked)\s*\(([^;]*?)\)\s*;?/g

const GOTO_RE = /page\s*\.\s*goto\s*\(\s*['"`]([^'"`]+)['"`]/g

export interface CodegenParseResult {
  actions: RecordedAction[]
  urls: string[]
}

export function derivePageName(url: string): string {
  try {
    const parsed = new URL(url)
    const path = parsed.pathname.replace(/\/+$/, '')
    if (!path || path === '') return 'Home'
    const last = path.split('/').filter(Boolean).pop() || 'Home'
    return last.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
  } catch {
    return 'App'
  }
}

export function parseCodegenScript(source: string, defaultPage?: string): CodegenParseResult {
  // First, find goto() calls with their position so we can segment actions
  // into the page they happened on (codegen inserts a fresh goto per navigation).
  const gotoBoundaries: { index: number; url: string }[] = []
  let gotoMatch: RegExpExecArray | null
  const gotoRe = new RegExp(GOTO_RE)
  while ((gotoMatch = gotoRe.exec(source)) !== null) {
    gotoBoundaries.push({ index: gotoMatch.index, url: gotoMatch[1] })
  }

  const pageForIndex = (index: number): string => {
    let current = defaultPage || 'App'
    for (const b of gotoBoundaries) {
      if (b.index <= index) current = derivePageName(b.url)
      else break
    }
    return current
  }

  const actions: RecordedAction[] = []
  const seen = new Set<string>()

  let match: RegExpExecArray | null
  const actionRe = new RegExp(ACTION_RE)
  while ((match = actionRe.exec(source)) !== null) {
    const locator = match[1].replace(/\s+/g, ' ').trim()
    const action = match[2]
    const rawArg = (match[3] || '').trim()
    const valueMatch = rawArg.match(/^['"`](.*)['"`]$/s)
    const page = pageForIndex(match.index)
    const key = `${page}|${locator}|${action}|${rawArg}`
    if (seen.has(key)) continue
    seen.add(key)
    actions.push({
      locator,
      action,
      page,
      ...(valueMatch ? { value: valueMatch[1] } : {})
    })
  }

  const urls: string[] = []
  for (const b of gotoBoundaries) {
    if (!urls.includes(b.url)) urls.push(b.url)
  }

  return { actions, urls }
}

/** Unique locators from a recording (for the selector allow-list). */
export function recordedLocators(result: CodegenParseResult): string[] {
  return [...new Set(result.actions.map(a => a.locator))]
}

// Combines actions from multiple recorded sessions into one list, deduped.
export function mergeActions(existing: RecordedAction[], incoming: RecordedAction[]): RecordedAction[] {
  const key = (a: RecordedAction) => `${a.page ?? ''}|${a.locator}|${a.action}|${a.value ?? ''}`
  const map = new Map<string, RecordedAction>()
  for (const a of existing) map.set(key(a), a)
  for (const a of incoming) map.set(key(a), a)
  return [...map.values()]
}
