/**
 * Recovering from a deploy that happened while a tab was open.
 *
 * Every route in App.tsx is a `lazy: () => import(...)`, so a page's code is
 * only fetched when you navigate to it. The chunk filenames are content-hashed,
 * and a GitHub Pages deploy replaces the whole artifact — the old hashes stop
 * existing the moment a new build ships. A tab left open overnight is still
 * holding the *previous* build's filenames, so the next in-page link click asks
 * for a chunk that 404s and the navigation dies with a blank page.
 *
 * The page itself isn't broken, just the module graph it was told about, which
 * is why a manual refresh has always fixed it. This does that refresh
 * automatically.
 */

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

/**
 * Is this the "my chunks are gone" error, rather than a real bug in a page?
 *
 * Deliberately message-based: browsers don't give these a distinct error type,
 * and treating *every* render error as staleness would turn a genuine crash
 * into a reload loop that hides it.
 */
export function isStaleChunkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '')
  const haystack = message.toLowerCase()
  return STALE_CHUNK_MESSAGES.some((needle) => haystack.includes(needle))
}

/** What we remember about the last automatic reload, across that reload. */
export type ReloadMarker = { href: string; at: number }

/**
 * Should we reload for `href`, given the last reload we performed?
 *
 * The guard is time-boxed rather than once-per-URL-forever. If the reload
 * worked, the marker simply ages out and a *later* deploy can trigger another
 * one. If it didn't work — the error is really something else wearing a
 * chunk-shaped message, or the network is down — the second failure lands
 * inside the window and we stop and show the user something instead of
 * refreshing forever.
 */
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
    // Private-mode storage throws on read, and a hand-edited value can be
    // anything. Either way: no marker, so a reload is allowed.
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
