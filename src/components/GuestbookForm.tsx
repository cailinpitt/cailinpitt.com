import { useCallback, useEffect, useRef, useState } from 'react'
import {
  LIMITS,
  SignError,
  signGuestbook,
  TURNSTILE_SITE_KEY,
  type Entry,
} from '../lib/guestbook'

/**
 * The sign-the-guestbook form.
 *
 * Three things here are less obvious than they look:
 *
 * 1. **Turnstile loads late.** The challenge script is injected the first time
 *    someone interacts with the form, not on page load. Most people who open
 *    /guestbook are there to read it, and they should not pay for a third-party
 *    script to do that — the page has no other external requests and shouldn't
 *    grow one for a form nobody touched.
 *
 * 2. **Submitting can outrun the token.** If the widget hasn't produced one yet,
 *    the submission is held and fires from the token callback instead of making
 *    the person press the button twice. `pendingSubmit` is that latch.
 *
 * 3. **The honeypot is invisible to people, not just to sighted people.** It is
 *    `aria-hidden`, untabbable, and `autocomplete="off"`, so no screen reader
 *    announces it and no password manager fills it. Only something walking the
 *    DOM and filling every input will — which is exactly what it detects.
 */

// The widget's own global, loaded by the injected script.
declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, opts: Record<string, unknown>) => string
      reset: (id?: string) => void
      remove: (id?: string) => void
    }
  }
}

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'

/** Inject the Turnstile script once per page, and resolve when it's usable. */
function loadTurnstile(): Promise<void> {
  if (window.turnstile) return Promise.resolve()
  const existing = document.querySelector<HTMLScriptElement>(`script[src="${SCRIPT_SRC}"]`)
  const script = existing ?? document.createElement('script')
  const done = new Promise<void>((resolve, reject) => {
    script.addEventListener('load', () => resolve())
    script.addEventListener('error', () => reject(new Error('Turnstile failed to load')))
  })
  if (!existing) {
    script.src = SCRIPT_SRC
    script.async = true
    script.defer = true
    document.head.appendChild(script)
  }
  return done
}

type Status = 'idle' | 'submitting' | 'done'

/** Which field an error belongs to, or 'form' for the ones that belong to none. */
type ErrorTarget = keyof typeof LIMITS | 'form'

export function GuestbookForm({ onSigned }: { onSigned: (entry: Entry) => void }) {
  const [name, setName] = useState('')
  const [message, setMessage] = useState('')
  const [website, setWebsite] = useState('')
  const [location, setLocation] = useState('')
  const [status, setStatus] = useState<Status>('idle')
  const [errors, setErrors] = useState<Partial<Record<ErrorTarget, string>>>({})

  // Turnstile state. `token` is single-use: the widget is reset after every
  // submission, successful or not, and issues a fresh one.
  const widgetRef = useRef<HTMLDivElement>(null)
  const widgetId = useRef<string | null>(null)
  const token = useRef<string | null>(null)
  const [challengeStarted, setChallengeStarted] = useState(false)
  const [challengeFailed, setChallengeFailed] = useState(false)

  // Set when someone submits before the token exists; read by the callback.
  const pendingSubmit = useRef(false)
  // Mirrors the fields for the deferred submit, which runs outside React's
  // render and would otherwise close over stale values.
  const draft = useRef({ name, message, website, location })
  draft.current = { name, message, website, location }

  const submit = useCallback(async () => {
    setStatus('submitting')
    setErrors({})
    try {
      const entry = await signGuestbook({
        ...draft.current,
        token: token.current ?? '',
        // Always sent, always empty from a person. See the note up top.
        nickname: '',
      })
      // A null entry means the honeypot caught it — which cannot happen from
      // this form, since it never fills the field. Treated as success anyway.
      if (entry) onSigned(entry)
      setStatus('done')
      setName('')
      setMessage('')
      setWebsite('')
      setLocation('')
    } catch (err) {
      const target: ErrorTarget = err instanceof SignError && err.field ? err.field : 'form'
      setErrors({
        [target]: err instanceof Error ? err.message : 'Something went wrong. Try again.',
      })
      setStatus('idle')
    } finally {
      // The token is spent either way, so retrying needs a fresh one.
      token.current = null
      window.turnstile?.reset(widgetId.current ?? undefined)
    }
  }, [onSigned])

  /** Start the challenge. Called on first interaction with any field. */
  const startChallenge = useCallback(() => {
    if (challengeStarted) return
    setChallengeStarted(true)
    loadTurnstile()
      .then(() => {
        if (!widgetRef.current || !window.turnstile || widgetId.current) return
        widgetId.current = window.turnstile.render(widgetRef.current, {
          sitekey: TURNSTILE_SITE_KEY,
          // Only shows itself when a visitor actually needs to do something.
          appearance: 'interaction-only',
          callback: (t: string) => {
            token.current = t
            setChallengeFailed(false)
            if (pendingSubmit.current) {
              pendingSubmit.current = false
              void submit()
            }
          },
          'expired-callback': () => {
            token.current = null
          },
          'error-callback': () => {
            token.current = null
            pendingSubmit.current = false
            setChallengeFailed(true)
            setStatus('idle')
          },
        })
      })
      .catch(() => setChallengeFailed(true))
  }, [challengeStarted, submit])

  // Tear the widget down on unmount so a client-side navigation away and back
  // doesn't leave an orphaned iframe behind.
  useEffect(() => {
    return () => {
      if (widgetId.current) window.turnstile?.remove(widgetId.current)
    }
  }, [])

  const onSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    if (status === 'submitting') return

    // Client-side checks are for feedback only — the Worker re-checks all of
    // this, because nothing arriving over the network can be trusted.
    if (!name.trim()) return setErrors({ name: 'A name is required.' })
    if (!message.trim()) return setErrors({ message: 'A message is required.' })

    if (!challengeStarted) startChallenge()
    if (token.current) {
      void submit()
    } else {
      // Held until the challenge produces a token. See the note up top.
      pendingSubmit.current = true
      setStatus('submitting')
    }
  }

  const remaining = LIMITS.message - [...message].length

  return (
    <form className="guestbook-form" onSubmit={onSubmit} onFocusCapture={startChallenge}>
      <h2>Sign the guestbook</h2>

      {status === 'done' && (
        <p className="guestbook-success" role="status">
          Thanks for signing — your entry is at the top of the list.
        </p>
      )}

      <div className="guestbook-fields">
        <label className="guestbook-field">
          <span>
            Name <em>required</em>
          </span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={LIMITS.name}
            required
            autoComplete="nickname"
            aria-invalid={errors.name ? true : undefined}
            aria-describedby={errors.name ? 'guestbook-error-name' : undefined}
          />
          {errors.name && (
            <span className="guestbook-error" id="guestbook-error-name">
              {errors.name}
            </span>
          )}
        </label>

        <label className="guestbook-field">
          <span>
            Website <em>optional</em>
          </span>
          <input
            type="text"
            inputMode="url"
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
            maxLength={LIMITS.website}
            placeholder="yoursite.com"
            autoComplete="url"
            aria-invalid={errors.website ? true : undefined}
            aria-describedby={errors.website ? 'guestbook-error-website' : undefined}
          />
          {errors.website && (
            <span className="guestbook-error" id="guestbook-error-website">
              {errors.website}
            </span>
          )}
        </label>

        <label className="guestbook-field">
          <span>
            Where are you? <em>optional</em>
          </span>
          <input
            type="text"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            maxLength={LIMITS.location}
            placeholder="Columbus, Ohio"
            aria-invalid={errors.location ? true : undefined}
            aria-describedby={errors.location ? 'guestbook-error-location' : undefined}
          />
          {errors.location && (
            <span className="guestbook-error" id="guestbook-error-location">
              {errors.location}
            </span>
          )}
        </label>
      </div>

      <label className="guestbook-field guestbook-field-message">
        <span>
          Message <em>required</em>
        </span>
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          maxLength={LIMITS.message}
          rows={4}
          required
          aria-invalid={errors.message ? true : undefined}
          aria-describedby={
            errors.message ? 'guestbook-error-message guestbook-count' : 'guestbook-count'
          }
        />
        <span className="guestbook-count" id="guestbook-count">
          {/* Silent until it's close enough to matter, so it isn't nagging. */}
          {remaining <= 100 ? `${remaining} characters left` : ''}
        </span>
        {errors.message && (
          <span className="guestbook-error" id="guestbook-error-message">
            {errors.message}
          </span>
        )}
      </label>

      {/* The honeypot. Hidden from sight and from assistive tech; only something
          filling every input in the DOM will touch it. */}
      <div className="guestbook-hp" aria-hidden="true">
        <label htmlFor="nickname">Nickname</label>
        <input id="nickname" name="nickname" type="text" tabIndex={-1} autoComplete="off" />
      </div>

      {/* Turnstile mounts here once the challenge starts. Empty (and zero-height)
          until then, and usually invisible even after — `interaction-only` only
          shows a widget to a visitor it isn't sure about. */}
      <div className="guestbook-challenge" ref={widgetRef} />

      {challengeFailed && (
        <p className="guestbook-error" role="alert">
          The spam check couldn&rsquo;t load — an ad blocker or a strict privacy
          extension will do that. Allow challenges.cloudflare.com and reload.
        </p>
      )}
      {errors.form && (
        <p className="guestbook-error" role="alert">
          {errors.form}
        </p>
      )}

      <div className="guestbook-actions">
        <button type="submit" disabled={status === 'submitting'}>
          {status === 'submitting' ? 'Signing…' : 'Sign'}
        </button>
        <p className="guestbook-note">
          Your name, message, and anything optional you fill in are public. Nothing
          else is stored — see the <a href="/privacy">privacy page</a>.
        </p>
      </div>
    </form>
  )
}
