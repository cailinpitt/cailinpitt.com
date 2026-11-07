import { useCallback, useEffect, useRef, useState } from 'react'
import { TURNSTILE_SITE_KEY } from '../lib/comments'
import { formatNumber } from '../lib/datetime'
import { loadTurnstile } from '../lib/turnstile'
import { fetchUpvotes, postUpvote, rememberedUpvote, rememberUpvote } from '../lib/upvotes'

export function PostUpvote({ postPath }: { postPath: string }) {
  const [count, setCount] = useState<number | null>(null)
  const [upvoted, setUpvoted] = useState(false)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const widgetRef = useRef<HTMLDivElement>(null)
  const widgetId = useRef<string | null>(null)

  const removeWidget = useCallback(() => {
    if (!widgetId.current) return
    try {
      window.turnstile?.remove(widgetId.current)
    } catch {
      /* already gone */
    }
    widgetId.current = null
  }, [])

  useEffect(() => {
    setCount(null)
    setError(null)
    setUpvoted(rememberedUpvote(postPath))
    const controller = new AbortController()
    fetchUpvotes(postPath, controller.signal)
      .then(setCount)
      .catch(() => {})
    return () => {
      controller.abort()
      removeWidget()
    }
  }, [postPath, removeWidget])

  const challenge = useCallback(async (): Promise<string> => {
    await loadTurnstile()
    return new Promise((resolve, reject) => {
      if (!widgetRef.current || !window.turnstile) return reject(new Error('unavailable'))
      removeWidget()
      widgetId.current = window.turnstile.render(widgetRef.current, {
        sitekey: TURNSTILE_SITE_KEY,
        appearance: 'interaction-only',
        callback: resolve,
        'error-callback': () => reject(new Error('challenge failed')),
      })
    })
  }, [removeWidget])

  const onClick = async () => {
    if (upvoted || working) return
    setWorking(true)
    setError(null)
    setUpvoted(true)
    setCount((c) => (c === null ? c : c + 1))
    try {
      const token = await challenge().catch(() => {
        throw new Error(
          'The spam check couldn’t load — an ad blocker or privacy extension will do that.',
        )
      })
      const result = await postUpvote(postPath, token)
      setCount(result.count)
      rememberUpvote(postPath)
    } catch (err) {
      setUpvoted(false)
      setCount((c) => (c === null ? c : c - 1))
      setError(err instanceof Error ? err.message : 'Something went wrong. Try again.')
    } finally {
      removeWidget()
      setWorking(false)
    }
  }

  const prefetch = () => void loadTurnstile().catch(() => {})

  return (
    <div className="post-upvote">
      <button
        type="button"
        aria-pressed={upvoted}
        aria-label={`Upvote this post${count ? `, ${formatNumber(count)} so far` : ''}`}
        onClick={onClick}
        onPointerEnter={prefetch}
        onFocus={prefetch}
        disabled={working}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 4 3 14h6v6h6v-6h6z" />
        </svg>
        <span>{count ? formatNumber(count) : 'Upvote'}</span>
      </button>
      <div className="post-upvote-popover">
        <div ref={widgetRef} />
        {error && (
          <p className="comment-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  )
}
