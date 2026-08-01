import { useEffect, useState } from 'react'

/**
 * Advertises a page's terminal view. Both activity Workers render themselves as
 * text for a CLI user-agent (see worker/src/text.ts and worker-reading/src/text.ts),
 * which nobody would ever discover from the page without this.
 *
 * The `$` is presentational — it's outside the copied string and hidden from
 * assistive tech, so pasting what you copied actually runs.
 */
export function CurlHint({ command }: { command: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')

  useEffect(() => {
    if (state === 'idle') return
    const id = setTimeout(() => setState('idle'), 2000)
    return () => clearTimeout(id)
  }, [state])

  const copy = async () => {
    try {
      // Absent outside secure contexts, so this can genuinely be unavailable.
      await navigator.clipboard.writeText(command)
      setState('copied')
    } catch {
      setState('failed')
    }
  }

  return (
    <div className="curl-hint">
      <code>
        <span className="curl-prompt" aria-hidden="true">
          $
        </span>
        {command}
      </code>
      <button type="button" onClick={copy} aria-label={`Copy "${command}" to clipboard`}>
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Copy'}
      </button>
      <span role="status" aria-live="polite" className="visually-hidden">
        {state === 'copied' ? 'Copied to clipboard' : state === 'failed' ? 'Copy failed' : ''}
      </span>
    </div>
  )
}
