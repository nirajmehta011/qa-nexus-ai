import { IconAlert, IconCheck, IconClose } from './Icons'

export interface ProgressEntry {
  id: number
  text: string
  status: 'running' | 'done' | 'error'
}

// Lives in the RIGHT pane — where the user is actually looking while a
// generation runs — rather than a single line tucked in the sidebar. Shows
// every stage as it happens (not just the latest one) so "what is it doing"
// is never a mystery, and carries the Stop control right next to the thing
// it stops.
export default function GenerationProgress({
  label,
  entries,
  onStop
}: {
  label: string
  entries: ProgressEntry[]
  onStop: () => void
}) {
  return (
    <div className="panel rise p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="spinner" />
          <h2 className="text-[13px] font-semibold">{label}</h2>
        </div>
        <button
          className="btn btn-sm"
          onClick={onStop}
          style={{ borderColor: 'var(--err-line)', color: 'var(--err)' }}
        >
          <IconClose size={12} />
          Stop
        </button>
      </div>

      {entries.length > 0 && (
        <ol className="mt-3 max-h-64 space-y-1.5 overflow-y-auto pr-1">
          {entries.map(entry => (
            <li key={entry.id} className="flex items-start gap-2 text-[12px]" style={{ color: 'var(--text-dim)' }}>
              {entry.status === 'running' ? (
                <span className="spinner mt-0.5 shrink-0" />
              ) : entry.status === 'error' ? (
                <IconAlert size={13} className="mt-0.5 shrink-0" style={{ color: 'var(--warn)' }} />
              ) : (
                <IconCheck size={13} className="mt-0.5 shrink-0" style={{ color: 'var(--mint)' }} />
              )}
              <span className={entry.status === 'running' ? '' : 'opacity-70'}>{entry.text}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
