import { describe, expect, it } from 'vitest'
import {
  isStaleChunkError,
  readReloadMarker,
  shouldReload,
  writeReloadMarker,
} from '../src/lib/stale-build'

describe('isStaleChunkError', () => {
  it('recognizes the dynamic-import failure each browser reports differently', () => {
    // Recovery hangs off these exact strings; each browser words it differently.
    const messages = [
      'Failed to fetch dynamically imported module: https://cailinpitt.com/assets/BlogPost-BAKMy2uN.js',
      'error loading dynamically imported module: /assets/Home-CcO99A_p.js',
      'Importing a module script failed.',
      'Unable to preload CSS for /assets/app-CjFyunGE.css',
    ]
    for (const message of messages) {
      expect(isStaleChunkError(new Error(message))).toBe(true)
    }
  })

  it('leaves a real bug alone, so a crash cannot masquerade as a stale deploy', () => {
    // If this were loose, a page that throws on every render would reload forever.
    expect(isStaleChunkError(new TypeError("Cannot read properties of undefined (reading 'map')"))).toBe(
      false,
    )
    expect(isStaleChunkError(new Error('404 Not Found'))).toBe(false)
    expect(isStaleChunkError(null)).toBe(false)
    expect(isStaleChunkError('some string throw')).toBe(false)
  })
})

describe('shouldReload', () => {
  const now = 1_000_000

  it('reloads when nothing has been tried yet', () => {
    expect(shouldReload(null, '/blog', now)).toBe(true)
  })

  it('reloads for a different url than the one last retried', () => {
    expect(shouldReload({ href: '/blog', at: now }, '/photos', now)).toBe(true)
  })

  it('refuses a second reload of the same url right away', () => {
    // The loop guard: without it, an error that merely looks like a missing chunk reloads forever.
    expect(shouldReload({ href: '/blog', at: now }, '/blog', now + 500)).toBe(false)
  })

  it('allows the same url again once the window has passed', () => {
    // A successful reload leaves the marker; a deploy an hour later must still be recoverable.
    expect(shouldReload({ href: '/blog', at: now }, '/blog', now + 60_000)).toBe(true)
  })
})

describe('reload marker storage', () => {
  const fakeStorage = () => {
    const map = new Map<string, string>()
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
    }
  }

  it('round-trips a marker', () => {
    const storage = fakeStorage()
    expect(writeReloadMarker(storage, { href: '/blog', at: 42 })).toBe(true)
    expect(readReloadMarker(storage)).toEqual({ href: '/blog', at: 42 })
  })

  it('treats unreadable storage as no marker, rather than blocking recovery', () => {
    // Safari private mode and blocked third-party storage both throw here.
    const throwing = {
      getItem: () => {
        throw new Error('SecurityError')
      },
    }
    expect(readReloadMarker(throwing)).toBe(null)
  })

  it('ignores junk instead of trusting a half-parsed marker', () => {
    const storage = fakeStorage()
    storage.setItem('stale-build-reload', 'not json')
    expect(readReloadMarker(storage)).toBe(null)
    storage.setItem('stale-build-reload', '{"href":"/blog"}')
    expect(readReloadMarker(storage)).toBe(null)
  })

  it('reports a failed write, which is what stops an unstorable loop', () => {
    // No marker can be saved; the caller reads `false` as "don't reload".
    const throwing = {
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
    }
    expect(writeReloadMarker(throwing, { href: '/blog', at: 1 })).toBe(false)
  })
})
