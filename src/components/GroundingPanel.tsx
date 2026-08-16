import { useRef, useState } from 'react'
import {
  distillHtml,
  detectCollections,
  fetchAndDistillUrl,
  mergeElements,
  mergeCollections,
  THIN_SNAPSHOT_THRESHOLD,
  type ElementEntry,
  type CollectionEntry
} from '../services/domDistiller'
import { derivePageName, mergeActions, parseCodegenScript } from '../services/codegenParser'
import type { AutomationContext } from '../services/automationBuilder'
import { extractErrorMessage } from '../services/errorUtils'
import { IconAlert, IconCheck, IconChevron, IconCode, IconLink, IconTrash } from './Icons'

// Selector grounding. Without this the model guesses selectors from prose and
// the suite fails on line 1; with it, every locator it writes was observed on a
// real page. Three ways in, all optional, all mergeable.

type Source = 'url' | 'html' | 'codegen'

const SOURCES: { id: Source; label: string; blurb: string }[] = [
  { id: 'url', label: 'Fetch URL', blurb: 'Best for server-rendered pages. Fetched through the proxy and distilled.' },
  { id: 'html', label: 'Paste DOM', blurb: 'Best for SPAs. DevTools → right-click <html> → Copy → Copy outerHTML.' },
  { id: 'codegen', label: 'Codegen script', blurb: 'Paste `npx playwright codegen` output — the selectors it recorded are ground truth.' }
]

export default function GroundingPanel({
  context,
  onContext,
  disabled
}: {
  context: AutomationContext
  onContext: (next: AutomationContext) => void
  disabled: boolean
}) {
  const [source, setSource] = useState<Source>('url')
  const [url, setUrl] = useState('')
  const [pageName, setPageName] = useState('')
  const [paste, setPaste] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [expanded, setExpanded] = useState(false)
  const htmlFileRef = useRef<HTMLInputElement>(null)

  const elements = context.elements || []
  const collections = context.collections || []
  const actions = context.recordedActions || []
  const grounded = elements.length + collections.length + actions.length > 0

  const addElements = (newElements: ElementEntry[], newCollections: CollectionEntry[], baseUrl?: string) => {
    onContext({
      ...context,
      elements: mergeElements(elements, newElements),
      collections: mergeCollections(collections, newCollections),
      ...(baseUrl ? { baseUrl } : {})
    })
  }

  const fetchUrl = async () => {
    const trimmed = url.trim()
    if (!trimmed) return setError('Enter a URL first.')
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const name = pageName.trim() || derivePageName(trimmed)
      const result = await fetchAndDistillUrl(trimmed, name)
      if (result.elements.length === 0 && result.collections.length === 0) {
        setError('Nothing interactive was found at that URL. If it is a single-page app, use "Paste DOM" instead.')
        return
      }
      let origin = ''
      try {
        origin = new URL(trimmed).origin
      } catch {
        /* keep whatever base URL is already set */
      }
      addElements(result.elements, result.collections, origin || undefined)
      setNotice(
        result.thin
          ? `Only ${result.elements.length} element(s) found — this looks like a pre-render shell. For a client-rendered app, use "Paste DOM" for the live DOM.`
          : `Grounded ${result.elements.length} element(s) and ${result.collections.length} repeating structure(s) on "${name}".`
      )
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not fetch that URL.'))
    } finally {
      setBusy(false)
    }
  }

  const ingestHtml = (html: string) => {
    setError('')
    setNotice('')
    if (!html.trim()) return setError('Paste the page HTML first.')
    const name = pageName.trim() || 'App'
    const newElements = distillHtml(html, name)
    const newCollections = detectCollections(html, name)
    if (newElements.length === 0 && newCollections.length === 0) {
      return setError('No interactive elements found in that HTML.')
    }
    addElements(newElements, newCollections)
    setPaste('')
    setNotice(
      `Grounded ${newElements.length} element(s) and ${newCollections.length} repeating structure(s) on "${name}".` +
        (newElements.length < THIN_SNAPSHOT_THRESHOLD ? ' That is unusually few — check you copied the full outerHTML.' : '')
    )
  }

  const ingestCodegen = () => {
    setError('')
    setNotice('')
    if (!paste.trim()) return setError('Paste your codegen script first.')
    const result = parseCodegenScript(paste, pageName.trim() || undefined)
    if (result.actions.length === 0) {
      return setError('No recorded actions found. Paste the full script `npx playwright codegen` printed.')
    }
    let baseUrl = context.baseUrl
    if (!baseUrl && result.urls[0]) {
      try {
        baseUrl = new URL(result.urls[0]).origin
      } catch {
        /* leave unset rather than storing something unusable */
      }
    }
    onContext({
      ...context,
      recordedActions: mergeActions(actions, result.actions),
      ...(baseUrl ? { baseUrl } : {})
    })
    setPaste('')
    setNotice(`Recorded ${result.actions.length} action(s) across ${result.urls.length || 1} page(s).`)
  }

  return (
    <>
      <div className="segmented mb-2">
        {SOURCES.map(s => (
          <button key={s.id} aria-pressed={source === s.id} onClick={() => setSource(s.id)} disabled={disabled}>
            {s.label}
          </button>
        ))}
      </div>
      <p className="mb-3 text-[11px]" style={{ color: 'var(--text-faint)' }}>
        {SOURCES.find(s => s.id === source)!.blurb}
      </p>

      <input
        className="field mb-2"
        placeholder="Screen name (optional) — e.g. Login, Checkout"
        value={pageName}
        disabled={disabled}
        onChange={e => setPageName(e.target.value)}
      />

      {source === 'url' && (
        <div className="flex gap-2">
          <input
            className="field"
            type="url"
            placeholder="https://app.example.com/login"
            value={url}
            disabled={disabled || busy}
            onChange={e => setUrl(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && fetchUrl()}
          />
          <button className="btn btn-sm" onClick={fetchUrl} disabled={disabled || busy}>
            {busy ? <span className="spinner" /> : <IconLink size={13} />}
            Ground
          </button>
        </div>
      )}

      {source !== 'url' && (
        <div className="space-y-2">
          <textarea
            className="field mono"
            rows={5}
            placeholder={
              source === 'html'
                ? '<html>…paste the full outerHTML here…</html>'
                : "import { test, expect } from '@playwright/test';\n\ntest('recorded', async ({ page }) => {\n  await page.goto('https://…');\n  await page.getByRole('button', { name: 'Log in' }).click();\n});"
            }
            value={paste}
            disabled={disabled}
            onChange={e => setPaste(e.target.value)}
          />
          <div className="flex gap-2">
            <button
              className="btn btn-sm"
              onClick={() => (source === 'html' ? ingestHtml(paste) : ingestCodegen())}
              disabled={disabled}
            >
              <IconCode size={13} />
              {source === 'html' ? 'Distil DOM' : 'Parse recording'}
            </button>
            {source === 'html' && (
              <>
                <input
                  ref={htmlFileRef}
                  type="file"
                  accept=".html,.htm,.txt"
                  className="hidden"
                  onChange={async e => {
                    const file = e.target.files?.[0]
                    if (file) ingestHtml(await file.text())
                    e.target.value = ''
                  }}
                />
                <button className="btn btn-sm" onClick={() => htmlFileRef.current?.click()} disabled={disabled}>
                  Upload .html
                </button>
              </>
            )}
          </div>
        </div>
      )}

      <label className="mt-3 block">
        <span className="eyebrow">Base URL (used to verify every generated route)</span>
        <input
          className="field mono mt-1.5"
          placeholder="https://app.example.com"
          value={context.baseUrl || ''}
          disabled={disabled}
          onChange={e => onContext({ ...context, baseUrl: e.target.value })}
        />
      </label>

      {error && (
        <p className="mt-3 flex items-start gap-1.5 text-xs" style={{ color: 'var(--err)' }}>
          <IconAlert size={13} className="mt-0.5 shrink-0" />
          {error}
        </p>
      )}
      {notice && !error && (
        <p className="mt-3 flex items-start gap-1.5 text-xs" style={{ color: 'var(--mint)' }}>
          <IconCheck size={13} className="mt-0.5 shrink-0" />
          {notice}
        </p>
      )}

      {grounded && (
        <div className="mt-3 border-t pt-3" style={{ borderColor: 'var(--border)' }}>
          <div className="flex items-center gap-2">
            <div className="flex flex-wrap gap-1.5">
              <span className="chip chip-mint">{elements.length} elements</span>
              {collections.length > 0 && <span className="chip chip-mint">{collections.length} lists</span>}
              {actions.length > 0 && <span className="chip chip-mint">{actions.length} recorded actions</span>}
            </div>
            <button
              className="btn btn-ghost btn-sm ml-auto"
              onClick={() => onContext({ baseUrl: context.baseUrl })}
              aria-label="Clear grounding"
            >
              <IconTrash size={13} />
            </button>
          </div>

          <button
            className="mt-2 flex items-center gap-1 text-[11px]"
            style={{ color: 'var(--text-faint)' }}
            onClick={() => setExpanded(v => !v)}
            aria-expanded={expanded}
          >
            <IconChevron size={12} className={`transition-transform ${expanded ? 'rotate-90' : ''}`} />
            Grounded selectors
          </button>

          {expanded && (
            <div className="mt-2 max-h-56 space-y-1 overflow-y-auto pr-1">
              {elements.slice(0, 80).map((el, idx) => (
                <div key={`${el.selector}-${idx}`} className="panel-raised px-2 py-1.5">
                  <p className="mono truncate text-[10.5px]" style={{ color: 'var(--mint)' }}>
                    {el.selector}
                  </p>
                  <p className="truncate text-[10.5px]" style={{ color: 'var(--text-faint)' }}>
                    {el.kind} · {el.label}
                    {el.page ? ` · ${el.page}` : ''}
                  </p>
                </div>
              ))}
              {collections.map(c => (
                <div key={c.itemSelector} className="panel-raised px-2 py-1.5">
                  <p className="mono truncate text-[10.5px]" style={{ color: 'var(--accent-hi)' }}>
                    {c.itemSelector}
                  </p>
                  <p className="truncate text-[10.5px]" style={{ color: 'var(--text-faint)' }}>
                    {c.name} · {c.count} items{c.nondeterministicOrder ? ' · order varies per load' : ''}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  )
}
