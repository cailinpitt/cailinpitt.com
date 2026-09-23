import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'

/**
 * `.post-source-bar` that collapses into a "More" dropdown on narrow screens.
 * On wide screens the toggle is hidden by CSS and the children sit inline.
 */
export function PostActions({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const { pathname } = useLocation()

  useEffect(() => setOpen(false), [pathname])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setOpen(false)
      ref.current?.querySelector<HTMLButtonElement>('.post-actions-toggle')?.focus()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div className="post-source-bar post-actions" ref={ref} data-open={open}>
      <button
        type="button"
        className="post-actions-toggle"
        aria-expanded={open}
        aria-controls="post-actions-panel"
        onClick={() => setOpen(!open)}
      >
        More
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
      </button>
      <div
        id="post-actions-panel"
        className="post-actions-panel"
        onClick={(event) => {
          if ((event.target as Element).closest('a')) setOpen(false)
        }}
      >
        {children}
      </div>
    </div>
  )
}
