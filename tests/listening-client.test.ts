import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchPeriod, PeriodNotReady } from '../src/lib/listening'

// The period client tries the baked static file first and falls back to the API.
// That fallback is where the sharp edge is: "the file is missing" does not
// reliably look like a 404.

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })

/** What a dev server or any SPA-fallback host returns for an unknown path. */
const spaFallback = () =>
  new Response('<!doctype html><html><body>app shell</body></html>', {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Stub fetch with a handler per URL substring, recording the call order. */
function stubFetch(handler: (url: string) => Response) {
  const calls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      calls.push(String(input))
      return handler(String(input))
    }),
  )
  return calls
}

describe('period fetching', () => {
  it('prefers the baked static file when one exists', async () => {
    const calls = stubFetch((url) =>
      url.startsWith('/listening-data/') ? json({ key: '2024-W10', scrobbles: 42 }) : json({}),
    )
    const stats = await fetchPeriod('w', '2024-W10')
    expect(stats.scrobbles).toBe(42)
    // The API is never touched when the bake is present.
    expect(calls).toHaveLength(1)
    expect(calls[0]).toBe('/listening-data/w/2024-W10.json')
  })

  it('falls back to the API when an SPA fallback answers 200 with HTML', async () => {
    // The regression this guards: a dev server answers /listening-data/... with
    // index.html and a 200, so `res.ok` is true and the old code handed HTML to
    // res.json(), surfacing as "could not load" instead of falling through.
    const calls = stubFetch((url) =>
      url.startsWith('/listening-data/') ? spaFallback() : json({ key: '2024-W10', scrobbles: 7 }),
    )
    const stats = await fetchPeriod('w', '2024-W10')
    expect(stats.scrobbles).toBe(7)
    expect(calls).toHaveLength(2)
    expect(calls[1]).toContain('/p/w/2024-W10.json')
  })

  it('falls back to the API on a genuine 404 for the static file', async () => {
    const calls = stubFetch((url) =>
      url.startsWith('/listening-data/')
        ? new Response('nope', { status: 404 })
        : json({ key: '2024-06', scrobbles: 3 }),
    )
    const stats = await fetchPeriod('m', '2024-06')
    expect(stats.scrobbles).toBe(3)
    expect(calls).toHaveLength(2)
  })

  it('never looks for a baked file for the current period, which is never baked', async () => {
    // Only completed periods are baked, so trying the local path for this week
    // is a guaranteed 404 in front of the real request.
    const calls = stubFetch(() => json({ key: 'live', scrobbles: 5 }))
    await fetchPeriod('y', String(new Date().getUTCFullYear()))
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('/p/y/')
  })

  it('never looks for a baked file for all-time, which is always live', async () => {
    const calls = stubFetch(() => json({ key: 'all', scrobbles: 101_362 }))
    await fetchPeriod('all', 'all')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('/p/all/all.json')
  })

  it('reports a period the cron has not built as not-ready, not as an error', async () => {
    // A Worker without the /p/ routes deployed yet answers 404 from its
    // catch-all, which must read as "not built" so the page says so.
    stubFetch(() => new Response('Not found', { status: 404 }))
    await expect(fetchPeriod('y', '2024')).rejects.toBeInstanceOf(PeriodNotReady)
  })

  it('treats a real server error as an error', async () => {
    stubFetch(() => new Response('boom', { status: 500 }))
    await expect(fetchPeriod('y', '2024')).rejects.not.toBeInstanceOf(PeriodNotReady)
  })

  it('survives the static fetch throwing outright', async () => {
    // No dev server at all, or a blocked request: the rejection must not escape.
    const calls = stubFetch((url) => {
      if (url.startsWith('/listening-data/')) throw new TypeError('Failed to fetch')
      return json({ key: '2024', scrobbles: 1 })
    })
    const stats = await fetchPeriod('y', '2024')
    expect(stats.scrobbles).toBe(1)
    expect(calls).toHaveLength(2)
  })
})
