/**
 * AST-based static audit for a class of locator bug regex genuinely cannot
 * catch: `expect(<multi-match locator>).toBeVisible()` (or any other
 * single-element assertion) throws "strict mode violation" at RUNTIME –
 * verified directly against a live site during development – but detecting
 * it statically requires tracking a VARIABLE across multiple lines:
 *
 *   const cards = page.locator('.card')   // declared here
 *   ...
 *   await expect(cards).toBeVisible()      // misused several lines later
 *
 * A regex has no notion of "this identifier was bound to that expression
 * three lines up." A real AST does. This module parses generated code with
 * the TypeScript compiler's parser (structural only – no type-checker, no
 * Program/tsconfig needed, so it's cheap) and does a small, purpose-built
 * dataflow pass: track which local variables hold a raw (unfiltered)
 * collection locator, then flag any single-element assertion applied to one.
 *
 * `typescript` is dynamically imported so it is not part of the app's
 * initial bundle – it is only pulled in (as its own chunk) when automation is
 * actually generated.
 */

export interface LocatorAuditViolation {
  line: number // 1-based
  message: string
}

// Loaded once and cached. This audit is an optional safety net on top of the
// other, non-AST checks (spec/page-object drift, invented locators, route
// verification) – if the ~9MB compiler chunk fails to load (a dev-server
// hiccup, an extension blocking it, a flaky network), the right behavior is
// to skip this one pass, not to fail the entire automation build over a
// linting check.
let tsModulePromise: Promise<typeof import('typescript') | null> | null = null

function loadTypeScript(): Promise<typeof import('typescript') | null> {
  if (!tsModulePromise) {
    tsModulePromise = import('typescript').catch(err => {
      console.warn('AST locator audit unavailable – could not load the TypeScript compiler; skipping this pass.', err)
      return null
    })
  }
  return tsModulePromise
}

// Assertions that require the locator to resolve to EXACTLY one element.
// toHaveText/toHaveClass/toHaveAttribute are deliberately excluded here: they
// have a valid multi-element form (an array argument, checked pairwise) – see
// isSingleElementCall below, which inspects the actual argument shape.
const SINGLE_ELEMENT_ASSERTIONS = new Set([
  'toBeVisible', 'toBeHidden', 'toBeChecked', 'toBeDisabled', 'toBeEnabled',
  'toBeEditable', 'toBeFocused', 'toBeEmpty', 'toBeInViewport',
  'toHaveValue', 'toHaveId', 'toHaveCSS', 'toHaveJSProperty'
])
// These accept EITHER a single value (single-element) or an array (valid
// multi-element form, checked pairwise) – only flag the single-value form.
const CONDITIONAL_ASSERTIONS = new Set(['toHaveText', 'toHaveClass', 'toHaveAttribute'])
// A locator call chained after any of these is narrowed to (at most) one
// element and is always safe.
const NARROWING_CALLS = new Set(['filter', 'first', 'nth', 'last', 'and', 'or'])

/**
 * Scans method bodies for ones that are KNOWN to return a raw, unfiltered
 * collection locator – e.g. `getCards() { return this.page.locator('.card') }`
 * – so calls to `sweets.getCards()` in a spec can be tracked the same way as
 * a local `page.locator('.card')` variable.
 */
async function findRawCollectionMethods(
  methods: { name: string; code: string }[],
  itemSelectors: Set<string>
): Promise<Set<string>> {
  const raw = new Set<string>()
  // Nothing to check against, or nothing to check – skip loading the compiler
  // entirely. This is the overwhelmingly common case (most runs have no
  // grounded collections), so it also keeps the heavy chunk out of the vast
  // majority of automation generations.
  if (methods.length === 0 || itemSelectors.size === 0) return raw

  const ts = await loadTypeScript()
  if (!ts) return raw

  for (const method of methods) {
    // Methods are authored as class-member bodies ("name(args) { ... }"),
    // not standalone statements – wrap in a throwaway class to parse them.
    const source = ts.createSourceFile('m.ts', `class X { ${method.code} }`, ts.ScriptTarget.Latest, true)
    let isRawReturn = false

    const visit = (node: import('typescript').Node) => {
      if (ts.isReturnStatement(node) && node.expression) {
        if (isUnfilteredCollectionExpr(ts, node.expression, itemSelectors)) isRawReturn = true
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    if (isRawReturn) raw.add(method.name)
  }
  return raw
}

// True for `page.locator('<selector>')` / `this.page.locator('<selector>')`
// where selector is a known collection item selector AND nothing narrows it
// (no .filter/.first/.nth/.last/.and/.or anywhere in the chain).
function isUnfilteredCollectionExpr(
  ts: typeof import('typescript'),
  node: import('typescript').Node,
  itemSelectors: Set<string>
): boolean {
  if (!ts.isCallExpression(node)) return false
  if (!ts.isPropertyAccessExpression(node.expression)) return false
  const methodName = node.expression.name.text
  if (methodName !== 'locator') return false

  const arg = node.arguments[0]
  if (!arg || !ts.isStringLiteralLike(arg)) return false
  return itemSelectors.has(arg.text)
}

// Walk a call chain (`x.locator(...).filter(...).first()` etc.) and return
// true if it resolves a KNOWN raw collection with no narrowing anywhere.
function resolvesToRawCollection(
  ts: typeof import('typescript'),
  node: import('typescript').Expression,
  itemSelectors: Set<string>,
  rawCollectionMethods: Set<string>
): boolean {
  if (isUnfilteredCollectionExpr(ts, node, itemSelectors)) return true

  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const methodName = node.expression.name.text
    // A known collection-returning page-object method call, e.g. sweets.getCards().
    if (rawCollectionMethods.has(methodName)) return true
    // A narrowing call always makes the result safe, regardless of the base.
    if (NARROWING_CALLS.has(methodName)) return false
    // Otherwise recurse into the base expression (e.g. chained .locator()).
    return resolvesToRawCollection(ts, node.expression.expression, itemSelectors, rawCollectionMethods)
  }
  return false
}

function isSingleElementCall(name: string, args: readonly import('typescript').Expression[], ts: typeof import('typescript')): boolean {
  if (SINGLE_ELEMENT_ASSERTIONS.has(name)) return true
  if (CONDITIONAL_ASSERTIONS.has(name)) {
    const first = args[0]
    return !!first && !ts.isArrayLiteralExpression(first)
  }
  return false
}

/**
 * Audits a spec (or method) file's code for `expect(<multi-match>).<single-
 * element assertion>()`. `itemSelectors` are the app's known collection item
 * selectors (e.g. '.card'); `rawCollectionMethods` are page-object method
 * names already proven (via findRawCollectionMethods) to return one of those,
 * unfiltered.
 */
export async function auditLocatorCardinality(
  code: string,
  itemSelectors: Set<string>,
  rawCollectionMethods: Set<string> = new Set()
): Promise<LocatorAuditViolation[]> {
  if (itemSelectors.size === 0) return [] // nothing to check against
  const ts = await loadTypeScript()
  if (!ts) return []
  const source = ts.createSourceFile('spec.ts', code, ts.ScriptTarget.Latest, true)
  const violations: LocatorAuditViolation[] = []

  // Track local variables bound to a raw (unfiltered) collection expression.
  const rawVars = new Set<string>()

  const lineOf = (node: import('typescript').Node) =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1

  const visit = (node: import('typescript').Node) => {
    // const cards = page.locator('.card')  OR  const cards = sweets.getCards()
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
      if (resolvesToRawCollection(ts, node.initializer, itemSelectors, rawCollectionMethods)) {
        rawVars.add(node.name.text)
      }
    }

    // expect(<arg>).<assertion>(...)
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isCallExpression(node.expression.expression) &&
      ts.isIdentifier(node.expression.expression.expression) &&
      node.expression.expression.expression.text === 'expect'
    ) {
      const assertionName = node.expression.name.text
      const arg = node.expression.expression.arguments[0]
      if (arg && isSingleElementCall(assertionName, node.arguments, ts)) {
        const isRaw =
          (ts.isIdentifier(arg) && rawVars.has(arg.text)) ||
          resolvesToRawCollection(ts, arg, itemSelectors, rawCollectionMethods)
        if (isRaw) {
          violations.push({
            line: lineOf(node),
            message: `expect(...).${assertionName}() on a collection locator that matches MULTIPLE elements – Playwright throws "strict mode violation" at runtime. Use toHaveCount(), iterate with .all(), or narrow with .filter()/.first() first.`
          })
        }
      }
    }

    ts.forEachChild(node, visit)
  }
  visit(source)
  return violations
}

export { findRawCollectionMethods }
