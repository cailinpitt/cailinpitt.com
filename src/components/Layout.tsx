import { Link, NavLink, Outlet, ScrollRestoration, useLocation } from 'react-router-dom'
import { ThemeToggle } from './ThemeToggle'
import { galleryDefinitions } from '../lib/galleries'

export function Layout() {
  const { pathname } = useLocation()
  const photosActive =
    pathname === '/photos' || galleryDefinitions.some((gallery) => gallery.path === pathname)

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
              <NavLink to="/blog">Blog</NavLink>
            </li>
            <li>
              <ThemeToggle />
            </li>
          </ul>
        </nav>
      </header>

      <main id="main" className="site-main">
        <Outlet />
      </main>

      <footer className="site-footer">
        <p>
          © {new Date().getFullYear()} Cailin Pitt · <Link to="/privacy">Privacy</Link>
        </p>
        <ul className="social-links">
          <li>
            <a href="https://github.com/CailinPitt" rel="me">
              GitHub
            </a>
          </li>
        </ul>
      </footer>
    </>
  )
}
