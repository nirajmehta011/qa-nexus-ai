import { useState } from 'react'
import type { AutomationBuildResult } from '../services/automationBuilder'
import { copyToClipboard, exportPlaywrightAsZip, sanitizeName } from '../services/exportService'
import { extractErrorMessage } from '../services/errorUtils'
import { IconAlert, IconCheck, IconCode, IconDownload, IconSpark } from './Icons'

// Shows the generated suite the way an SDET reads it: how trustworthy it is
// first, then what was rejected, then the file tree, then the code.

function GroundingMeter({ rate, hasGrounding }: { rate: number; hasGrounding: boolean }) {
  const pct = Math.round(rate * 100)
  const tone = !hasGrounding ? 'var(--text-faint)' : pct >= 80 ? 'var(--ok)' : pct >= 40 ? 'var(--warn)' : 'var(--err)'

  return (
    <div className="min-w-[150px]">
      <p className="eyebrow">Selector grounding</p>
      <div className="flex items-baseline gap-1.5">
        <span className="mono text-[17px] font-semibold leading-tight" style={{ color: tone }}>
          {hasGrounding ? `${pct}%` : '—'}
        </span>
        <span className="text-[11px]" style={{ color: 'var(--text-faint)' }}>
          {hasGrounding ? 'verified locators' : 'no DOM supplied'}
        </span>
      </div>
      <div
        className="mt-1.5 h-1 w-full overflow-hidden rounded-full"
        style={{ background: 'var(--bg-hover)' }}
        role="progressbar"
        aria-valuenow={hasGrounding ? pct : 0}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Share of generated locators that were verified against a real DOM"
      >
        <div style={{ width: `${hasGrounding ? pct : 0}%`, height: '100%', background: tone, transition: 'width .4s' }} />
      </div>
    </div>
  )
}

export default function AutomationPanel({
  suite,
  specId,
  busy,
  hasFramework,
  hasGrounding,
  onGenerate
}: {
  suite: AutomationBuildResult | null
  specId: string
  busy: boolean
  hasFramework: boolean
  hasGrounding: boolean
  onGenerate: () => void
}) {
  const [selected, setSelected] = useState(0)
  const [downloadError, setDownloadError] = useState('')
  const [copiedCommands, setCopiedCommands] = useState(false)

  if (!suite) {
    return (
      <div className="panel flex flex-col items-center gap-3 px-6 py-14 text-center">
        <IconCode size={24} className="opacity-40" />
        <div>
          <p className="text-[14px] font-medium">No automation suite yet</p>
          <p className="mx-auto mt-1 max-w-md text-[12px]" style={{ color: 'var(--text-faint)' }}>
            {hasFramework && hasGrounding
              ? 'Your framework and a grounded DOM are both loaded — specs will call your own page classes using verified selectors.'
              : hasFramework
                ? 'Your framework is loaded. Add selector grounding too and every locator will be one that provably exists.'
                : hasGrounding
                  ? 'Selectors are grounded. Upload your framework as well and the specs will reuse your existing page objects.'
                  : 'Generate a Playwright suite from the test cases. Add your framework and a grounded DOM first for a suite you can actually run.'}
          </p>
        </div>
        <button className="btn btn-primary" onClick={onGenerate} disabled={busy}>
          {busy ? <span className="spinner" /> : <IconSpark size={14} />}
          {busy ? 'Generating suite…' : 'Generate Playwright suite'}
        </button>
      </div>
    )
  }

  const files = [
    { filename: 'README.md', code: suite.readme },
    { filename: 'playwright.config.ts', code: suite.playwrightConfig },
    { filename: 'package.json', code: suite.packageJson },
    { filename: 'tsconfig.json', code: suite.tsconfigJson },
    ...suite.testFiles
  ]
  const current = files[Math.min(selected, files.length - 1)]
  const fixmeCount = suite.testFiles.filter(f => f.code.includes('test.fixme')).length

  const download = async () => {
    setDownloadError('')
    try {
      await exportPlaywrightAsZip(suite, specId)
    } catch (err) {
      setDownloadError(extractErrorMessage(err, 'Could not build the ZIP.'))
    }
  }

  // Actually running the suite needs a real browser automation driver — that
  // only exists in Node with Playwright's installed browser binaries, which a
  // web page cannot reach into. This is the honest next step instead: the
  // exact commands to go from ZIP to a pass/fail report, one copy away.
  const copyRunCommands = async () => {
    const folder = `playwright-suite-${sanitizeName(specId)}`
    const ok = await copyToClipboard(
      `cd ${folder} && npm install && npx playwright install chromium && npm test`
    )
    if (ok) {
      setCopiedCommands(true)
      setTimeout(() => setCopiedCommands(false), 2000)
    }
  }

  return (
    <div className="space-y-4">
      <div className="panel flex flex-wrap items-center gap-x-6 gap-y-3 p-3">
        <GroundingMeter rate={suite.selectorGroundingRate} hasGrounding={hasGrounding} />

        <div>
          <p className="eyebrow">Files</p>
          <p className="mono text-[17px] font-semibold leading-tight">{files.length}</p>
        </div>

        <div>
          <p className="eyebrow">Mode</p>
          <p
            className="text-[13px] font-medium leading-tight"
            style={{ color: suite.frameworkAware ? 'var(--mint)' : 'var(--text-dim)' }}
          >
            {suite.frameworkAware ? 'Framework-aware' : 'Generated POM'}
          </p>
        </div>

        <div>
          <p className="eyebrow">Needs attention</p>
          <p
            className="mono text-[17px] font-semibold leading-tight"
            style={{ color: fixmeCount + suite.todoSelectorCount > 0 ? 'var(--warn)' : 'var(--ok)' }}
          >
            {fixmeCount + suite.todoSelectorCount}
          </p>
        </div>

        <div className="ml-auto flex gap-2">
          <button className="btn btn-sm" onClick={onGenerate} disabled={busy}>
            {busy ? <span className="spinner" /> : <IconSpark size={13} />}
            Regenerate
          </button>
          <button className="btn btn-sm" onClick={copyRunCommands} title="Copy the setup + run commands for this suite">
            {copiedCommands ? <IconCheck size={13} style={{ color: 'var(--ok)' }} /> : <IconCode size={13} />}
            {copiedCommands ? 'Copied' : 'Copy run commands'}
          </button>
          <button className="btn btn-primary btn-sm" onClick={download}>
            <IconDownload size={13} />
            Download ZIP
          </button>
        </div>
      </div>

      {suite.frameworkAware && suite.reusedPageClasses.length > 0 && (
        <div
          className="flex flex-wrap items-center gap-2 rounded-lg border p-3"
          style={{ borderColor: 'var(--mint-line)', background: 'var(--mint-dim)' }}
        >
          <IconCheck size={14} style={{ color: 'var(--mint)' }} />
          <span className="text-[12px]">
            Methods were added to your own classes and the complete updated files are included:
          </span>
          {suite.reusedPageClasses.map(name => (
            <span key={name} className="chip chip-mint mono">
              {name}
            </span>
          ))}
        </div>
      )}

      {downloadError && (
        <p className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--err)' }}>
          <IconAlert size={13} /> {downloadError}
        </p>
      )}

      {suite.warnings.length > 0 && (
        <details className="rounded-lg border p-3" style={{ borderColor: 'var(--warn-line)', background: 'var(--warn-dim)' }} open>
          <summary className="eyebrow cursor-pointer" style={{ color: 'var(--warn)' }}>
            Rejected rather than shipped broken ({suite.warnings.length})
          </summary>
          <p className="mb-2 mt-2 text-[11px]" style={{ color: 'var(--text-dim)' }}>
            Each of these was caught before download. Specs that couldn't be trusted are marked{' '}
            <span className="mono">test.fixme</span> rather than left to fail silently in CI.
          </p>
          <ul className="space-y-1">
            {suite.warnings.map((w, i) => (
              <li key={`${w}-${i}`} className="flex items-start gap-1.5 text-[12px]" style={{ color: 'var(--text-dim)' }}>
                <IconAlert size={12} className="mt-0.5 shrink-0" style={{ color: 'var(--warn)' }} />
                {w}
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="grid gap-3 lg:grid-cols-[minmax(200px,280px)_1fr]">
        <nav className="panel max-h-[560px] overflow-y-auto p-1.5" aria-label="Generated files">
          {files.map((file, idx) => {
            const needsWork = file.code.includes('test.fixme') || file.code.includes('TODO-SELECTOR')
            return (
              <button
                key={file.filename + idx}
                className="mono flex w-full items-center gap-1.5 rounded-md px-2.5 py-1.5 text-left text-[11.5px] transition-colors"
                style={
                  idx === selected
                    ? { background: 'var(--accent-dim)', color: 'var(--accent-hi)' }
                    : { color: 'var(--text-dim)' }
                }
                onClick={() => setSelected(idx)}
              >
                <span className="truncate">{file.filename}</span>
                {needsWork && (
                  <span
                    className="ml-auto shrink-0"
                    style={{ width: 5, height: 5, borderRadius: 999, background: 'var(--warn)' }}
                    title="Contains a fixme or TODO-SELECTOR"
                  />
                )}
              </button>
            )
          })}
        </nav>

        <div className="panel overflow-hidden">
          <div className="flex items-center justify-between border-b px-3 py-2" style={{ borderColor: 'var(--border)' }}>
            <span className="mono truncate text-[12px]">{current.filename}</span>
            <span className="chip">{current.code.split('\n').length} lines</span>
          </div>
          <pre className="code-block max-h-[510px] overflow-auto rounded-none border-0">{current.code}</pre>
        </div>
      </div>
    </div>
  )
}
