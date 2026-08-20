import { useEffect, useState } from 'react'

/**
 * View-source for a post: flips between rendered page and the Markdown it was
 * written in. Reads the body from the loader data already rendering the page,
 * so switching costs no request. The `.md` link goes to the real file
 * (scripts/generate-markdown.mjs copies it next to the HTML), which carries
 * frontmatter the body alone doesn't.
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

  // A fragment, not a row: the page puts these in `.post-source-bar` alongside the history link.
  return (
    <>
      {/* Label stays put, aria-pressed carries state — avoids renaming the control out from under a screen reader user who just pressed it. */}
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
    </>
  )
}
