import { IconCheck, IconDoc, IconFolder, IconLink, IconSpark } from './Icons'

export interface PipelineStep {
  id: number
  title: string
  subtitle: string
  done: boolean
  active: boolean
  optional?: boolean
}

export default function PipelineRibbon({
  currentStep,
  hasSpec,
  hasFramework,
  groundedCount,
  hasCases,
  isGenerating,
  onSelectStep
}: {
  currentStep: number | null
  hasSpec: boolean
  hasFramework: boolean
  groundedCount: number
  hasCases: boolean
  isGenerating: boolean
  onSelectStep: (step: number) => void
}) {
  const steps: PipelineStep[] = [
    {
      id: 1,
      title: 'Spec Input',
      subtitle: hasSpec ? 'Specification loaded' : 'URL, doc, or Jira',
      done: hasSpec,
      active: currentStep === 1
    },
    {
      id: 2,
      title: 'Framework',
      subtitle: hasFramework ? 'Profile analyzed' : 'POM repo (optional)',
      done: hasFramework,
      active: currentStep === 2,
      optional: true
    },
    {
      id: 3,
      title: 'Grounding',
      subtitle: groundedCount > 0 ? `${groundedCount} selectors` : 'DOM verification',
      done: groundedCount > 0,
      active: currentStep === 3,
      optional: true
    },
    {
      id: 4,
      title: 'Generate',
      subtitle: isGenerating ? 'Generating…' : hasCases ? 'Suite ready' : 'Cases & Playwright',
      done: hasCases,
      active: currentStep === 4 || currentStep === null
    }
  ]

  const getStepIcon = (step: PipelineStep) => {
    if (step.done) return <IconCheck size={13} />
    switch (step.id) {
      case 1:
        return <IconDoc size={13} />
      case 2:
        return <IconFolder size={13} />
      case 3:
        return <IconLink size={13} />
      case 4:
        return <IconSpark size={13} />
      default:
        return <span>{step.id}</span>
    }
  }

  return (
    <nav
      aria-label="Test generation pipeline"
      className="panel mb-4 overflow-x-auto p-1.5"
    >
      <ol className="flex min-w-[620px] items-center gap-1">
        {steps.map((step, idx) => {
          const isDone = step.done
          const isActive = step.active

          return (
            <li key={step.id} className="flex flex-1 items-center">
              <button
                type="button"
                onClick={() => onSelectStep(step.id)}
                className={`group flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left transition-all duration-150 ${
                  isActive
                    ? 'bg-[var(--accent-dim)] border border-[var(--accent-line)] shadow-sm'
                    : 'hover:bg-[var(--bg-hover)] border border-transparent'
                }`}
              >
                <span
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[11px] font-semibold transition-colors"
                  style={{
                    background: isDone
                      ? 'var(--mint-dim)'
                      : isActive
                        ? 'var(--accent)'
                        : 'var(--bg-input)',
                    color: isDone
                      ? 'var(--mint)'
                      : isActive
                        ? 'var(--accent-ink)'
                        : 'var(--text-faint)',
                    border: isDone
                      ? '1px solid var(--mint-line)'
                      : isActive
                        ? '1px solid var(--accent)'
                        : '1px solid var(--border)'
                  }}
                >
                  {getStepIcon(step)}
                </span>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span
                      className={`text-[12px] font-semibold leading-tight truncate ${
                        isActive ? 'text-[var(--accent-hi)]' : 'text-[var(--text)]'
                      }`}
                    >
                      {step.id}. {step.title}
                    </span>
                    {step.optional && !isDone && (
                      <span className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] opacity-70">
                        opt
                      </span>
                    )}
                  </div>
                  <span
                    className="block truncate text-[11px] leading-tight mt-0.5"
                    style={{ color: isDone ? 'var(--mint)' : 'var(--text-faint)' }}
                  >
                    {step.subtitle}
                  </span>
                </div>
              </button>

              {idx < steps.length - 1 && (
                <div
                  className="mx-1 h-4 w-[1px] shrink-0 opacity-40"
                  style={{ background: 'var(--border-strong)' }}
                  aria-hidden="true"
                />
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
