import { useEffect, useRef } from 'react'
import { NavLink, useLocation } from 'react-router-dom'

// Built on <details>: opens/closes with no JS, which matters since the nav is
// in prerendered HTML — <summary> also gives button role, expanded/collapsed
// announcement, and keyboard activation for free. JS only adds dropdown
// polish: closing on navigation, Escape, or an outside click.
export interface NavMenuItem {
  to: string
  label: string
}

export function NavMenu({ label, items }: { label: string; items: NavMenuItem[] }) {
  const ref = useRef<HTMLDetailsElement>(null)
  const { pathname } = useLocation()
  const holdsCurrent = items.some((item) => item.to === pathname)

  // Clicking a link inside <details> navigates but leaves the panel open, so
  // it would hang over the page that was just opened.
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
        {/* Same reason NavLink puts aria-current on a link: the section
            you're in should look like it, even a level down. */}
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
