import { useState } from 'react'
import { AI_PROVIDERS, useSettings, type AIProvider } from '../context/SettingsContext'
import aiService, { type AIModel } from '../services/aiService'
import jiraService from '../services/jiraService'
import { IconCheck, IconClose, IconAlert } from './Icons'

// API keys live only in the browser (localStorage) and travel to the provider
// through our own proxy per request — nothing is stored server-side.

type TestState = { status: 'idle' | 'testing' | 'ok' | 'error'; message: string }

export default function SettingsPanel({ onClose }: { onClose: () => void }) {
  const { settings, updateAI, updateJira, clearSettings } = useSettings()
  const [tests, setTests] = useState<Record<string, TestState>>({})
  const [jiraTest, setJiraTest] = useState<TestState>({ status: 'idle', message: '' })

  const setTest = (id: string, state: TestState) => setTests(prev => ({ ...prev, [id]: state }))

  const testProvider = async (provider: AIProvider, keyField: keyof typeof settings.ai, modelField: keyof typeof settings.ai) => {
    const apiKey = (settings.ai[keyField] as string) || ''
    if (!apiKey.trim()) {
      setTest(provider, { status: 'error', message: 'Enter an API key first.' })
      return
    }
    setTest(provider, { status: 'testing', message: 'Connecting…' })
    const result = await aiService.testConnection(provider, apiKey.trim())
    if (result.success) {
      const models: AIModel[] = result.models?.length ? result.models : aiService.getDefaultModels(provider)
      const currentModel = settings.ai[modelField] as string
      updateAI({
        loadedModels: { ...settings.ai.loadedModels, [provider]: models },
        // Keep the user's model if the account still offers it, else take the first.
        ...(models.some(m => m.id === currentModel) ? {} : { [modelField]: models[0]?.id || currentModel })
      })
    }
    setTest(provider, { status: result.success ? 'ok' : 'error', message: result.message })
  }

  const testJira = async () => {
    const { email, token, baseUrl } = settings.jira
    if (!email || !token || !baseUrl) {
      setJiraTest({ status: 'error', message: 'Email, token and base URL are all required.' })
      return
    }
    setJiraTest({ status: 'testing', message: 'Connecting…' })
    jiraService.initialize(email, token, baseUrl)
    const result = await jiraService.testConnection()
    setJiraTest({ status: result.success ? 'ok' : 'error', message: result.message })
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4 backdrop-blur-sm sm:p-8"
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      onMouseDown={e => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="panel rise w-full max-w-2xl overflow-hidden">
        <header className="flex items-center justify-between border-b px-5 py-4" style={{ borderColor: 'var(--border)' }}>
          <div>
            <h2 className="text-[15px] font-semibold">Settings</h2>
            <p className="text-xs" style={{ color: 'var(--text-faint)' }}>
              Keys are stored in this browser only and proxied per request — never persisted on the server.
            </p>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close settings">
            <IconClose />
          </button>
        </header>

        <div className="max-h-[70vh] space-y-6 overflow-y-auto px-5 py-5">
          <section>
            <div className="eyebrow mb-3">AI provider</div>
            <div className="segmented mb-4">
              {AI_PROVIDERS.map(p => (
                <button
                  key={p.id}
                  aria-pressed={settings.ai.provider === p.id}
                  onClick={() => updateAI({ provider: p.id })}
                >
                  {p.label}
                </button>
              ))}
            </div>

            {AI_PROVIDERS.filter(p => p.id === settings.ai.provider).map(p => {
              const test = tests[p.id] || { status: 'idle', message: '' }
              const models = settings.ai.loadedModels[p.id] || aiService.getDefaultModels(p.id)
              return (
                <div key={p.id} className="space-y-3">
                  <label className="block">
                    <span className="eyebrow">{p.label} API key</span>
                    <div className="mt-1.5 flex gap-2">
                      <input
                        type="password"
                        className="field mono"
                        placeholder="Paste your API key"
                        autoComplete="off"
                        value={(settings.ai[p.keyField] as string) || ''}
                        onChange={e => updateAI({ [p.keyField]: e.target.value } as any)}
                      />
                      <button
                        className="btn btn-sm"
                        onClick={() => testProvider(p.id, p.keyField, p.modelField)}
                        disabled={test.status === 'testing'}
                      >
                        {test.status === 'testing' ? <span className="spinner" /> : null}
                        Test &amp; load
                      </button>
                    </div>
                    <span className="mt-1 block text-[11px]" style={{ color: 'var(--text-faint)' }}>
                      {p.hint}
                    </span>
                  </label>

                  {test.status !== 'idle' && test.status !== 'testing' && (
                    <p
                      className="flex items-center gap-1.5 text-xs"
                      style={{ color: test.status === 'ok' ? 'var(--ok)' : 'var(--err)' }}
                    >
                      {test.status === 'ok' ? <IconCheck size={13} /> : <IconAlert size={13} />}
                      {test.message}
                    </p>
                  )}

                  <label className="block">
                    <span className="eyebrow">Model</span>
                    <select
                      className="field mt-1.5"
                      value={(settings.ai[p.modelField] as string) || ''}
                      onChange={e => updateAI({ [p.modelField]: e.target.value } as any)}
                    >
                      {models.map(m => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              )
            })}
          </section>

          <section className="border-t pt-5" style={{ borderColor: 'var(--border)' }}>
            <div className="eyebrow mb-3">Jira (optional — only needed for the Jira ID input)</div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block sm:col-span-2">
                <span className="eyebrow">Base URL</span>
                <input
                  className="field mt-1.5"
                  placeholder="https://your-team.atlassian.net"
                  value={settings.jira.baseUrl}
                  onChange={e => updateJira({ baseUrl: e.target.value })}
                />
              </label>
              <label className="block">
                <span className="eyebrow">Email</span>
                <input
                  className="field mt-1.5"
                  placeholder="you@company.com"
                  autoComplete="off"
                  value={settings.jira.email}
                  onChange={e => updateJira({ email: e.target.value })}
                />
              </label>
              <label className="block">
                <span className="eyebrow">API token</span>
                <input
                  className="field mono mt-1.5"
                  type="password"
                  autoComplete="off"
                  value={settings.jira.token}
                  onChange={e => updateJira({ token: e.target.value })}
                />
              </label>
            </div>
            <div className="mt-3 flex items-center gap-3">
              <button className="btn btn-sm" onClick={testJira} disabled={jiraTest.status === 'testing'}>
                {jiraTest.status === 'testing' ? <span className="spinner" /> : null}
                Test Jira connection
              </button>
              {jiraTest.status !== 'idle' && jiraTest.status !== 'testing' && (
                <span className="text-xs" style={{ color: jiraTest.status === 'ok' ? 'var(--ok)' : 'var(--err)' }}>
                  {jiraTest.message}
                </span>
              )}
            </div>
          </section>
        </div>

        <footer
          className="flex items-center justify-between border-t px-5 py-3"
          style={{ borderColor: 'var(--border)' }}
        >
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => {
              if (confirm('Clear all stored keys and settings from this browser?')) {
                clearSettings()
                setTests({})
                setJiraTest({ status: 'idle', message: '' })
              }
            }}
          >
            Clear stored settings
          </button>
          <button className="btn btn-primary btn-sm" onClick={onClose}>
            Done
          </button>
        </footer>
      </div>
    </div>
  )
}
