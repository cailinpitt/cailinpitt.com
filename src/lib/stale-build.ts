// Recovers from a deploy that happened while a tab was open: routes are lazy-imported by
// content-hashed chunk filenames, a new deploy invalidates the old hashes, and a stale tab's
// next navigation 404s and shows a blank page. A manual refresh always fixed it; this automates that.

/** How long to wait before believing a reload could help this URL again. */
const RETRY_WINDOW_MS = 10_000

const STALE_CHUNK_MESSAGES = [
  // Chrome/Edge
  'failed to fetch dynamically imported module',
  // Firefox
  'error loading dynamically imported module',
  // Safari
  'importing a module script failed',
  // Vite's own preload helper, when the <link rel=modulepreload> is the 404
  'unable to preload css',
]

// Message-based since browsers give no distinct error type for this — treating every render
// error as staleness would turn a genuine crash into a hidden reload loop.
export function isStaleChunkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '')
  const haystack = message.toLowerCase()
  return STALE_CHUNK_MESSAGES.some((needle) => haystack.includes(needle))
}

/** What we remember about the last automatic reload, across that reload. */
export type ReloadMarker = { href: string; at: number }

// Time-boxed, not once-per-URL-forever: a working reload lets the marker age out for a later
// deploy, while a failing one hits the window and stops instead of refreshing forever.
export function shouldReload(marker: ReloadMarker | null, href: string, now: number): boolean {
  if (!marker || marker.href !== href) return true
  return now - marker.at > RETRY_WINDOW_MS
}

const STORAGE_KEY = 'stale-build-reload'

export function readReloadMarker(storage: Pick<Storage, 'getItem'>): ReloadMarker | null {
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const { href, at } = parsed as Partial<ReloadMarker>
    if (typeof href !== 'string' || typeof at !== 'number') return null
    return { href, at }
  } catch {
    // Private-mode storage throws, or a hand-edited value could be anything — no marker either way.
    return null
  }
}

/** Records an attempt. False means it wasn't recorded — don't reload, or we'd loop. */
export function writeReloadMarker(storage: Pick<Storage, 'setItem'>, marker: ReloadMarker): boolean {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(marker))
    return true
  } catch {
    return false
  }
}
