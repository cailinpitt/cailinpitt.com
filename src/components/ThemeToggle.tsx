import { useEffect, useState } from 'react'

// Manual color-theme control: a header button toggles between Light and Dark.
// The choice is stored in localStorage and applied as `data-theme` on <html>; the
// CSS variables key off `:root[data-theme=...]`. First-time visitors (no stored
// choice) follow their OS `prefers-color-scheme` until they pick one. A tiny inline
// script in index.html applies a stored choice before first paint (avoids FOUC).
type Theme = 'light' | 'dark'

function storedOrSystemTheme(): Theme {
  try {
    const saved = localStorage.getItem('theme')
    if (saved === 'light' || saved === 'dark') return saved
  } catch {
    /* localStorage unavailable */
  }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
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

export function ThemeToggle() {
  // Start as 'light' so the server-rendered and first client render match (no
  // hydration mismatch); the real value is resolved after mount.
  const [theme, setTheme] = useState<Theme>('light')

  useEffect(() => {
    setTheme(storedOrSystemTheme())
  }, [])

  function toggle() {
    const next: Theme = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    document.documentElement.dataset.theme = next
    try {
      localStorage.setItem('theme', next)
    } catch {
      /* ignore persistence failure */
    }
  }

  const label = `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`
  return (
    <button type="button" className="theme-toggle" onClick={toggle} aria-label={label} title={label}>
      {/* Show the icon for the theme you'll switch to. */}
      <span aria-hidden="true">{theme === 'dark' ? SUN : MOON}</span>
    </button>
  )
}
