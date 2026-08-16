import { createContext, useContext, useState, ReactNode, useEffect } from 'react'

export type AIProvider = 'groq' | 'openrouter' | 'gemini' | 'openai'

export const AI_PROVIDERS: { id: AIProvider; label: string; keyField: keyof Settings['ai']; modelField: keyof Settings['ai']; hint: string }[] = [
  { id: 'groq', label: 'Groq', keyField: 'groqApiKey', modelField: 'groqModel', hint: 'console.groq.com/keys — free tier' },
  { id: 'gemini', label: 'Google Gemini', keyField: 'geminiApiKey', modelField: 'geminiModel', hint: 'aistudio.google.com/apikey — free tier' },
  { id: 'openai', label: 'OpenAI', keyField: 'openAiApiKey', modelField: 'openAiModel', hint: 'platform.openai.com/api-keys' },
  { id: 'openrouter', label: 'OpenRouter', keyField: 'openRouterApiKey', modelField: 'openRouterModel', hint: 'openrouter.ai/keys' }
]

export interface Settings {
  jira: {
    email: string
    token: string
    baseUrl: string
  }
  ai: {
    provider: AIProvider
    groqApiKey: string
    openRouterApiKey: string
    geminiApiKey: string
    openAiApiKey: string
    groqModel: string
    openRouterModel: string
    geminiModel: string
    openAiModel: string
    // Live model lists fetched via "Test & load models", keyed by provider.
    // Shape matches aiService.AIModel; inlined to avoid a circular import
    // (aiService already imports AIProvider from this module).
    loadedModels: Partial<Record<AIProvider, { id: string; name: string }[]>>
  }
  preferences: {
    /** Run the second-pass LLM judge that scores each generated case. */
    confidenceScoring: boolean
    testCaseCount: number
    /** Deep analysis: requirement extraction, human review, coverage planning, critique. */
    deepMode: boolean
    /** On a stall, retry the remaining work on other configured providers first. */
    autoFailover: boolean
  }
}

interface SettingsContextType {
  settings: Settings
  updateAI: (fields: Partial<Settings['ai']>) => void
  updateJira: (fields: Partial<Settings['jira']>) => void
  updatePreferences: (fields: Partial<Settings['preferences']>) => void
  clearSettings: () => void
  /** API key for the currently selected provider, '' when unset. */
  activeApiKey: string
  /** Model id for the currently selected provider, '' when unset. */
  activeModel: string
}

const SettingsContext = createContext<SettingsContextType | undefined>(undefined)

const STORAGE_KEY = 'qa_nexus_settings_v1'

const defaultSettings: Settings = {
  jira: { email: '', token: '', baseUrl: '' },
  ai: {
    provider: 'gemini',
    groqApiKey: '',
    openRouterApiKey: '',
    geminiApiKey: '',
    openAiApiKey: '',
    groqModel: 'llama-3.3-70b-versatile',
    openRouterModel: 'openai/gpt-4o',
    geminiModel: 'gemini-flash-latest',
    openAiModel: 'gpt-4o',
    loadedModels: {}
  },
  preferences: { confidenceScoring: true, testCaseCount: 12, deepMode: false, autoFailover: true }
}

export function keyFieldFor(provider: AIProvider): keyof Settings['ai'] {
  return AI_PROVIDERS.find(p => p.id === provider)!.keyField
}

export function modelFieldFor(provider: AIProvider): keyof Settings['ai'] {
  return AI_PROVIDERS.find(p => p.id === provider)!.modelField
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(defaultSettings)

  const save = (s: Settings) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
    } catch (error) {
      // Quota or private-browsing failures must not break the running session.
      console.error('Failed to persist settings:', error)
    }
  }

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (!stored) return
    try {
      const parsed = JSON.parse(stored)
      setSettings(prev => ({
        ...prev,
        ...parsed,
        ai: { ...prev.ai, ...parsed.ai },
        jira: { ...prev.jira, ...parsed.jira },
        preferences: { ...prev.preferences, ...parsed.preferences }
      }))
    } catch (error) {
      console.error('Failed to load settings:', error)
    }
  }, [])

  const updateSection = <K extends keyof Settings>(section: K) => (fields: Partial<Settings[K]>) => {
    setSettings(prev => {
      const updated = { ...prev, [section]: { ...prev[section], ...fields } }
      save(updated)
      return updated
    })
  }

  const clearSettings = () => {
    setSettings(defaultSettings)
    localStorage.removeItem(STORAGE_KEY)
  }

  const activeApiKey = (settings.ai[keyFieldFor(settings.ai.provider)] as string) || ''
  const activeModel = (settings.ai[modelFieldFor(settings.ai.provider)] as string) || ''

  return (
    <SettingsContext.Provider
      value={{
        settings,
        updateAI: updateSection('ai'),
        updateJira: updateSection('jira'),
        updatePreferences: updateSection('preferences'),
        clearSettings,
        activeApiKey,
        activeModel
      }}
    >
      {children}
    </SettingsContext.Provider>
  )
}

export function useSettings() {
  const context = useContext(SettingsContext)
  if (!context) {
    throw new Error('useSettings must be used within SettingsProvider')
  }
  return context
}
