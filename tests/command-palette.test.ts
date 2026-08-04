import { describe, expect, it } from 'vitest'
import type { RouteRecord } from 'vite-react-ssg'
import { routes } from '../src/App'
import { PAGES } from '../src/components/CommandPalette'

// The palette's page list is hand-written (see the comment on PAGES), and a page
// missing from it is invisible from ⌘K while looking perfectly fine everywhere
// else. Posts, photo years, and tags are derived from content, so they can't
// drift — only this list can, and only when a route is added or removed.

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

  it('gives every entry a distinct id', () => {
    // Ids are React keys and the lookup key for the precomputed haystacks; a
    // duplicate would drop a row out of the results.
    const ids = PAGES.map((entry) => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
