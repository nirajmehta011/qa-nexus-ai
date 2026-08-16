import { useCallback, useEffect, useState } from 'react'

// Two themes: "latte" (warm cream, coffee text) and "midnight" (near-black).
// The choice is applied as data-theme on <html>, which is also what the inline
// script in index.html sets before first paint so the page never flashes.

export type Theme = 'latte' | 'midnight'

export const THEME_STORAGE_KEY = 'qa_nexus_theme'

function readStoredTheme(): Theme | null {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY)
    return stored === 'latte' || stored === 'midnight' ? stored : null
  } catch {
    return null
  }
}

function systemTheme(): Theme {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches
    ? 'midnight'
    : 'latte'
}

function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme === 'midnight' ? 'dark' : 'light'
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(() => readStoredTheme() ?? systemTheme())

  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  // Follow the OS until the user makes an explicit choice.
  useEffect(() => {
    if (readStoredTheme()) return
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (e: MediaQueryListEvent) => setThemeState(e.matches ? 'midnight' : 'latte')
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next)
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next)
    } catch {
      // Private browsing can reject writes; the in-memory choice still applies.
    }
  }, [])

  const toggleTheme = useCallback(
    () => setTheme(theme === 'midnight' ? 'latte' : 'midnight'),
    [theme, setTheme]
  )

  return { theme, setTheme, toggleTheme }
}
