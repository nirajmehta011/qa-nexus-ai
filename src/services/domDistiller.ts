import axios from 'axios'

// Distills an uploaded/fetched HTML snapshot into a compact map of
// interactive elements with the best available Playwright selector for
// each – so the LLM writes locators for elements that actually exist
// instead of guessing.

// `import.meta.env` is undefined under plain Node, and the grounding CLI imports
// this module to reuse distillCandidates/detectCollections — so read it defensively.
const API_BASE = (import.meta as any).env?.VITE_API_URL || (typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') ? 'http://localhost:3001/api' : '/api')

export interface ElementEntry {
  /** Playwright locator expression, e.g. page.getByTestId('save-btn') */
  selector: string
  tag: string
  /** Human-readable identity: visible text, label, placeholder or name */
  label: string
  kind: 'button' | 'link' | 'input' | 'select' | 'textarea' | 'checkbox' | 'radio' | 'other'
  /** Which app page/screen this came from (for POM page-object grouping) */
  page?: string
}

/** One addressable field inside a repeating item, relative to the item root. */
export interface CollectionField {
  name: string
  /** CSS selector relative to the item root, e.g. '.card-title' */
  selector: string
  kind: ElementEntry['kind']
}

/**
 * A repeating sibling structure (product grid, results list, table rows).
 * Interactive-element extraction alone misses these entirely – the item roots
 * are usually plain <div>s with no role – yet they're what most test cases
 * actually operate on.
 */
export interface CollectionEntry {
  /** camelCase identity derived from the item class, e.g. 'card' */
  name: string
  /** Selector matching EVERY item, e.g. '.card' */
  itemSelector: string
  count: number
  fields: CollectionField[]
  page?: string
  /**
   * Set by the grounding CLI when two page loads returned the same items in a
   * different order. Any index-based locator on this collection would be
   * intermittently wrong.
   */
  nondeterministicOrder?: boolean
}

const MAX_ELEMENTS = 150
// Below this count, a repeating structure is probably coincidence, not a list.
const MIN_REPEAT = 3
const MAX_FIELDS_PER_ITEM = 10
// Below this count, a snapshot is probably a pre-render shell, not the live DOM.
export const THIN_SNAPSHOT_THRESHOLD = 3

const escapeQuotes = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
const clean = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim()

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

// NOTE: labels deliberately use full `textContent`, NOT the element's own text.
// Playwright computes an accessible name from the whole subtree, so
// <a><h4>Name</h4><p>Desc</p></a> really is named "Name Desc" – trimming to the
// own text here would break every getByRole(...{ name }) we emit. The
// "merged sibling text" defect belongs to generated ASSERTIONS, not to
// selectors, and is handled by a prompt rule (and, properly, a live DOM check).

const INTERACTIVE_SELECTOR = [
  // NOTE: bare `a`, not `a[href]`. Anchors without href are extremely common as
  // JS-driven buttons (<a class="addItem" data-name="...">). Restricting to
  // a[href] meant the primary action on a whole product grid was never grounded.
  'button', 'a', 'input', 'select', 'textarea',
  '[role=button]', '[role=link]', '[role=combobox]', '[role=checkbox]',
  '[role=tab]', '[role=menuitem]', '[role=switch]', '[role=radio]',
  '[data-testid]', '[data-test-id]', '[data-test]', '[data-cy]',
  // Stable app-authored hooks on non-semantic markup (legacy / Bootstrap apps).
  '[data-id]', '[data-name]', '[data-qa]', '[data-action]',
  '[onclick]', '[contenteditable=true]', 'summary',
  '[tabindex]:not([tabindex="-1"])'
].join(', ')

// data-* hooks that identify an element. Framework/runtime noise is excluded –
// those change between builds and would produce brittle selectors.
const STABLE_DATA_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-qa', 'data-id', 'data-name', 'data-action']

// Utility/layout classes carry no identity – never build a selector from them.
const UTILITY_CLASS_RE = /^(btn|col|row|container|d|m[tbxylr]?|p[tbxylr]?|text|bg|border|flex|grid|w|h|justify|items|align|float|clearfix|sr|visually|active|show|fade|collapse|py|px|my|mx)(-.*)?$/

function stableClass(el: Element): string | null {
  const classes = (el.getAttribute('class') || '').split(/\s+/).filter(Boolean)
  const candidate = classes.find(c => !UTILITY_CLASS_RE.test(c) && c.length > 2 && !/\d{3,}|^css-|^sc-/.test(c))
  return candidate || null
}

function classify(el: Element): ElementEntry['kind'] {
  const tag = el.tagName.toLowerCase()
  const type = (el.getAttribute('type') || '').toLowerCase()
  const role = (el.getAttribute('role') || '').toLowerCase()
  if (tag === 'button' || type === 'button' || type === 'submit' || role === 'button') return 'button'
  if (role === 'link') return 'link'
  // Per ARIA, an <a> WITHOUT href has no implicit role – browsers expose no
  // role at all, so getByRole('link'|'button') matches zero elements. Treat it
  // as a generic element so a text/class selector is used instead.
  if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'other'
  if (tag === 'select' || role === 'combobox' || role === 'listbox') return 'select'
  if (tag === 'textarea' || el.getAttribute('contenteditable') === 'true') return 'textarea'
  if (type === 'checkbox' || role === 'checkbox' || role === 'switch') return 'checkbox'
  if (type === 'radio' || role === 'radio') return 'radio'
  if (tag === 'input') return 'input'
  return 'other'
}

// Builds id -> label text from both association patterns:
// <label for="id">Text</label>  AND  <label>Text <input></label>
function buildLabelMap(doc: Document): Map<string, string> {
  const map = new Map<string, string>()
  for (const label of Array.from(doc.querySelectorAll('label'))) {
    // 3 === Node.TEXT_NODE. Use the literal: the `Node` global doesn't exist
    // under plain Node.js, where the grounding CLI imports this module.
    const text = clean(Array.from(label.childNodes)
      .filter(n => n.nodeType === 3)
      .map(n => n.textContent)
      .join(' ')) || clean(label.textContent).slice(0, 60)
    if (!text) continue

    const forId = label.getAttribute('for')
    if (forId) {
      map.set(forId, text)
      continue
    }
    // Implicit label: the control is nested inside the <label>
    const nested = label.querySelector('input, select, textarea')
    if (nested?.id) map.set(nested.id, text)
  }
  return map
}

/**
 * Every selector we would accept for this element, most-preferred first.
 *
 * Static parsing cannot know which of these a browser will actually resolve
 * (an <a> without href has no role; a class may match 4 nodes). The grounding
 * CLI walks this list against a live page and keeps the first that matches
 * exactly one element — which is why the ORDER matters and why we return all
 * of them rather than committing to one.
 *
 * Priority mirrors Playwright's recommendations, then degrades through
 * app-authored hooks: testid > id > label > aria-label > role+name > data
 * attributes > placeholder > name > text > stable class. Without the data
 * attribute and class tiers, a generator systematically fails on non-semantic
 * markup (most of the real world).
 */
export function selectorCandidates(
  el: Element,
  kind: ElementEntry['kind'],
  label: string,
  labelMap: Map<string, string>
): string[] {
  const out: string[] = []
  const push = (s: string) => { if (!out.includes(s)) out.push(s) }

  const testId = el.getAttribute('data-testid') || el.getAttribute('data-test-id') || el.getAttribute('data-test') || el.getAttribute('data-cy')
  if (testId) push(`page.getByTestId('${escapeQuotes(testId)}')`)

  const id = el.getAttribute('id')
  const idIsCssSafe = !!id && !/^\d|[^a-zA-Z0-9\-_:.]/.test(id)

  // <label for="id">/wrapping <label> – Playwright's top recommendation for forms
  const associatedLabel = id ? labelMap.get(id) : undefined
  if (associatedLabel && (kind === 'input' || kind === 'textarea' || kind === 'select' || kind === 'checkbox' || kind === 'radio')) {
    push(`page.getByLabel('${escapeQuotes(associatedLabel)}')`)
  }

  if (idIsCssSafe) push(`page.locator('#${escapeQuotes(id!)}')`)

  const ariaLabel = clean(el.getAttribute('aria-label'))
  if (ariaLabel) push(`page.getByLabel('${escapeQuotes(ariaLabel)}')`)

  if (label) {
    // A label that leads with a live counter ("0 Basket") pins the locator to
    // the zero state – the first add-to-basket breaks it. Match on the stable
    // part with a regex instead of an exact string.
    const counted = label.match(/^\d+\s+(.{2,40})$/)
    const name = counted ? `/${escapeRegex(counted[1])}/` : `'${escapeQuotes(label)}'`
    if (kind === 'button') push(`page.getByRole('button', { name: ${name} })`)
    if (kind === 'link') push(`page.getByRole('link', { name: ${name} })`)
  }

  // App-authored data hooks: stable across builds, and the only handle on
  // role-less markup like <a class="addItem" data-name="Bon Bons">.
  for (const attr of STABLE_DATA_ATTRS) {
    const value = el.getAttribute(attr)
    if (value) push(`page.locator('[${attr}="${escapeQuotes(value)}"]')`)
  }

  const placeholder = clean(el.getAttribute('placeholder'))
  if (placeholder) push(`page.getByPlaceholder('${escapeQuotes(placeholder)}')`)

  const nameAttr = el.getAttribute('name')
  if (nameAttr) push(`page.locator('${el.tagName.toLowerCase()}[name="${escapeQuotes(nameAttr)}"]')`)

  if (label && label.length <= 60) push(`page.getByText('${escapeQuotes(label)}', { exact: true })`)

  // Last resort before giving up: a non-utility class scoped to the tag.
  const cls = stableClass(el)
  if (cls) push(`page.locator('${el.tagName.toLowerCase()}.${escapeQuotes(cls)}')`)

  return out
}

function bestSelector(el: Element, kind: ElementEntry['kind'], label: string, labelMap: Map<string, string>): string | null {
  return selectorCandidates(el, kind, label, labelMap)[0] ?? null
}

// Combines elements from multiple uploaded snapshots (e.g. login page +
// dashboard page) into one map. Later entries win on selector collisions,
// so re-uploading a corrected snapshot for the same page updates it.
export function mergeElements(existing: ElementEntry[], incoming: ElementEntry[]): ElementEntry[] {
  const map = new Map<string, ElementEntry>()
  for (const e of existing) map.set(e.selector, e)
  for (const e of incoming) map.set(e.selector, e)
  return [...map.values()]
}

// Excludes targets that aren't real interactive elements a test could touch:
// hidden inputs/fields, anything explicitly hidden or aria-hidden, and
// disabled controls. A grounded selector for something the user can't
// actually click/fill is worse than no selector at all.
function isInteractable(el: Element): boolean {
  if (el.getAttribute('type') === 'hidden') return false
  if (el.hasAttribute('hidden')) return false
  if (el.getAttribute('aria-hidden') === 'true') return false
  if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') return false
  const style = (el.getAttribute('style') || '').toLowerCase().replace(/\s+/g, '')
  if (style.includes('display:none') || style.includes('visibility:hidden')) return false
  return true
}

export function distillHtml(html: string, page?: string): ElementEntry[] {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const labelMap = buildLabelMap(doc)
  const candidates = doc.querySelectorAll(INTERACTIVE_SELECTOR)

  const entries: ElementEntry[] = []
  // Tracks how many times each base selector has already been produced, so
  // duplicate matches (e.g. an "Edit" button repeated in every table row)
  // get a disambiguating .nth(N) instead of silently collapsing into one
  // grounded entry that would actually match many elements at runtime.
  const occurrences = new Map<string, number>()

  for (const el of Array.from(candidates)) {
    if (entries.length >= MAX_ELEMENTS) break
    if (!isInteractable(el)) continue

    const kind = classify(el)
    const textLabel = clean(el.textContent).slice(0, 60)
    const id = el.getAttribute('id')
    const associatedLabel = id ? labelMap.get(id) : undefined
    const label =
      associatedLabel ||
      clean(el.getAttribute('aria-label')) ||
      clean(kind === 'input' || kind === 'textarea' || kind === 'select' ? el.getAttribute('placeholder') : '') ||
      textLabel ||
      clean(el.getAttribute('name')) ||
      clean(id)
    const baseSelector = bestSelector(el, kind, textLabel, labelMap)
    if (!baseSelector) continue

    const priorCount = occurrences.get(baseSelector) ?? 0
    occurrences.set(baseSelector, priorCount + 1)
    const selector = priorCount === 0 ? baseSelector : `${baseSelector}.nth(${priorCount})`
    const finalLabel = priorCount === 0 ? (label || '(unlabelled)') : `${label || '(unlabelled)'} (${priorCount + 1})`

    entries.push({ selector, tag: el.tagName.toLowerCase(), label: finalLabel, kind, page })
  }
  return entries
}

/** An element plus every selector we'd accept for it, for live verification. */
export interface CandidateEntry {
  tag: string
  label: string
  kind: ElementEntry['kind']
  page?: string
  /** Ordered, most-preferred first. */
  candidates: string[]
}

/**
 * Same traversal as distillHtml, but returns every candidate selector instead of
 * committing to the first. The grounding CLI resolves these against a live page
 * (`locator.count() === 1`); the browser, not our heuristics, picks the winner.
 */
export function distillCandidates(html: string, page?: string): CandidateEntry[] {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const labelMap = buildLabelMap(doc)
  const out: CandidateEntry[] = []

  for (const el of Array.from(doc.querySelectorAll(INTERACTIVE_SELECTOR))) {
    if (out.length >= MAX_ELEMENTS) break
    if (!isInteractable(el)) continue
    const kind = classify(el)
    const textLabel = clean(el.textContent).slice(0, 60)
    const id = el.getAttribute('id')
    const label =
      (id ? labelMap.get(id) : undefined) ||
      clean(el.getAttribute('aria-label')) ||
      clean(kind === 'input' || kind === 'textarea' || kind === 'select' ? el.getAttribute('placeholder') : '') ||
      textLabel ||
      clean(el.getAttribute('name')) ||
      clean(id)
    const candidates = selectorCandidates(el, kind, textLabel, labelMap)
    if (candidates.length === 0) continue
    out.push({ tag: el.tagName.toLowerCase(), label: label || '(unlabelled)', kind, page, candidates })
  }
  return out
}

// ── Repeating structures (product grids, result lists, table rows) ────────────

// '.card-title' -> cardTitle, '.addItem' -> addItem (internal caps preserved:
// lowercasing the whole first word turned `addItem` into `additem`).
const camelFromSelector = (sel: string): string => {
  const words = sel.replace(/[^a-zA-Z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return 'field'
  const [first, ...rest] = words
  return first.charAt(0).toLowerCase() + first.slice(1) +
    rest.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('')
}

// Addressable descendants of a single representative item, as selectors
// RELATIVE to the item root (so they compose: item.locator('.card-title')).
function collectionFields(item: Element): CollectionField[] {
  const fields: CollectionField[] = []
  const seen = new Set<string>()
  for (const el of Array.from(item.querySelectorAll('*'))) {
    const tag = el.tagName.toLowerCase()
    const dataAttr = STABLE_DATA_ATTRS.find(a => el.hasAttribute(a))
    const cls = stableClass(el)
    let selector: string | null = null
    if (cls) selector = `.${cls}`
    else if (dataAttr) selector = `[${dataAttr}]`
    // A bare tag is only usable when it is unique inside the item – an item with
    // two <a>s would otherwise burn a field slot on an ambiguous selector.
    else if (/^h[1-6]$/.test(tag) && item.querySelectorAll(tag).length === 1) selector = tag
    // The item's ACTION (an "Add to basket" button) is the whole point of the
    // collection, but its classes are often pure utility (`btn btn-primary`).
    else if (classify(el) !== 'other' && item.querySelectorAll(tag).length === 1) selector = tag
    // Classless table cells (<td>) or list children have no identity at all
    // except POSITION – common in plain <table>/<tbody><tr> markup with no
    // framework classes anywhere. Address a direct child by its position
    // among its siblings (":nth-child" counts all siblings, so this is exact
    // even when every sibling shares the same tag).
    else if (el.parentElement === item) {
      const idx = Array.from(item.children).indexOf(el) + 1
      if (idx > 0) selector = `${tag}:nth-child(${idx})`
    }
    if (!selector || seen.has(selector)) continue
    seen.add(selector)
    fields.push({ name: camelFromSelector(selector), selector, kind: classify(el) })
    if (fields.length >= MAX_FIELDS_PER_ITEM) break
  }
  return fields
}

/**
 * Detects repeating sibling structures and grounds them as a collection
 * locator + per-item sub-locators. Items are matched by a shared, non-utility
 * class (Bootstrap's `col-md-4` etc. carry no identity and are filtered out).
 *
 * Deliberately returns a *set* selector (`.card`), never an index — list order
 * is frequently randomised at runtime, so callers must address items by text
 * (`.filter({ hasText })`), not by `nth()`.
 */
// List/table markup often has NO class anywhere on the repeating item – a
// <tbody><tr> or a bare <ul><li> is already semantically a collection by tag.
// Build a selector from the nearest ANCESTOR that has an id/class (walking up
// at most two levels: parent, then grandparent), combined with the tag path
// down to the item. Returns null when nothing distinguishing exists nearby –
// same conservative "don't emit an unreliable selector" rule as bestSelector.
function structuralAnchor(item: Element): { selector: string; anchorWord: string } | null {
  const itemTag = item.tagName.toLowerCase()
  const parent = item.parentElement
  if (!parent) return null

  const idSelector = (el: Element): string | null =>
    el.id && /^[a-zA-Z][\w-]*$/.test(el.id) ? `#${el.id}` : null

  // id before class at each level: a class (e.g. "tablesorter") is often
  // shared by SEVERAL sibling tables/lists on the same page, which would
  // silently merge two distinct collections into one; id is unique by
  // construction. Same priority discipline as bestSelector().
  const parentId = idSelector(parent)
  const parentCls = stableClass(parent)
  if (parentId) return { selector: `${parentId} > ${itemTag}`, anchorWord: parent.id }
  if (parentCls) return { selector: `.${parentCls} > ${itemTag}`, anchorWord: parentCls }

  const grandparent = parent.parentElement
  if (grandparent) {
    const parentTag = parent.tagName.toLowerCase()
    const gpId = idSelector(grandparent)
    const gpCls = stableClass(grandparent)
    if (gpId) return { selector: `${gpId} ${parentTag} ${itemTag}`, anchorWord: grandparent.id }
    if (gpCls) return { selector: `.${gpCls} ${parentTag} ${itemTag}`, anchorWord: gpCls }
  }
  return null
}

export function detectCollections(html: string, page?: string): CollectionEntry[] {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const byKey = new Map<string, Element[]>()

  for (const el of Array.from(doc.querySelectorAll('*'))) {
    const cls = stableClass(el)
    if (!cls) continue
    const key = `${el.tagName.toLowerCase()}.${cls}`
    byKey.set(key, [...(byKey.get(key) || []), el])
  }

  const staged: (CollectionEntry & { onlyChildSelector: string | null })[] = []

  // Structural pass: classless <tr> (outside <thead> – a header row isn't a
  // data item) and <li>, grouped by their exact parent element. Skipped for
  // anything the class-based pass above will already catch.
  const structuralGroups = new Map<Element, Element[]>()
  for (const tag of ['tr', 'li']) {
    for (const el of Array.from(doc.querySelectorAll(tag))) {
      if (stableClass(el)) continue
      if (tag === 'tr' && el.closest('thead')) continue
      const parent = el.parentElement
      if (!parent) continue
      structuralGroups.set(parent, [...(structuralGroups.get(parent) || []), el])
    }
  }
  for (const items of structuralGroups.values()) {
    if (items.length < MIN_REPEAT) continue
    const anchor = structuralAnchor(items[0])
    if (!anchor) continue
    const fields = collectionFields(items[0])
    // Unlike the class-based pass below, a zero-field item here is still kept:
    // a leaf <li>Home</li> with no nested elements has nothing to sub-select,
    // but the item itself is still a real, useful target – e.g.
    // `.filter({ hasText: 'Home' })` – so dropping it would throw away a
    // perfectly good collection just because it has no children.
    staged.push({
      name: `${camelFromSelector(anchor.anchorWord)}${items[0].tagName.toLowerCase() === 'tr' ? 'Row' : 'Item'}`,
      itemSelector: anchor.selector,
      count: items.length,
      fields,
      page,
      onlyChildSelector: null
    })
  }

  for (const [key, els] of byKey) {
    if (els.length < MIN_REPEAT) continue
    // A real list is structurally uniform. Requiring one shared parent (or
    // grandparent) is too strict: a 16-card grid is routinely split across
    // several <div class="row"> containers, each card in an identical
    // utility-class wrapper. What actually identifies a collection is that
    // every item sits in an IDENTICALLY-SHAPED parent. Incidental class reuse
    // across unrelated parts of the page fails that test.
    const parents = new Set(els.map(e => e.parentElement))
    const parentShapes = new Set(els.map(e => shapeOf(e.parentElement)))
    const grandparentShapes = new Set(els.map(e => shapeOf(e.parentElement?.parentElement ?? null)))
    if (parents.size > 1 && parentShapes.size > 1 && grandparentShapes.size > 1) continue

    const itemSelector = `.${key.split('.').slice(1).join('.')}`
    const fields = collectionFields(els[0])
    if (fields.length === 0) continue

    staged.push({
      name: camelFromSelector(itemSelector),
      itemSelector,
      count: els.length,
      fields,
      page,
      onlyChildSelector: soleChildSelector(els[0])
    })
  }

  // 1. Drop layout wrappers: `<div class="col-lg-3 cards"><div class="card">` –
  //    a wrapper's item has exactly ONE element child, and that child is the
  //    real item. (Comparing field lists instead would misfire, because a card
  //    legitimately "contains" .card-body.)
  const wrappers = new Set(
    staged
      .filter(a => a.onlyChildSelector && staged.some(b => b !== a && b.itemSelector === a.onlyChildSelector && b.count === a.count))
      .map(a => a.itemSelector)
  )
  const items = staged.filter(c => !wrappers.has(c.itemSelector))

  // 2. Drop sub-parts: `.card-body`/`.card-title` repeat uniformly too, but they
  //    are fields OF `.card`, not collections in their own right.
  const subParts = new Set(
    items.filter(b => items.some(a => a !== b && a.fields.some(f => f.selector === b.itemSelector))).map(b => b.itemSelector)
  )

  // Richest structures first – a card grid before a nav list.
  return items
    .filter(c => !subParts.has(c.itemSelector))
    .map(({ onlyChildSelector, ...c }) => c)
    .sort((a, b) => b.fields.length - a.fields.length)
    .slice(0, 5)
}

/** Tag + class signature, for deciding whether two parents are "the same shape". */
const shapeOf = (el: Element | null): string =>
  el ? `${el.tagName.toLowerCase()}.${(el.getAttribute('class') || '').trim()}` : ''

/** If an element wraps exactly one element child, that child's selector. */
function soleChildSelector(el: Element): string | null {
  if (el.children.length !== 1) return null
  const cls = stableClass(el.children[0])
  return cls ? `.${cls}` : null
}

// Dedupe collections by item selector + page; a later snapshot wins.
export function mergeCollections(existing: CollectionEntry[], incoming: CollectionEntry[]): CollectionEntry[] {
  const byKey = new Map(existing.map(c => [`${c.page || ''}|${c.itemSelector}`, c]))
  for (const c of incoming) byKey.set(`${c.page || ''}|${c.itemSelector}`, c)
  return [...byKey.values()]
}

export interface UrlFetchResult {
  elements: ElementEntry[]
  collections: CollectionEntry[]
  /** True when the fetch likely captured a JS-app's pre-render shell, not the live DOM. */
  thin: boolean
}

// Fetches a page server-side (via the existing SSRF-protected /api/fetch-url
// proxy) and distills it. Reliable for server-rendered/static pages; for
// heavy client-rendered SPAs the initial HTML is often a near-empty shell –
// callers should surface `thin` so the user knows to use Copy-outerHTML instead.
export async function fetchAndDistillUrl(url: string, page?: string): Promise<UrlFetchResult> {
  const response = await axios.post(`${API_BASE}/fetch-url`, { url })
  const html = response.data.html
  if (!html || !html.trim()) throw new Error('The URL returned no content.')
  const elements = distillHtml(html, page)
  const collections = detectCollections(html, page)
  return { elements, collections, thin: elements.length < THIN_SNAPSHOT_THRESHOLD }
}
