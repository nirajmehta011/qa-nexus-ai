import { AI_PROVIDERS, useSettings } from '../context/SettingsContext'
import type { Theme } from '../hooks/useTheme'
import { IconLayers, IconSettings } from './Icons'

const IconSun = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
    <circle cx="8" cy="8" r="3" />
    <path d="M8 1v1.6M8 13.4V15M15 8h-1.6M2.6 8H1M12.9 3.1l-1.1 1.1M4.2 11.8l-1.1 1.1M12.9 12.9l-1.1-1.1M4.2 4.2L3.1 3.1" />
  </svg>
)

const IconMoon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M13.5 9.6A5.8 5.8 0 016.4 2.5a5.8 5.8 0 107.1 7.1z" />
  </svg>
)

export default function Header({
  theme,
  onToggleTheme,
  onOpenSettings
}: {
  theme: Theme
  onToggleTheme: () => void
  onOpenSettings: () => void
}) {
  const { settings, activeApiKey, activeModel } = useSettings()
  const providerLabel = AI_PROVIDERS.find(p => p.id === settings.ai.provider)?.label || settings.ai.provider
  const configured = Boolean(activeApiKey)

  return (
    <header
      className="sticky top-0 z-30 border-b backdrop-blur-md"
      style={{ borderColor: 'var(--border)', background: 'color-mix(in srgb, var(--bg-base) 82%, transparent)' }}
    >
      <div className="mx-auto flex h-14 max-w-[1560px] items-center gap-3 px-4 sm:px-6">
        <div
          className="flex h-8 w-8 items-center justify-center rounded-lg"
          style={{ background: 'var(--accent-dim)', border: '1px solid var(--accent-line)', color: 'var(--accent-hi)' }}
        >
          <IconLayers />
        </div>
        <div className="min-w-0">
          <h1 className="truncate text-[15px] font-semibold leading-tight">QA Nexus AI</h1>
          <p className="hidden text-[11px] leading-tight sm:block" style={{ color: 'var(--text-faint)' }}>
            Specification → test cases → framework-aware Playwright suite
          </p>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <button
            className="chip hover:opacity-80"
            onClick={onOpenSettings}
            title={configured ? `${providerLabel} · ${activeModel}` : 'No API key configured'}
          >
            <span
              className={configured ? 'live-dot' : ''}
              style={{
                width: 6,
                height: 6,
                borderRadius: 999,
                background: configured ? 'var(--ok)' : 'var(--err)',
                display: 'inline-block'
              }}
            />
            <span className="hidden sm:inline">{providerLabel}</span>
            <span className="mono hidden max-w-[140px] truncate md:inline" style={{ color: 'var(--text-faint)' }}>
              {configured ? activeModel : 'not configured'}
            </span>
          </button>

          <button
            className="btn btn-ghost btn-sm"
            onClick={onToggleTheme}
            aria-label={theme === 'midnight' ? 'Switch to Claude Light theme' : 'Switch to Claude Dark theme'}
            title={theme === 'midnight' ? 'Claude Light (Oatmeal)' : 'Claude Dark (Espresso)'}
          >
            {theme === 'midnight' ? <IconSun /> : <IconMoon />}
          </button>

          <button className="btn btn-sm" onClick={onOpenSettings}>
            <IconSettings size={14} />
            <span className="hidden sm:inline">Settings</span>
          </button>
        </div>
      </div>
    </header>
  )
}
