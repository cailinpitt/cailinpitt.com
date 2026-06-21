import { Seo } from '../components/Seo'

export default function Privacy() {
  return (
    <>
      <Seo
        title="Privacy"
        description="How cailinpitt.com handles your data: cookieless, privacy-first analytics and nothing else."
        path="/privacy"
      />
      <article className="post">
        <header className="post-header">
          <h1>Privacy</h1>
          <p className="post-date">Last updated: June 20, 2026</p>
        </header>
        <div className="post-body">
          <p>
            This is a personal website. It sets <strong>no cookies</strong>, runs no advertising,
            and does not sell, share, or sell access to any personal data. There is nothing to log
            in to and no account to create.
          </p>

          <h2>Analytics</h2>
          <p>
            To get a rough sense of which posts people read, this site uses{' '}
            <a href="https://www.cloudflare.com/web-analytics/" rel="noreferrer">
              Cloudflare Web Analytics
            </a>
            , which is privacy-first and cookieless. It does not use cookies or local storage, does
            not fingerprint your browser, and does not track you across other websites. It collects
            only aggregate, anonymized measurements — things like page views, referring sites, and
            general country-level location — and never anything that identifies you personally.
          </p>

          <h2>Hosting</h2>
          <p>
            The site is hosted on <a href="https://pages.github.com/" rel="noreferrer">GitHub Pages</a>{' '}
            with DNS served through <a href="https://www.cloudflare.com/" rel="noreferrer">Cloudflare</a>.
            As with any web host, their servers may process standard request metadata (such as your IP
            address) to deliver pages and protect against abuse. That data is handled under their
            respective privacy policies and is not used by me for tracking.
          </p>

          <h2>Contact</h2>
          <p>
            Questions about privacy? Email{' '}
            <a href="mailto:cailinpitt1@gmail.com">cailinpitt1@gmail.com</a>.
          </p>
        </div>
      </article>
    </>
  )
}
