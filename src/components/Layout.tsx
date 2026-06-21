import { Link, Outlet } from 'react-router-dom'
import { ThemeToggle } from './ThemeToggle'

export function Layout() {
  return (
    <>
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
              <Link to="/photos">Photos</Link>
            </li>
            <li>
              <Link to="/blog">Blog</Link>
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
