import { useCallback, useEffect, useRef, useState } from 'react'
import {
  CommentError,
  LIMITS,
  postComment,
  TURNSTILE_SITE_KEY,
  type Comment,
} from '../lib/comments'

// Mirrors GuestbookForm.tsx, scoped to one postPath.

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

type Status = 'idle' | 'challenging' | 'submitting' | 'done'
type ErrorTarget = keyof typeof LIMITS | 'form'

export function CommentForm({
  postPath,
  onPosted,
}: {
  postPath: string
  onPosted: (comment: Comment) => void
}) {
  const [name, setName] = useState('')
  const [message, setMessage] = useState('')
  const [website, setWebsite] = useState('')
  const [status, setStatus] = useState<Status>('idle')
  const [errors, setErrors] = useState<Partial<Record<ErrorTarget, string>>>({})

  const widgetRef = useRef<HTMLDivElement>(null)
  const widgetId = useRef<string | null>(null)
  const token = useRef<string | null>(null)
  const [challengeStarted, setChallengeStarted] = useState(false)
  const [challengeFailed, setChallengeFailed] = useState(false)
  const pendingSubmit = useRef(false)

  const removeWidget = useCallback(() => {
    if (!widgetId.current) return
    try {
      window.turnstile?.remove(widgetId.current)
    } catch {
      /* already gone */
    }
    widgetId.current = null
  }, [])

  const draft = useRef({ name, message, website })
  draft.current = { name, message, website }

  const submit = useCallback(async () => {
    setStatus('submitting')
    setErrors({})
    try {
      const comment = await postComment({
        postPath,
        ...draft.current,
        token: token.current ?? '',
        nickname: '',
      })
      if (comment) onPosted(comment)
      setStatus('done')
      setName('')
      setMessage('')
      setWebsite('')

      // Remove rather than reset(): re-arming makes Turnstile treat a second
      // submission as more suspicious.
      removeWidget()
      setChallengeStarted(false)
    } catch (err) {
      const target: ErrorTarget = err instanceof CommentError && err.field ? err.field : 'form'
      setErrors({
        [target]: err instanceof Error ? err.message : 'Something went wrong. Try again.',
      })
      setStatus('idle')
      window.turnstile?.reset(widgetId.current ?? undefined)
    } finally {
      token.current = null
    }
  }, [postPath, onPosted, removeWidget])

  const startChallenge = useCallback(() => {
    if (challengeStarted) return
    setChallengeStarted(true)
    loadTurnstile()
      .then(() => {
        if (!widgetRef.current || !window.turnstile || widgetId.current) return
        widgetId.current = window.turnstile.render(widgetRef.current, {
          sitekey: TURNSTILE_SITE_KEY,
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

  useEffect(() => removeWidget, [removeWidget])

  const onSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    if (status === 'submitting' || status === 'challenging') return

    if (!name.trim()) return setErrors({ name: 'A name is required.' })
    if (!message.trim()) return setErrors({ message: 'A comment is required.' })

    if (!challengeStarted) startChallenge()
    if (token.current) {
      void submit()
    } else {
      pendingSubmit.current = true
      setStatus('challenging')
    }
  }

  const remaining = LIMITS.message - [...message].length

  return (
    <form className="comment-form" onSubmit={onSubmit} onFocusCapture={startChallenge}>
      <h3>Leave a comment</h3>

      {status === 'done' && (
        <p className="comment-success" role="status">
          Thanks — your comment is at the top of the list.
        </p>
      )}

      <div className="comment-fields">
        <label className="comment-field">
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
            aria-describedby={errors.name ? 'comment-error-name' : undefined}
          />
          {errors.name && (
            <span className="comment-error" id="comment-error-name">
              {errors.name}
            </span>
          )}
        </label>

        <label className="comment-field">
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
            aria-describedby={errors.website ? 'comment-error-website' : undefined}
          />
          {errors.website && (
            <span className="comment-error" id="comment-error-website">
              {errors.website}
            </span>
          )}
        </label>
      </div>

      <label className="comment-field comment-field-message">
        <span>
          Comment <em>required</em>
        </span>
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          maxLength={LIMITS.message}
          rows={4}
          required
          aria-invalid={errors.message ? true : undefined}
          aria-describedby={
            errors.message ? 'comment-error-message comment-count' : 'comment-count'
          }
        />
        <span className="comment-count" id="comment-count">
          {remaining <= 100 ? `${remaining} characters left` : ''}
        </span>
        {errors.message && (
          <span className="comment-error" id="comment-error-message">
            {errors.message}
          </span>
        )}
      </label>

      {/* Honeypot, hidden from sight and assistive tech. */}
      <div className="comment-hp" aria-hidden="true">
        <label htmlFor="comment-nickname">Nickname</label>
        <input id="comment-nickname" name="nickname" type="text" tabIndex={-1} autoComplete="off" />
      </div>

      <div className="comment-challenge" ref={widgetRef} />

      {challengeFailed && (
        <p className="comment-error" role="alert">
          The spam check couldn&rsquo;t load — an ad blocker or a strict privacy
          extension will do that. Allow challenges.cloudflare.com and reload.
        </p>
      )}
      {errors.form && (
        <p className="comment-error" role="alert">
          {errors.form}
        </p>
      )}

      {status === 'challenging' && (
        <p className="comment-waiting" role="status">
          One moment — finishing the spam check above.
        </p>
      )}

      <div className="comment-actions">
        <button type="submit" disabled={status === 'submitting' || status === 'challenging'}>
          {status === 'submitting' ? 'Posting…' : status === 'challenging' ? 'Checking…' : 'Comment'}
        </button>
        <p className="comment-note">
          Your name, comment, and website (if you fill it in) are public. Nothing
          else is stored — see the <a href="/privacy">privacy page</a>.
        </p>
      </div>
    </form>
  )
}
