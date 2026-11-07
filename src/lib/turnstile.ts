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

export function loadTurnstile(): Promise<void> {
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
