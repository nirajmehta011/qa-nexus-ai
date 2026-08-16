import { useState } from 'react'
import type { Requirement, RequirementAnalysis, TestabilityIssue, TestabilityVerdict } from '../services/schemas'
import { IconAlert, IconCheck, IconChevron, IconSpark, IconTrash } from './Icons'

// The human checkpoint. The pipeline extracts requirements from the spec and
// stops here: every generated test case will be traced back to one of these, so
// this is the cheapest possible place to catch a misreading.

const VERDICT: Record<TestabilityVerdict, { label: string; chip: string; hint: string }> = {
  testable: { label: 'Testable', chip: 'chip-mint', hint: 'Concrete enough to write a deterministic test against.' },
  weak: { label: 'Weak', chip: 'chip-warn', hint: 'Testable, but the spec leaves room for interpretation.' },
  untestable: { label: 'Untestable', chip: 'chip-err', hint: 'Cannot be verified as written — expect low-value cases.' }
}

const ISSUE_LABEL: Record<TestabilityIssue, string> = {
  ambiguous: 'Ambiguous wording',
  unmeasurable: 'No measurable outcome',
  no_acceptance_criteria: 'No acceptance criteria',
  compound: 'Several requirements in one',
  contradiction: 'Contradicts another requirement',
  implementation_detail: 'Describes how, not what',
  missing_actor: 'No clear actor or role'
}

export interface GenerationChoices {
  selectedIds: string[]
  focusInstructions: string
  automationFriendly: boolean
}

export default function RequirementsReview({
  requirements,
  warnings,
  analyses,
  analyzing,
  busy,
  initialFocusInstructions,
  onConfirm,
  onCancel
}: {
  requirements: Requirement[]
  warnings: string[]
  analyses?: RequirementAnalysis[] | null
  analyzing?: boolean
  busy: boolean
  /** Pre-fills the focus field from the optional scope entered before generation. */
  initialFocusInstructions?: string
  onConfirm: (reviewed: Requirement[], choices: GenerationChoices) => void
  onCancel: () => void
}) {
  const [edited, setEdited] = useState<Requirement[]>(requirements)
  const [selected, setSelected] = useState<Set<string>>(() => new Set(requirements.map(r => r.id)))
  const [focus, setFocus] = useState(initialFocusInstructions || '')
  const [automationFriendly, setAutomationFriendly] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const analysisById = new Map((analyses || []).map(a => [a.requirementId, a]))
  const ungrounded = edited.filter(r => r.grounded === false).length

  const toggle = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const updateText = (id: string, text: string) =>
    setEdited(prev => prev.map(r => (r.id === id ? { ...r, text } : r)))

  const remove = (id: string) => {
    setEdited(prev => prev.filter(r => r.id !== id))
    setSelected(prev => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }

  const confirm = () =>
    onConfirm(
      edited.filter(r => selected.has(r.id)),
      { selectedIds: [...selected], focusInstructions: focus.trim(), automationFriendly }
    )

  return (
    <div className="space-y-4">
      <div className="panel p-4">
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-semibold">Review the extracted requirements</h2>
            <p className="mt-1 text-[12px]" style={{ color: 'var(--text-dim)' }}>
              Every test case will cite one of these. Fix a misreading here and the whole suite improves — it is far
              cheaper than correcting generated cases afterwards.
            </p>
          </div>
          <div className="flex gap-2">
            <button className="btn btn-sm" onClick={onCancel} disabled={busy}>
              Back
            </button>
            <button className="btn btn-primary btn-sm" onClick={confirm} disabled={busy || selected.size === 0}>
              {busy ? <span className="spinner" /> : <IconSpark size={13} />}
              Generate from {selected.size} requirement{selected.size === 1 ? '' : 's'}
            </button>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap gap-1.5">
          <span className="chip">{edited.length} extracted</span>
          <span className="chip chip-accent">{selected.size} selected</span>
          {ungrounded > 0 && (
            <span className="chip chip-warn" title="The cited source snippet could not be found verbatim in your spec">
              {ungrounded} unverified quote{ungrounded === 1 ? '' : 's'}
            </span>
          )}
          {analyzing && (
            <span className="chip">
              <span className="spinner" style={{ width: 9, height: 9 }} /> analysing testability
            </span>
          )}
        </div>

        {warnings.length > 0 && (
          <ul className="mt-3 space-y-1 border-t pt-3" style={{ borderColor: 'var(--border)' }}>
            {warnings.map((w, i) => (
              <li key={`${w}-${i}`} className="flex items-start gap-1.5 text-[11px]" style={{ color: 'var(--text-dim)' }}>
                <IconAlert size={12} className="mt-0.5 shrink-0" style={{ color: 'var(--warn)' }} />
                {w}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-2">
        {edited.map(req => {
          const analysis = analysisById.get(req.id)
          const verdict = analysis ? VERDICT[analysis.verdict] : null
          const isOpen = expandedId === req.id
          const isSelected = selected.has(req.id)

          return (
            <article
              key={req.id}
              className="panel p-3"
              style={isSelected ? undefined : { opacity: 0.55 }}
            >
              <div className="flex items-start gap-2.5">
                <input
                  type="checkbox"
                  className="mt-1 shrink-0"
                  checked={isSelected}
                  onChange={() => toggle(req.id)}
                  aria-label={`Include ${req.id}`}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="mono text-[12px] font-semibold" style={{ color: 'var(--accent-hi)' }}>
                      {req.id}
                    </span>
                    <span className="chip">{req.category.replace('_', ' ')}</span>
                    <span className="chip">{req.priority}</span>
                    {verdict && (
                      <span className={`chip ${verdict.chip}`} title={verdict.hint}>
                        {verdict.label}
                      </span>
                    )}
                    {req.grounded === false && (
                      <span className="chip chip-warn" title="Quote not found verbatim in your specification">
                        unverified quote
                      </span>
                    )}
                  </div>

                  <textarea
                    className="field mt-2 text-[13px]"
                    rows={2}
                    value={req.text}
                    onChange={e => updateText(req.id, e.target.value)}
                    disabled={busy}
                    aria-label={`Requirement text for ${req.id}`}
                  />

                  <button
                    className="mt-1.5 flex items-center gap-1 text-[11px]"
                    style={{ color: 'var(--text-faint)' }}
                    onClick={() => setExpandedId(isOpen ? null : req.id)}
                    aria-expanded={isOpen}
                  >
                    <IconChevron size={11} className={`transition-transform ${isOpen ? 'rotate-90' : ''}`} />
                    Source quote{analysis?.issues.length ? ` · ${analysis.issues.length} issue(s)` : ''}
                  </button>

                  {isOpen && (
                    <div className="mt-2 space-y-2 border-t pt-2" style={{ borderColor: 'var(--border)' }}>
                      <blockquote
                        className="border-l-2 pl-2.5 text-[11.5px] italic"
                        style={{ borderColor: 'var(--accent-line)', color: 'var(--text-dim)' }}
                      >
                        “{req.sourceSnippet}”
                      </blockquote>
                      {analysis && analysis.issues.length > 0 && (
                        <ul className="space-y-1">
                          {analysis.issues.map(issue => (
                            <li key={issue} className="flex items-start gap-1.5 text-[11px]" style={{ color: 'var(--warn)' }}>
                              <IconAlert size={11} className="mt-0.5 shrink-0" />
                              {ISSUE_LABEL[issue] || issue}
                            </li>
                          ))}
                        </ul>
                      )}
                      {analysis?.rationale && (
                        <p className="text-[11.5px]" style={{ color: 'var(--text-dim)' }}>
                          <span className="eyebrow mr-1.5">Reviewer note</span>
                          {analysis.rationale}
                        </p>
                      )}
                      {analysis?.suggestedRewrite && (
                        <div className="rounded-md p-2" style={{ background: 'var(--bg-hover)' }}>
                          <p className="eyebrow mb-1">Suggested testable phrasing</p>
                          <p className="text-[11.5px]" style={{ color: 'var(--text-dim)' }}>
                            {analysis.suggestedRewrite}
                          </p>
                          <button
                            className="btn btn-sm mt-2"
                            onClick={() => updateText(req.id, analysis.suggestedRewrite!)}
                            disabled={busy || req.text === analysis.suggestedRewrite}
                          >
                            <IconCheck size={12} />
                            {req.text === analysis.suggestedRewrite ? 'Applied' : 'Use this wording'}
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                <button
                  className="btn btn-ghost btn-sm shrink-0"
                  onClick={() => remove(req.id)}
                  disabled={busy}
                  aria-label={`Remove ${req.id}`}
                >
                  <IconTrash size={13} />
                </button>
              </div>
            </article>
          )
        })}
      </div>

      <div className="panel p-4">
        <label className="block">
          <span className="eyebrow">Focus instructions (optional)</span>
          <textarea
            className="field mt-1.5"
            rows={2}
            placeholder="e.g. concentrate on payment failure paths and session expiry"
            value={focus}
            disabled={busy}
            onChange={e => setFocus(e.target.value)}
          />
        </label>

        <label className="mt-3 flex cursor-pointer items-start gap-2">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={automationFriendly}
            onChange={e => setAutomationFriendly(e.target.checked)}
            disabled={busy}
          />
          <span className="text-[12px]">
            Automation-friendly steps
            <span className="block text-[11px]" style={{ color: 'var(--text-faint)' }}>
              Bias steps towards deterministic, machine-executable actions — better input for the Playwright stage.
            </span>
          </span>
        </label>

        <button className="btn btn-primary mt-4 w-full" onClick={confirm} disabled={busy || selected.size === 0}>
          {busy ? <span className="spinner" /> : <IconCheck size={14} />}
          Generate test cases from {selected.size} requirement{selected.size === 1 ? '' : 's'}
        </button>
      </div>
    </div>
  )
}
