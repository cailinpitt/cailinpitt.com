import { useCallback, useState } from 'react'
import { Link, NavLink, Outlet, ScrollRestoration, useLocation } from 'react-router-dom'
import { CommandPalette, CommandPaletteTrigger } from './CommandPalette'
import { NavMenu } from './NavMenu'
import { ThemeToggle } from './ThemeToggle'

export function Layout() {
  const { pathname } = useLocation()
  const photosActive = pathname === '/photos' || pathname.startsWith('/photos/')

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
        {/* Two rows, deliberately. The utility buttons used to be the last two
            items of nav-links, which meant they wrapped along with the page
            links — so every page added shoved them further, and they ended up
            stranded on a row of their own. Keeping them on the title row
            instead means the link list is the only thing that grows, and it is
            the one part designed to wrap. */}
        <nav className="site-nav" aria-label="Primary">
          <div className="site-nav-top">
            <Link to="/" className="site-title">
              Cailin Pitt
            </Link>
            <div className="site-nav-controls">
              <CommandPaletteTrigger onClick={openPalette} />
              <ThemeToggle />
            </div>
          </div>
          <ul className="nav-links">
            <NavMenu
              label="Me"
              items={[
                { to: '/now', label: 'Now' },
                { to: '/uses', label: 'Uses' },
              ]}
            />
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
              <NavLink to="/guestbook">Guestbook</NavLink>
            </li>
            <li>
              <NavLink to="/terminal">Terminal</NavLink>
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
