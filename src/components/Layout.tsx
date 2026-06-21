import { Link, Outlet } from 'react-router-dom'

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
              <Link to="/">Work</Link>
            </li>
            <li>
              <Link to="/past-work">Past Work</Link>
            </li>
            <li>
              <Link to="/blog">Blog</Link>
            </li>
          </ul>
        </nav>
      </header>

      <main id="main" className="site-main">
        <Outlet />
      </main>

      <footer className="site-footer">
        <p>© {new Date().getFullYear()} Cailin Pitt</p>
        <ul className="social-links">
          <li>
            <a href="https://instagram.com/cailinpitt" rel="me">
              Instagram
            </a>
          </li>
          <li>
            <a href="https://github.com/CailinPitt" rel="me">
              GitHub
            </a>
          </li>
          <li>
            <a href="https://bsky.app/profile/cailinpitt.com" rel="me">
              Bluesky
            </a>
          </li>
        </ul>
      </footer>
    </>
  )
}
