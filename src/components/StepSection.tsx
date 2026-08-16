import type { ReactNode } from 'react'
import { IconCheck, IconChevron } from './Icons'

// Every step stays visible as a header with its current status, so nothing is
// hidden behind a scroll — but only one body is open at a time, so the rail
// never becomes an endless column.

export default function StepSection({
  index,
  title,
  hint,
  status,
  done,
  optional,
  open,
  onToggle,
  children
}: {
  index: number
  title: string
  /** One line explaining why this step exists — shown when the step is open. */
  hint?: string
  /** Compact summary shown on the collapsed header, e.g. "demo-e2e · 3 pages". */
  status?: string
  done?: boolean
  optional?: boolean
  open: boolean
  onToggle: () => void
  children: ReactNode
}) {
  const headerId = `step-${index}-header`
  const panelId = `step-${index}-panel`

  return (
    <section className="panel overflow-hidden" style={done ? { borderColor: 'var(--mint-line)' } : undefined}>
      <h2>
        <button
          id={headerId}
          aria-expanded={open}
          aria-controls={panelId}
          onClick={onToggle}
          className="flex w-full items-center gap-2.5 px-3.5 py-3 text-left transition-colors hover:bg-[var(--bg-hover)]"
        >
          <span
            className="step-index shrink-0"
            style={done ? { background: 'var(--mint-dim)', color: 'var(--mint)', borderColor: 'var(--mint-line)' } : undefined}
          >
            {done ? <IconCheck size={12} /> : index}
          </span>

          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-semibold leading-tight">{title}</span>
            {status && (
              <span
                className="mt-0.5 block truncate text-[11px] leading-tight"
                style={{ color: done ? 'var(--mint)' : 'var(--text-faint)' }}
              >
                {status}
              </span>
            )}
          </span>

          {optional && !done && <span className="chip shrink-0">optional</span>}
          <IconChevron
            size={13}
            className={`shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
            style={{ color: 'var(--text-faint)' }}
          />
        </button>
      </h2>

      {open && (
        <div id={panelId} role="region" aria-labelledby={headerId} className="border-t px-3.5 pb-3.5 pt-3" style={{ borderColor: 'var(--border)' }}>
          {hint && (
            <p className="mb-3 text-[11px]" style={{ color: 'var(--text-faint)' }}>
              {hint}
            </p>
          )}
          {children}
        </div>
      )}
    </section>
  )
}
