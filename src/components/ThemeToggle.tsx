import { useEffect, useState, type ReactElement } from 'react'

// Manual color-theme control: a header button cycles System → Light → Dark.
// The choice is stored in localStorage and applied as `data-theme` on <html>; the
// CSS variables key off `:root[data-theme=...]`. System stores nothing and sets no
// attribute, so those visitors follow their OS `prefers-color-scheme` — and can get
// back to it, which a two-state toggle can't offer. A tiny inline script in
// index.html applies a stored choice before first paint (avoids FOUC).
type Theme = 'system' | 'light' | 'dark'

const ORDER: Theme[] = ['system', 'light', 'dark']

function storedTheme(): Theme {
  try {
    const saved = localStorage.getItem('theme')
    if (saved === 'light' || saved === 'dark') return saved
  } catch {
    /* localStorage unavailable */
  }
  return 'system'
}

function apply(theme: Theme) {
  if (theme === 'system') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = theme
  try {
    if (theme === 'system') localStorage.removeItem('theme')
    else localStorage.setItem('theme', theme)
  } catch {
    /* ignore persistence failure */
  }
}

const SUN = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
  </svg>
)
const MOON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
  </svg>
)
const SYSTEM = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="4" width="20" height="13" rx="2" />
    <path d="M8 21h8M12 17v4" />
  </svg>
)

const ICON: Record<Theme, ReactElement> = { system: SYSTEM, light: SUN, dark: MOON }

export function ThemeToggle() {
  // Start on 'system' so the server-rendered and first client render match (no
  // hydration mismatch); the stored choice is resolved after mount.
  const [theme, setTheme] = useState<Theme>('system')

  useEffect(() => {
    setTheme(storedTheme())
  }, [])

  const next = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length]

  function cycle() {
    setTheme(next)
    apply(next)
  }

  // Say where you are as well as where you're going: with three states the icon
  // alone can't convey which one is currently in effect.
  const label = `Theme: ${theme}. Switch to ${next}.`
  return (
    <button type="button" className="theme-toggle" onClick={cycle} aria-label={label} title={label}>
      {/* Show the icon for the theme that's active, not the next one. */}
      <span aria-hidden="true">{ICON[theme]}</span>
    </button>
  )
}
