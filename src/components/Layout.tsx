import { useCallback, useState } from 'react'
import { Link, NavLink, Outlet, ScrollRestoration, useLocation } from 'react-router-dom'
import { CommandPalette, CommandPaletteTrigger } from './CommandPalette'
import { NavMenu } from './NavMenu'
import { ThemeToggle } from './ThemeToggle'

export function Layout() {
  const { pathname, hash } = useLocation()
  const photosActive = pathname === '/photos' || pathname.startsWith('/photos/')

  // A single note (/notes#<id>) gets no header/footer — nothing to distract
  // from the one thing you were sent to read. Hash check, not its own route,
  // since a note has no route of its own — see notePath() in src/lib/notes.ts.
  const minimal = pathname === '/notes' && hash.length > 1

  // The palette's trigger belongs in the nav and its dialog does not, so the open
  // state is held here rather than inside either half.
  const [paletteOpen, setPaletteOpen] = useState(false)
  const openPalette = useCallback(() => setPaletteOpen(true), [])
  const closePalette = useCallback(() => setPaletteOpen(false), [])

  return (
    <>
      {/* React Router's data router doesn't reset scroll on navigation by default. */}
      <ScrollRestoration />
      {!minimal && (
        <a className="skip-link" href="#main">
          Skip to content
        </a>
      )}
      {!minimal && (
        <header className="site-header">
          {/* Two rows, deliberately: the utility buttons used to wrap along with
              nav-links and end up stranded on their own row as pages were added. */}
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
                  { to: '/about', label: 'About' },
                  { to: '/now', label: 'Now' },
                  { to: '/uses', label: 'Uses' },
                ]}
              />
              <NavMenu
                label="Logs"
                items={[
                  { to: '/listening', label: 'Listening' },
                  { to: '/watching', label: 'Watching' },
                  { to: '/moving', label: 'Moving' },
                ]}
              />
              <NavMenu
                label="Reading"
                items={[
                  { to: '/reading', label: 'Books' },
                  { to: '/reading/articles', label: 'Articles' },
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
                <NavLink to="/blog">Blog</NavLink>
              </li>
              {/* Next to Blog, not in Logs: Notes is writing, not an activity feed,
                  even though it's Worker-backed too. */}
              <li>
                <NavLink to="/notes">Notes</NavLink>
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
      )}

      <CommandPalette open={paletteOpen} onOpen={openPalette} onClose={closePalette} />

      <main id="main" className={minimal ? 'site-main is-minimal' : 'site-main'}>
        <Outlet />
      </main>

      {!minimal && (
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
      )}
    </>
  )
}
