import { useMemo, useRef, useState } from 'react'
import type { TestCase, TestStep } from '../services/aiService'
import { SCENARIO_TYPES, type ScenarioType } from '../services/schemas'
import { parseCSVToTestCases, parseExcelToCSV } from '../services/exportService'
import { extractErrorMessage } from '../services/errorUtils'
import ExportButtons from './ExportButtons'
import { IconAlert, IconChevron, IconCheck, IconClose, IconPlus, IconSpark, IconTrash } from './Icons'

const SCENARIO_LABEL: Record<ScenarioType, string> = {
  happy_path: 'Happy path',
  negative: 'Negative',
  edge_case: 'Edge case',
  boundary: 'Boundary',
  ui_ux: 'UI / UX',
  security: 'Security',
  performance: 'Performance'
}

const PRIORITIES = ['Critical', 'High', 'Medium', 'Low']

const PRIORITY_CHIP: Record<string, string> = {
  Critical: 'chip-err',
  High: 'chip-warn'
}

function ConfidenceBadge({ confidence }: { confidence: NonNullable<TestCase['confidence']> }) {
  const verdict = confidence.verdict || 'medium'
  const className = verdict === 'high' ? 'chip-mint' : verdict === 'low' ? 'chip-err' : 'chip-warn'
  return (
    <span className={`chip ${className}`} title={confidence.reason || `Grounding confidence: ${verdict}`}>
      {confidence.score ?? '—'}% grounded
    </span>
  )
}

function StepsTable({
  testCase,
  editing,
  onStepChange,
  onStepDelete,
  onStepAdd
}: {
  testCase: TestCase
  editing: boolean
  onStepChange: (index: number, patch: Partial<TestStep>) => void
  onStepDelete: (index: number) => void
  onStepAdd: () => void
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] border-collapse text-[12px]">
        <thead>
          <tr>
            <th className="eyebrow w-8 pb-2 text-left">#</th>
            <th className="eyebrow pb-2 text-left">Action</th>
            <th className="eyebrow w-1/5 pb-2 text-left">Test data</th>
            <th className="eyebrow w-2/5 pb-2 text-left">Expected result</th>
            {editing && <th className="w-8 pb-2" />}
          </tr>
        </thead>
        <tbody>
          {testCase.steps.map((step, idx) => (
            <tr key={`${testCase.id}-${idx}`} className="border-t align-top" style={{ borderColor: 'var(--border)' }}>
              <td className="mono py-2 pr-2" style={{ color: 'var(--text-faint)' }}>
                {step.stepNumber}
              </td>
              {editing ? (
                <>
                  <td className="py-1 pr-2">
                    <textarea
                      className="field text-[12px]"
                      rows={2}
                      value={step.action}
                      onChange={e => onStepChange(idx, { action: e.target.value })}
                      aria-label={`Step ${step.stepNumber} action`}
                    />
                  </td>
                  <td className="py-1 pr-2">
                    <textarea
                      className="field mono text-[12px]"
                      rows={2}
                      value={step.testData}
                      onChange={e => onStepChange(idx, { testData: e.target.value })}
                      aria-label={`Step ${step.stepNumber} test data`}
                    />
                  </td>
                  <td className="py-1 pr-2">
                    <textarea
                      className="field text-[12px]"
                      rows={2}
                      value={step.expectedResult}
                      onChange={e => onStepChange(idx, { expectedResult: e.target.value })}
                      aria-label={`Step ${step.stepNumber} expected result`}
                    />
                  </td>
                  <td className="py-1">
                    <button
                      className="btn btn-ghost btn-sm p-1"
                      onClick={() => onStepDelete(idx)}
                      aria-label={`Delete step ${step.stepNumber}`}
                    >
                      <IconTrash size={12} />
                    </button>
                  </td>
                </>
              ) : (
                <>
                  <td className="py-2 pr-3">{step.action}</td>
                  <td className="mono py-2 pr-3" style={{ color: 'var(--text-dim)' }}>
                    {step.testData || '—'}
                  </td>
                  <td className="py-2" style={{ color: 'var(--text-dim)' }}>
                    {step.expectedResult}
                  </td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>

      {editing && (
        <button className="btn btn-sm mt-2" onClick={onStepAdd}>
          <IconPlus size={12} /> Add step
        </button>
      )}
    </div>
  )
}

function TestCaseRow({
  testCase,
  defaultOpen,
  onUpdate,
  onDelete
}: {
  testCase: TestCase
  defaultOpen: boolean
  onUpdate: (next: TestCase) => void
  onDelete: () => void
}) {
  const [open, setOpen] = useState(defaultOpen)
  const [editing, setEditing] = useState(false)

  const patch = (fields: Partial<TestCase>) => onUpdate({ ...testCase, ...fields })

  const renumber = (steps: TestStep[]) => steps.map((s, i) => ({ ...s, stepNumber: i + 1 }))

  return (
    <article className="panel overflow-hidden">
      <div className="flex items-start gap-2 p-3">
        <button
          className="mt-0.5 shrink-0"
          onClick={() => setOpen(v => !v)}
          aria-expanded={open}
          aria-label={open ? `Collapse ${testCase.id}` : `Expand ${testCase.id}`}
        >
          <IconChevron size={14} className={`transition-transform ${open ? 'rotate-90' : ''}`} />
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="mono text-[12px] font-semibold" style={{ color: 'var(--accent-hi)' }}>
              {testCase.id}
            </span>
            {editing ? (
              <input
                className="field flex-1 text-[13px]"
                value={testCase.summary}
                onChange={e => patch({ summary: e.target.value })}
                aria-label={`Summary for ${testCase.id}`}
              />
            ) : (
              <button className="text-left text-[13px] font-medium" onClick={() => setOpen(v => !v)}>
                {testCase.summary}
              </button>
            )}
          </div>

          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {editing ? (
              <>
                <select
                  className="field w-auto py-1 text-[11px]"
                  value={testCase.scenarioType}
                  onChange={e => patch({ scenarioType: e.target.value as ScenarioType })}
                  aria-label="Scenario type"
                >
                  {SCENARIO_TYPES.map(t => (
                    <option key={t} value={t}>
                      {SCENARIO_LABEL[t]}
                    </option>
                  ))}
                </select>
                <select
                  className="field w-auto py-1 text-[11px]"
                  value={testCase.priority}
                  onChange={e => patch({ priority: e.target.value })}
                  aria-label="Priority"
                >
                  {PRIORITIES.map(p => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
                <input
                  className="field w-auto py-1 text-[11px]"
                  value={testCase.component}
                  placeholder="Component"
                  onChange={e => patch({ component: e.target.value })}
                  aria-label="Component"
                />
              </>
            ) : (
              <>
                <span className="chip chip-accent">
                  {SCENARIO_LABEL[testCase.scenarioType] || testCase.scenarioType}
                </span>
                <span className={`chip ${PRIORITY_CHIP[testCase.priority] || ''}`}>{testCase.priority}</span>
                {testCase.component && <span className="chip">{testCase.component}</span>}
                <span className="chip">{testCase.steps.length} steps</span>
                {testCase.sourceRequirement && (
                  <span
                    className="chip chip-mint mono"
                    title={`Traced to: “${testCase.sourceRequirement.snippet}”`}
                  >
                    {testCase.sourceRequirement.requirementId}
                  </span>
                )}
                {testCase.confidence && <ConfidenceBadge confidence={testCase.confidence} />}
                {testCase.critiqueNote && (
                  <span className="chip chip-warn" title={testCase.critiqueNote}>
                    reviewed
                  </span>
                )}
              </>
            )}
          </div>
        </div>

        <div className="flex shrink-0 gap-1">
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => {
              setEditing(v => !v)
              setOpen(true)
            }}
            aria-label={editing ? `Finish editing ${testCase.id}` : `Edit ${testCase.id}`}
          >
            {editing ? <IconCheck size={13} /> : <IconSpark size={13} />}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={onDelete} aria-label={`Delete ${testCase.id}`}>
            <IconTrash size={13} />
          </button>
        </div>
      </div>

      {open && (
        <div className="border-t px-3 pb-3 pt-3" style={{ borderColor: 'var(--border)' }}>
          {editing ? (
            <label className="mb-3 block">
              <span className="eyebrow">Precondition</span>
              <textarea
                className="field mt-1 text-[12px]"
                rows={2}
                value={testCase.precondition}
                onChange={e => patch({ precondition: e.target.value })}
              />
            </label>
          ) : (
            testCase.precondition && (
              <p className="mb-3 text-[12px]" style={{ color: 'var(--text-dim)' }}>
                <span className="eyebrow mr-2">Precondition</span>
                {testCase.precondition}
              </p>
            )
          )}

          {testCase.sourceRequirement && !editing && (
            <blockquote
              className="mb-3 border-l-2 pl-2.5 text-[11.5px] italic"
              style={{ borderColor: 'var(--mint-line)', color: 'var(--text-dim)' }}
            >
              {testCase.sourceRequirement.requirementId}: “{testCase.sourceRequirement.snippet}”
            </blockquote>
          )}

          {testCase.critiqueNote && !editing && (
            <p className="mb-3 text-[12px]" style={{ color: 'var(--text-dim)' }}>
              <span className="eyebrow mr-2">Critique</span>
              {testCase.critiqueNote}
            </p>
          )}

          {testCase.confidence?.reason && !editing && (
            <p className="mb-3 text-[12px]" style={{ color: 'var(--text-dim)' }}>
              <span className="eyebrow mr-2">Reviewer note</span>
              {testCase.confidence.reason}
            </p>
          )}

          <StepsTable
            testCase={testCase}
            editing={editing}
            onStepChange={(index, stepPatch) =>
              patch({ steps: testCase.steps.map((s, i) => (i === index ? { ...s, ...stepPatch } : s)) })
            }
            onStepDelete={index => patch({ steps: renumber(testCase.steps.filter((_, i) => i !== index)) })}
            onStepAdd={() =>
              patch({
                steps: renumber([
                  ...testCase.steps,
                  { stepNumber: testCase.steps.length + 1, action: '', testData: '', expectedResult: '' }
                ])
              })
            }
          />
        </div>
      )}
    </article>
  )
}

export default function TestCasesDisplay({
  testCases,
  allCases,
  specId,
  busy,
  onGenerateMore,
  onChange
}: {
  /** Cases currently visible (may be filtered by the coverage matrix). */
  testCases: TestCase[]
  /** The full set — edits and imports apply here, not to the filtered view. */
  allCases: TestCase[]
  specId: string
  busy: boolean
  onGenerateMore: () => void
  onChange: (next: TestCase[]) => void
}) {
  const [filter, setFilter] = useState<ScenarioType | 'all'>('all')
  const [importError, setImportError] = useState('')
  const [importNotice, setImportNotice] = useState('')
  const importRef = useRef<HTMLInputElement>(null)

  const counts = useMemo(() => {
    const map = new Map<string, number>()
    for (const tc of testCases) map.set(tc.scenarioType, (map.get(tc.scenarioType) || 0) + 1)
    return map
  }, [testCases])

  const visible = filter === 'all' ? testCases : testCases.filter(tc => tc.scenarioType === filter)
  const totalSteps = testCases.reduce((sum, tc) => sum + tc.steps.length, 0)
  const scored = testCases.filter(tc => typeof tc.confidence?.score === 'number')
  const avgConfidence = scored.length
    ? Math.round(scored.reduce((sum, tc) => sum + (tc.confidence!.score || 0), 0) / scored.length)
    : null

  const updateCase = (id: string, next: TestCase) =>
    onChange(allCases.map(tc => (tc.id === id ? next : tc)))

  const deleteCase = (id: string) => onChange(allCases.filter(tc => tc.id !== id))

  const importFile = async (file: File) => {
    setImportError('')
    setImportNotice('')
    try {
      const isExcel = /\.(xlsx|xls)$/i.test(file.name)
      const csv = isExcel ? await parseExcelToCSV(file) : await file.text()
      const imported = parseCSVToTestCases(csv)
      if (imported.length === 0) {
        setImportError('No test cases were found in that file. Check it has a summary/title column.')
        return
      }
      // Re-key imported ids so they never collide with what is already loaded.
      const offset = allCases.length
      const renumbered = imported.map((tc, i) => ({ ...tc, id: `TC-${String(offset + i + 1).padStart(3, '0')}` }))
      onChange([...allCases, ...renumbered])
      setImportNotice(`Imported ${renumbered.length} test case(s) from ${file.name}.`)
    } catch (err) {
      setImportError(extractErrorMessage(err, 'Could not read that file.'))
    }
  }

  return (
    <div className="space-y-4">
      <div className="panel flex flex-wrap items-center gap-x-5 gap-y-2 p-3">
        <Stat label="Test cases" value={testCases.length} />
        <Stat label="Steps" value={totalSteps} />
        <Stat label="Scenario types" value={counts.size} />
        {avgConfidence !== null && (
          <div>
            <p className="eyebrow">Avg. grounding</p>
            <p
              className="mono text-[17px] font-semibold leading-tight"
              style={{ color: avgConfidence >= 80 ? 'var(--ok)' : avgConfidence >= 50 ? 'var(--warn)' : 'var(--err)' }}
            >
              {avgConfidence}%
            </p>
          </div>
        )}

        <div className="ml-auto flex items-center gap-2">
          <input
            ref={importRef}
            type="file"
            className="hidden"
            accept=".csv,.xlsx,.xls"
            onChange={e => {
              const file = e.target.files?.[0]
              if (file) importFile(file)
              e.target.value = ''
            }}
          />
          <button className="btn btn-sm" onClick={() => importRef.current?.click()} title="Import existing test cases from CSV or Excel">
            Import
          </button>
          <button className="btn btn-sm" onClick={onGenerateMore} disabled={busy}>
            {busy ? <span className="spinner" /> : <IconPlus size={13} />}
            Generate more
          </button>
          <ExportButtons testCases={testCases} specId={specId} />
        </div>
      </div>

      {(importError || importNotice) && (
        <p
          className="flex items-center gap-1.5 text-xs"
          style={{ color: importError ? 'var(--err)' : 'var(--mint)' }}
        >
          {importError ? <IconAlert size={13} /> : <IconCheck size={13} />}
          {importError || importNotice}
          <button
            className="btn btn-ghost btn-sm p-1"
            onClick={() => {
              setImportError('')
              setImportNotice('')
            }}
            aria-label="Dismiss"
          >
            <IconClose size={11} />
          </button>
        </p>
      )}

      <div className="flex flex-wrap gap-1.5">
        <FilterChip active={filter === 'all'} onClick={() => setFilter('all')} label={`All (${testCases.length})`} />
        {SCENARIO_TYPES.filter(t => counts.get(t)).map(t => (
          <FilterChip
            key={t}
            active={filter === t}
            onClick={() => setFilter(t)}
            label={`${SCENARIO_LABEL[t]} (${counts.get(t)})`}
          />
        ))}
      </div>

      <div className="space-y-2">
        {visible.map(tc => (
          <TestCaseRow
            key={tc.id}
            testCase={tc}
            defaultOpen={testCases.length === 1}
            onUpdate={next => updateCase(tc.id, next)}
            onDelete={() => deleteCase(tc.id)}
          />
        ))}
      </div>

      {visible.length === 0 && (
        <p className="py-8 text-center text-[13px]" style={{ color: 'var(--text-faint)' }}>
          <IconSpark className="mx-auto mb-2 opacity-50" />
          No test cases match this filter.
        </p>
      )}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <p className="eyebrow">{label}</p>
      <p className="mono text-[17px] font-semibold leading-tight">{value}</p>
    </div>
  )
}

function FilterChip({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button className={`chip ${active ? 'chip-accent' : ''} cursor-pointer`} onClick={onClick} aria-pressed={active}>
      {label}
    </button>
  )
}
