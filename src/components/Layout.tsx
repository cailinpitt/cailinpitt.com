import { useCallback, useState } from 'react'
import { Link, NavLink, Outlet, ScrollRestoration, useLocation } from 'react-router-dom'
import { CommandPalette, CommandPaletteTrigger } from './CommandPalette'
import { ThemeToggle } from './ThemeToggle'
import { galleryDefinitions } from '../lib/galleries'

export function Layout() {
  const { pathname } = useLocation()
  const photosActive =
    pathname === '/photos' || galleryDefinitions.some((gallery) => gallery.path === pathname)

  // The palette's trigger belongs in the nav and its dialog does not, so the open
  // state is held here rather than inside either half.
  const [paletteOpen, setPaletteOpen] = useState(false)
  const openPalette = useCallback(() => setPaletteOpen(true), [])
  const closePalette = useCallback(() => setPaletteOpen(false), [])

  return (
    <>
      {/* Reset scroll to top on navigation (and restore it on back/forward). React
          Router's data router doesn't do this automatically. */}
      <ScrollRestoration />
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="site-header">
        <nav className="site-nav" aria-label="Primary">
          <Link to="/" className="site-title">
            Cailin Pitt
          </Link>
          <ul className="nav-links">
            <li>
              <Link to="/photos" aria-current={photosActive ? 'page' : undefined}>
                Photos
              </Link>
            </li>
            <li>
              <NavLink to="/projects">Projects</NavLink>
            </li>
            <li>
              <NavLink to="/listening">Listening</NavLink>
            </li>
            <li>
              <NavLink to="/reading">Reading</NavLink>
            </li>
            <li>
              <NavLink to="/blog">Blog</NavLink>
            </li>
            <li>
              <NavLink to="/timeline">Timeline</NavLink>
            </li>
            <li>
              <CommandPaletteTrigger onClick={openPalette} />
            </li>
            <li>
              <ThemeToggle />
            </li>
          </ul>
        </nav>
      </header>

      <CommandPalette open={paletteOpen} onOpen={openPalette} onClose={closePalette} />

      <main id="main" className="site-main">
        <Outlet />
      </main>

      <footer className="site-footer">
        <p>
          © {new Date().getFullYear()} Cailin Pitt · <Link to="/colophon">Colophon</Link> ·{' '}
          <Link to="/privacy">Privacy</Link>
        </p>
        <ul className="social-links">
          <li>
            <a href="https://github.com/CailinPitt" rel="me">
              GitHub
            </a>
          </li>
          <li>
            <a href="https://iheartrss.com/">I &hearts; RSS</a>
          </li>
        </ul>
      </footer>
    </>
  )
}
