import { IconAlert, IconClose } from './Icons'

// Fixed to the viewport rather than living inline in the sidebar: an inline
// error at the bottom of a long, independently-scrolling column is easy to
// miss entirely — especially when the action that triggered it (e.g.
// "Generate automation suite") lives in the right-hand pane, nowhere near
// where the message appeared. A toast is visible regardless of scroll
// position or which tab is active.
export default function ErrorToast({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div className="fixed inset-x-4 bottom-4 z-40 sm:inset-x-auto sm:right-4 sm:w-[380px]">
      <div
        role="alert"
        aria-live="assertive"
        className="rise flex items-start gap-2 rounded-lg border p-3 text-[12px] shadow-lg"
        style={{ borderColor: 'var(--err-line)', background: 'var(--bg-raised)' }}
      >
        <span
          className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full"
          style={{ background: 'var(--err-dim)', color: 'var(--err)' }}
        >
          <IconAlert size={12} />
        </span>
        <span className="flex-1 pt-0.5" style={{ color: 'var(--text)' }}>
          {message}
        </span>
        <button className="btn btn-ghost btn-sm shrink-0 p-1" onClick={onDismiss} aria-label="Dismiss error">
          <IconClose size={12} />
        </button>
      </div>
    </div>
  )
}
