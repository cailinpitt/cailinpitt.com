import { useEffect, useState } from 'react'

// Always the apex origin, never window.location — a shared link has to resolve
// for whoever receives it, not just whatever preview/dev origin rendered the button.
const SITE_URL = 'https://cailinpitt.com'

/**
 * Native share sheet, or a clipboard copy fallback. Same behavior as
 * Notes.tsx's ShareButton, but rendered as a plain text control so it sits
 * in `.post-source-bar` alongside the Markdown/History buttons.
 */
export function PostShare({ path, title }: { path: string; title: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')

  useEffect(() => {
    if (state === 'idle') return
    const id = setTimeout(() => setState('idle'), 2000)
    return () => clearTimeout(id)
  }, [state])

  const share = async () => {
    const url = `${SITE_URL}${path}`
    if (navigator.share) {
      try {
        await navigator.share({ url, title })
      } catch (err) {
        // AbortError: the share sheet was closed without picking anything — not a failure.
        if ((err as Error)?.name !== 'AbortError') setState('failed')
      }
      return
    }
    try {
      // Absent outside secure contexts, so this can genuinely be unavailable.
      await navigator.clipboard.writeText(url)
      setState('copied')
    } catch {
      setState('failed')
    }
  }

  return (
    <>
      <button type="button" onClick={share}>
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Share'}
      </button>
      <span role="status" aria-live="polite" className="visually-hidden">
        {state === 'copied' ? 'Link copied to clipboard' : state === 'failed' ? 'Copy failed' : ''}
      </span>
    </>
  )
}
