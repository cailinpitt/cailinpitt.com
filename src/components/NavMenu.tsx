import { useEffect, useRef } from 'react'
import { NavLink, useLocation } from 'react-router-dom'

/**
 * A disclosure in the primary nav, grouping pages that belong together.
 *
 * Built on <details>, so it opens and closes with no JavaScript at all — which
 * matters here, because the nav is in the prerendered HTML of every page and a
 * menu that needs a hydrated bundle to open is a menu that doesn't work yet.
 * <summary> also brings the button role, the expanded/collapsed announcement,
 * and keyboard activation, none of which is worth reimplementing.
 *
 * What JavaScript adds is only the polish a real dropdown is expected to have:
 * closing on navigation, on Escape, and on a click elsewhere.
 */
export interface NavMenuItem {
  to: string
  label: string
}

export function NavMenu({ label, items }: { label: string; items: NavMenuItem[] }) {
  const ref = useRef<HTMLDetailsElement>(null)
  const { pathname } = useLocation()
  /** Whether the page being viewed is one of the menu's own. */
  const holdsCurrent = items.some((item) => item.to === pathname)

  // Clicking a link inside a <details> navigates but leaves the panel open,
  // so it would hang over the page that was just opened.
  useEffect(() => {
    if (ref.current) ref.current.open = false
  }, [pathname])

  useEffect(() => {
    const close = () => {
      if (ref.current) ref.current.open = false
    }
    const onPointerDown = (event: PointerEvent) => {
      const el = ref.current
      if (el?.open && !el.contains(event.target as Node)) close()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !ref.current?.open) return
      close()
      // Focus would otherwise be left inside a panel that is no longer there.
      ref.current.querySelector('summary')?.focus()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  return (
    <li className="nav-menu">
      <details ref={ref}>
        {/* aria-current on the summary for the same reason NavLink puts it on a
            link: the section you're in should look like the section you're in,
            even when the page itself is one level down. */}
        <summary aria-current={holdsCurrent ? 'page' : undefined}>
          {label}
          <svg
            className="nav-menu-chevron"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </summary>
        <ul className="nav-menu-panel">
          {items.map((item) => (
            <li key={item.to}>
              <NavLink to={item.to}>{item.label}</NavLink>
            </li>
          ))}
        </ul>
      </details>
    </li>
  )
}
