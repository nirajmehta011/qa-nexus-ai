import { useState } from 'react'
import type { TestCase } from '../services/aiService'
import {
  exportTestCasesAsCSV,
  exportTestCasesAsJSON,
  exportTestCasesAsTestRailCSV,
  exportTestCasesAsXrayCSV,
  exportTestCasesAsZephyrCSV
} from '../services/exportService'
import { IconChevron, IconDownload } from './Icons'

const TARGETS: { label: string; hint: string; run: (cases: TestCase[], specId: string) => void }[] = [
  { label: 'Jira CSV', hint: 'Jira issue importer', run: (c, id) => exportTestCasesAsCSV(c, id) },
  { label: 'Zephyr Scale CSV', hint: 'One row per step', run: (c, id) => exportTestCasesAsZephyrCSV(c, id) },
  { label: 'Xray CSV', hint: 'Test Case Importer', run: (c, id) => exportTestCasesAsXrayCSV(c, id) },
  { label: 'TestRail CSV', hint: 'One row per case', run: (c, id) => exportTestCasesAsTestRailCSV(c, id) },
  { label: 'JSON', hint: 'Raw generated data', run: (c, id) => exportTestCasesAsJSON(c, id) }
]

export default function ExportButtons({
  testCases,
  specId,
  scopeNote
}: {
  testCases: TestCase[]
  specId: string
  /** Shown above the targets when the export covers a subset, so "Export" is never ambiguous. */
  scopeNote?: string
}) {
  const [open, setOpen] = useState(false)

  if (testCases.length === 0) return null

  return (
    <div className="relative">
      <button className="btn btn-sm" onClick={() => setOpen(v => !v)} aria-expanded={open}>
        <IconDownload size={13} />
        Export
        <IconChevron size={12} className={`transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} aria-hidden="true" />
          <div className="panel-raised rise absolute right-0 z-20 mt-1.5 w-56 overflow-hidden p-1 shadow-xl">
            {scopeNote && (
              <p className="border-b px-2.5 pb-1.5 pt-1 text-[11px]" style={{ borderColor: 'var(--border)', color: 'var(--accent-hi)' }}>
                {scopeNote}
              </p>
            )}
            {TARGETS.map(target => (
              <button
                key={target.label}
                className="w-full rounded-md px-2.5 py-2 text-left transition-colors hover:bg-[var(--bg-hover)]"
                onClick={() => {
                  target.run(testCases, specId)
                  setOpen(false)
                }}
              >
                <span className="block text-[13px]">{target.label}</span>
                <span className="block text-[11px]" style={{ color: 'var(--text-faint)' }}>
                  {target.hint}
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
