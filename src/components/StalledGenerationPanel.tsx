import { useState } from 'react'
import { AI_PROVIDERS, type AIProvider } from '../context/SettingsContext'
import type { AIModel } from '../services/aiService'
import { IconAlert, IconSpark } from './Icons'

// Shown when a run stalls partway (rate limit, transient provider failure).
// Nothing already completed is lost: picking a different model and resuming
// continues from the exact chunk that failed rather than starting over.

export interface ProviderOption {
  id: AIProvider
  label: string
  models: AIModel[]
}

const STAGE_LABEL: Record<'plan' | 'generate' | 'fast', string> = {
  plan: 'coverage planning',
  generate: 'test case generation',
  fast: 'test case generation'
}

export default function StalledGenerationPanel({
  stage,
  message,
  completedCases,
  currentProvider,
  currentModel,
  providerOptions,
  autoFailoverTried,
  busy,
  onResume,
  onDiscard
}: {
  stage: 'plan' | 'generate' | 'fast'
  message: string
  completedCases: number
  currentProvider: AIProvider
  currentModel: string
  providerOptions: ProviderOption[]
  autoFailoverTried: string[]
  busy: boolean
  onResume: (provider: AIProvider, model: string) => void
  onDiscard: () => void
}) {
  const [provider, setProvider] = useState<AIProvider>(currentProvider)
  const [model, setModel] = useState(currentModel)

  const options = providerOptions.filter(p => p.models.length > 0)
  const models = options.find(p => p.id === provider)?.models || []

  return (
    <div className="panel rise p-4" style={{ borderColor: 'var(--warn-line)' }}>
      <div className="flex items-start gap-2">
        <IconAlert size={16} className="mt-0.5 shrink-0" style={{ color: 'var(--warn)' }} />
        <div className="min-w-0 flex-1">
          <h3 className="text-[14px] font-semibold">Generation stalled during {STAGE_LABEL[stage]}</h3>
          <p className="mt-1 text-[12px]" style={{ color: 'var(--text-dim)' }}>
            {message}
          </p>
          <p className="mt-1.5 text-[11px]" style={{ color: 'var(--text-faint)' }}>
            {completedCases > 0
              ? `${completedCases} test case(s) are already complete and safe — resuming continues from the exact point that failed.`
              : 'Nothing completed yet — resuming restarts this stage.'}
          </p>
          {autoFailoverTried.length > 0 && (
            <p className="mt-1.5 text-[11px]" style={{ color: 'var(--text-faint)' }}>
              Already tried automatically: {autoFailoverTried.join(', ')}
            </p>
          )}
        </div>
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <label className="block">
          <span className="eyebrow">Provider</span>
          <select
            className="field mt-1.5"
            value={provider}
            disabled={busy}
            onChange={e => {
              const next = e.target.value as AIProvider
              setProvider(next)
              setModel(options.find(p => p.id === next)?.models[0]?.id || '')
            }}
          >
            {options.map(p => (
              <option key={p.id} value={p.id}>
                {AI_PROVIDERS.find(x => x.id === p.id)?.label || p.id}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="eyebrow">Model</span>
          <select className="field mt-1.5" value={model} disabled={busy} onChange={e => setModel(e.target.value)}>
            {models.map(m => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="mt-3 flex gap-2">
        <button className="btn btn-primary btn-sm" onClick={() => onResume(provider, model)} disabled={busy || !model}>
          {busy ? <span className="spinner" /> : <IconSpark size={13} />}
          Resume from checkpoint
        </button>
        <button className="btn btn-sm" onClick={onDiscard} disabled={busy}>
          Discard run
        </button>
      </div>
    </div>
  )
}
