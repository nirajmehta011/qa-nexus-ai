import type { CandidateEntry, CollectionEntry, ElementEntry } from './domDistiller'

/**
 * Live-verified grounding. Static parsing produces *candidate* selectors; only a
 * real browser can say which one resolves, and to how many nodes. This module
 * holds the decision logic, decoupled from Playwright so it is unit-testable:
 * the caller supplies a `count(selector)` probe.
 *
 * The single rule — "accept the first candidate that matches exactly one node" —
 * is what fixes the ARIA class of defects at the root. `getByRole('link', …)`
 * on an <a> without href counts 0, so it is rejected and the next tier
 * (`[data-name="…"]`) wins. No special-casing required.
 */

/** Counts how many nodes a Playwright locator expression resolves to. */
export type CountProbe = (selectorExpression: string) => Promise<number>

/**
 * A locator expression, decoded into structured intent.
 *
 * SECURITY: candidate expressions embed page-derived content (class names,
 * data-* values, visible text). They must NEVER be evaluated as code — a
 * malicious page could otherwise achieve RCE on the machine running the
 * grounding CLI. Instead we parse the small, closed set of shapes our own
 * distiller emits and reject everything else, so the caller can rebuild the
 * locator through the Playwright API with the values passed as *data*.
 */
export type LocatorIntent =
  | { kind: 'testId'; value: string }
  | { kind: 'label'; value: string }
  | { kind: 'placeholder'; value: string }
  | { kind: 'text'; value: string; exact: true }
  | { kind: 'role'; role: 'button' | 'link'; name: string }
  | { kind: 'roleRegex'; role: 'button' | 'link'; pattern: string }
  | { kind: 'css'; selector: string }

// A single-quoted JS string body: no bare quote/backslash, escapes allowed.
const STR = String.raw`(?:[^'\\]|\\.)*`
const unescape = (s: string) => s.replace(/\\(.)/g, '$1')

const PATTERNS: { re: RegExp; build: (m: RegExpMatchArray) => LocatorIntent }[] = [
  { re: new RegExp(`^page\\.getByTestId\\('(${STR})'\\)$`), build: m => ({ kind: 'testId', value: unescape(m[1]) }) },
  { re: new RegExp(`^page\\.getByLabel\\('(${STR})'\\)$`), build: m => ({ kind: 'label', value: unescape(m[1]) }) },
  { re: new RegExp(`^page\\.getByPlaceholder\\('(${STR})'\\)$`), build: m => ({ kind: 'placeholder', value: unescape(m[1]) }) },
  {
    re: new RegExp(`^page\\.getByText\\('(${STR})', \\{ exact: true \\}\\)$`),
    build: m => ({ kind: 'text', value: unescape(m[1]), exact: true })
  },
  {
    re: new RegExp(`^page\\.getByRole\\('(button|link)', \\{ name: '(${STR})' \\}\\)$`),
    build: m => ({ kind: 'role', role: m[1] as 'button' | 'link', name: unescape(m[2]) })
  },
  {
    re: new RegExp(`^page\\.getByRole\\('(button|link)', \\{ name: /(.+)/ \\}\\)$`),
    build: m => ({ kind: 'roleRegex', role: m[1] as 'button' | 'link', pattern: m[2] })
  },
  { re: new RegExp(`^page\\.locator\\('(${STR})'\\)$`), build: m => ({ kind: 'css', selector: unescape(m[1]) }) }
]

/** Returns null for anything outside the known-safe grammar. */
export function parseLocatorExpression(expression: string): LocatorIntent | null {
  const trimmed = expression.trim()
  for (const { re, build } of PATTERNS) {
    const match = trimmed.match(re)
    if (match) return build(match)
  }
  return null
}

export interface ResolvedElement extends ElementEntry {
  /** Always 1 – recorded so the app can show grounding as verified, not inferred. */
  verifiedCount: number
}

export interface UnresolvedElement {
  label: string
  kind: ElementEntry['kind']
  tried: string[]
  reason: string
}

export interface ResolveResult {
  elements: ResolvedElement[]
  unresolved: UnresolvedElement[]
}

/**
 * Walk an element's candidates in priority order and keep the first that
 * matches EXACTLY one node.
 *
 * A candidate matching 0 nodes is wrong (bad role/name). A candidate matching
 * many is ambiguous — we deliberately do NOT disambiguate with `.nth(i)`,
 * because list order is frequently randomised at runtime and an index-based
 * locator produces intermittently-failing tests, which are worse than loudly
 * missing ones.
 */
export async function resolveElement(
  entry: CandidateEntry,
  count: CountProbe
): Promise<{ selector: string; verifiedCount: number } | { reason: string }> {
  let sawAmbiguous = false
  for (const candidate of entry.candidates) {
    let n: number
    try {
      n = await count(candidate)
    } catch {
      continue // invalid expression for this page – try the next tier
    }
    if (n === 1) return { selector: candidate, verifiedCount: 1 }
    if (n > 1) sawAmbiguous = true
  }
  return {
    reason: sawAmbiguous
      ? 'every candidate matched multiple elements (ambiguous; refusing to use a positional .nth() locator)'
      : 'no candidate matched any element on the live page'
  }
}

export async function resolveElements(entries: CandidateEntry[], count: CountProbe): Promise<ResolveResult> {
  const elements: ResolvedElement[] = []
  const unresolved: UnresolvedElement[] = []

  for (const entry of entries) {
    const result = await resolveElement(entry, count)
    if ('selector' in result) {
      elements.push({
        selector: result.selector,
        tag: entry.tag,
        label: entry.label,
        kind: entry.kind,
        page: entry.page,
        verifiedCount: result.verifiedCount
      })
    } else {
      unresolved.push({ label: entry.label, kind: entry.kind, tried: entry.candidates, reason: result.reason })
    }
  }
  return { elements, unresolved }
}

/**
 * Structured probes for collections. Deliberately NOT expression strings: the
 * caller builds real locators from these CSS selectors via the Playwright API,
 * so nothing derived from page content is ever evaluated as code.
 */
export interface CollectionProbe {
  countItems: (itemSelector: string) => Promise<number>
  countFieldInFirstItem: (itemSelector: string, fieldSelector: string) => Promise<number>
}

/**
 * A collection is real if its item selector still repeats on the live page
 * (>= 2), and we keep only the fields that actually resolve within one item.
 */
export async function resolveCollection(
  collection: CollectionEntry,
  probe: CollectionProbe
): Promise<CollectionEntry | null> {
  const items = await probe.countItems(collection.itemSelector).catch(() => 0)
  if (items < 2) return null

  const fields: CollectionEntry['fields'] = []
  for (const field of collection.fields) {
    const n = await probe.countFieldInFirstItem(collection.itemSelector, field.selector).catch(() => 0)
    if (n === 1) fields.push(field)
  }
  if (fields.length === 0) return null
  return { ...collection, count: items, fields }
}

/**
 * Two reads of the same collection's item texts. If the order differs, the page
 * shuffles its list at runtime (e.g. a "randomise best sellers" script) and any
 * index-based locator would be intermittently wrong.
 */
export function isOrderNonDeterministic(firstPass: string[], secondPass: string[]): boolean {
  if (firstPass.length !== secondPass.length || firstPass.length < 2) return false
  const sameOrder = firstPass.every((text, i) => text === secondPass[i])
  if (sameOrder) return false
  // Only call it non-deterministic if it's a genuine reshuffle of the same set,
  // not a content change (which would be a different page, not a shuffle).
  const a = [...firstPass].sort()
  const b = [...secondPass].sort()
  return a.every((text, i) => text === b[i])
}
