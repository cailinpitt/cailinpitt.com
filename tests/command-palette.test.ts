import { describe, expect, it } from 'vitest'
import type { RouteRecord } from 'vite-react-ssg'
import { routes } from '../src/App'
import { LISTED_PAGES, PAGES } from '../src/components/CommandPalette'

// PAGES is hand-written (see its own comment); a missing entry is invisible from ⌘K but fine everywhere else.

/** Every leaf route, so a page outside <Layout> (e.g. /terminal) is still checked. */
const leaves = (list: RouteRecord[]): RouteRecord[] =>
  list.flatMap((route) => (route.children ? leaves(route.children as RouteRecord[]) : [route]))

/**
 * The routes a visitor could be told to search for: no parameterized routes (a
 * post, a tag, or a single photo has no one URL) and no catch-all.
 */
const staticRoutes = leaves(routes).flatMap((route) => {
  if ('index' in route && route.index) return ['/']
  const routePath = (route as { path?: string }).path
  if (!routePath || routePath.includes(':') || routePath === '*') return []
  return [`/${routePath.replace(/^\//, '')}`]
})

describe('the command palette page list', () => {
  it('reaches every static route', () => {
    const listed = new Set(PAGES.map((entry) => entry.to))
    const missing = staticRoutes.filter((route) => !listed.has(route))
    expect(missing, 'add these to PAGES in src/components/CommandPalette.tsx').toEqual([])
  })

  it('does not point anywhere the router does not go', () => {
    const known = new Set(staticRoutes)
    const dangling = PAGES.map((entry) => entry.to).filter((to) => !known.has(to))
    expect(dangling, 'these PAGES entries have no route in src/App.tsx').toEqual([])
  })

  it('keeps the compose page out of the palette', () => {
    // Must stay in PAGES for route coverage, but marked unlisted so it isn't shown to every visitor.
    expect(PAGES.map((entry) => entry.to)).toContain('/notes/compose')
    expect(LISTED_PAGES.map((entry) => entry.to)).not.toContain('/notes/compose')
  })

  it('lists every page that is not explicitly unlisted', () => {
    // Guards the filter itself: a broken predicate could empty the palette and still pass the test above.
    expect(LISTED_PAGES.length).toBe(PAGES.filter((entry) => !entry.unlisted).length)
    expect(LISTED_PAGES.length).toBe(PAGES.length - 1)
  })

  it('gives every entry a distinct id', () => {
    // Ids are React keys and the haystack lookup key; a duplicate drops a row from results.
    const ids = PAGES.map((entry) => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
