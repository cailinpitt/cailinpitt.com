import { useEffect, useState, type ReactElement } from 'react'

// Theme cycles System → Light → Dark, stored in localStorage and applied as
// `data-theme` on <html> (CSS keys off `:root[data-theme=...]`); System stores
// nothing so those visitors follow OS `prefers-color-scheme`. An inline script
// in index.html applies the stored choice before first paint to avoid FOUC.
export type Theme = 'system' | 'light' | 'dark'

const ORDER: Theme[] = ['system', 'light', 'dark']

/** Lets the button follow a change it didn't make (the `theme` command in /terminal). */
const THEME_EVENT = 'cailinpitt:themechange'

export function storedTheme(): Theme {
  try {
    const saved = localStorage.getItem('theme')
    if (saved === 'light' || saved === 'dark') return saved
  } catch {
    /* localStorage unavailable */
  }
  return 'system'
}

// The colors index.html shipped, per tag, captured before we overwrite them.
const systemColors = new WeakMap<HTMLMetaElement, string>()

/**
 * index.html's two media-scoped theme-color tags can't see a manual override
 * (Dark forced on a light OS would leave a paper-colored toolbar), so write the
 * resolved --bg into both here. Runs post-mount, not in the pre-paint script,
 * since --bg reads empty before the stylesheet loads.
 */
function syncThemeColor(theme: Theme) {
  const tags = document.head.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')
  for (const tag of tags) {
    if (!systemColors.has(tag)) systemColors.set(tag, tag.content)
  }
  if (theme === 'system') {
    for (const tag of tags) tag.content = systemColors.get(tag) ?? tag.content
    return
  }
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()
  if (!bg) return
  for (const tag of tags) tag.content = bg
}

/** Attribute, chrome tint, and stored preference. The only implementation. */
export function applyTheme(theme: Theme) {
  if (theme === 'system') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = theme
  // After the attribute, so --bg resolves to the theme being applied.
  syncThemeColor(theme)
  try {
    if (theme === 'system') localStorage.removeItem('theme')
    else localStorage.setItem('theme', theme)
  } catch {
    /* ignore persistence failure */
  }
  window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: theme }))
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
    const stored = storedTheme()
    setTheme(stored)
    // The pre-paint script in index.html already set data-theme; this catches up
    // the chrome tint, which it can't do before the stylesheet exists.
    syncThemeColor(stored)
  }, [])

  // Follow changes made elsewhere, e.g. `theme dark` in /terminal.
  useEffect(() => {
    const onChange = (event: Event) => setTheme((event as CustomEvent<Theme>).detail)
    window.addEventListener(THEME_EVENT, onChange)
    return () => window.removeEventListener(THEME_EVENT, onChange)
  }, [])

  const next = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length]

  function cycle() {
    applyTheme(next)
  }

  // State the current theme, not just the next one: the icon alone can't say
  // which of three states is active.
  const label = `Theme: ${theme}. Switch to ${next}.`
  return (
    <button type="button" className="theme-toggle" onClick={cycle} aria-label={label} title={label}>
      {/* Show the icon for the theme that's active, not the next one. */}
      <span aria-hidden="true">{ICON[theme]}</span>
    </button>
  )
}
