import { useEffect, useState } from 'react'

/**
 * View-source for a post: flips the article between the rendered page and the
 * Markdown it was written in, the way a browser's own view-source does.
 *
 * It reads the body out of the loader data the page is already rendering from,
 * so switching costs no request and can't show something different from what's
 * on screen. The `.md` link goes to the real file
 * (scripts/generate-markdown.mjs copies it next to the HTML) — that one carries
 * the frontmatter too, which the body alone doesn't.
 */
export function PostSource({
  body,
  file,
  open,
  onToggle,
}: {
  body: string
  /** URL of the published source file, e.g. /blog/2023/3/3/slug.md */
  file: string
  open: boolean
  onToggle: (open: boolean) => void
}) {
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle')

  useEffect(() => {
    if (copied === 'idle') return
    const id = setTimeout(() => setCopied('idle'), 2000)
    return () => clearTimeout(id)
  }, [copied])

  const copy = async () => {
    try {
      // Absent outside secure contexts, so this can genuinely be unavailable.
      await navigator.clipboard.writeText(body)
      setCopied('copied')
    } catch {
      setCopied('failed')
    }
  }

  return (
    <div className="post-source-bar">
      {/* A toggle button: the label stays put and aria-pressed carries the
          state, so a screen reader announces what pressing it does rather than
          renaming the control out from under anyone who just used it. */}
      <button type="button" aria-pressed={open} onClick={() => onToggle(!open)}>
        Markdown
      </button>
      {open && (
        <>
          <button type="button" onClick={copy}>
            {copied === 'copied' ? 'Copied' : copied === 'failed' ? 'Copy failed' : 'Copy'}
          </button>
          <a href={file}>
            .md file<span aria-hidden="true"> ↗</span>
          </a>
          <span role="status" aria-live="polite" className="visually-hidden">
            {copied === 'copied' ? 'Copied to clipboard' : copied === 'failed' ? 'Copy failed' : ''}
          </span>
        </>
      )}
    </div>
  )
}
