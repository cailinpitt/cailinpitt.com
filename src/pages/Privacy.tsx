import { Seo } from '../components/Seo'
import { pageSchema } from '../lib/structuredData'

export function Component() {
  return (
    <>
      <Seo
        title="Privacy"
        description="How cailinpitt.com handles your data: cookieless, privacy-first analytics and nothing else."
        path="/privacy"
        jsonLd={pageSchema({
          path: '/privacy',
          title: 'Privacy',
          description:
            'How cailinpitt.com handles your data: cookieless, privacy-first analytics and nothing else.',
        })}
      />
      <article className="post">
        <header className="post-header">
          <h1>Privacy</h1>
          <p className="post-date">Last updated: August 1, 2026</p>
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

          <h2>Guestbook</h2>
          <p>
            The <a href="/guestbook">guestbook</a> is the only part of this site that asks
            you for anything. What you type into it — your name, your message, and the
            website and location if you fill them in — is published on that page for
            anyone to read, so please don&rsquo;t put anything there you wouldn&rsquo;t
            want public. No email address is asked for and none is stored.
          </p>
          <p>
            Two things are recorded that you don&rsquo;t type. Your country, as
            Cloudflare reports it from your connection, is stored so entries can show a
            flag. And your IP address is stored <em>only</em> as a salted hash — a
            one-way scramble that can&rsquo;t be turned back into an address — which
            exists purely to notice when one source is posting dozens of entries. The
            address itself is never written down. The form is protected by{' '}
            <a href="https://www.cloudflare.com/products/turnstile/" rel="noreferrer">
              Cloudflare Turnstile
            </a>
            , a cookieless CAPTCHA alternative; its script loads only if you start
            filling in the form, never for people who are just reading.
          </p>
          <p>
            Want an entry taken down? Ask via the contact link below and I&rsquo;ll
            delete it — no questions, no verification hoops.
          </p>

          <h2>Contact</h2>
          <p>
            Questions about privacy? Open an issue on{' '}
            <a href="https://github.com/CailinPitt/cailinpitt.com/issues" rel="noreferrer">
              the GitHub repository
            </a>
            .
          </p>
        </div>
      </article>
    </>
  )
}
