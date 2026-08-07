import type { RouteRecord } from 'vite-react-ssg'
import { Layout } from './components/Layout'
import { RouteError } from './components/RouteError'
import { photoIds } from 'virtual:site-index'
import { listeningYears } from './lib/listeningYears'
import { allPeriods, urlFor } from './lib/periodKeys'

/**
 * Give every page the same error boundary.
 *
 * It has to go on the children, not the layout route: an errorElement replaces
 * the route it sits on, and putting it upstairs would take the header and nav
 * down with the page. Applied here rather than written out fifteen times so a
 * route added later can't quietly opt out of it — which matters, because the
 * error it mostly catches is a deploy landing mid-visit and that can happen on
 * any route.
 */
const withErrorBoundary = (routes: RouteRecord[]): RouteRecord[] =>
  routes.map((route) => ({ ...route, errorElement: <RouteError /> }))

export const routes: RouteRecord[] = [
  {
    path: '/',
    element: <Layout />,
    children: withErrorBoundary([
      { index: true, lazy: () => import('./pages/Home') },
      { path: 'blog', lazy: () => import('./pages/BlogIndex') },
      { path: 'blog/tag/:tag', lazy: () => import('./pages/BlogTag') },
      { path: 'blog/:year/:month/:day/:slug', lazy: () => import('./pages/BlogPost') },
      { path: 'projects', lazy: () => import('./pages/Projects') },
      { path: 'listening', lazy: () => import('./pages/Listening') },
      // Static segments outrank dynamic ones in React Router, so these win over
      // 'listening/:a' below rather than being parsed as a period key.
      {
        path: 'listening/wrapped',
        lazy: () => import('./pages/ListeningWrapped'),
      },
      {
        path: 'listening/wrapped/:year',
        lazy: () => import('./pages/ListeningWrapped'),
        getStaticPaths: () => listeningYears().map((y) => `/listening/wrapped/${y}`),
      },
      // Years and all-time sit one level down, weeks and months two — one page
      // serves all four. Concrete paths for the prerenderer come from date
      // arithmetic over a constant start date rather than the listening API, so a
      // Worker outage can't fail an unrelated deploy.
      {
        path: 'listening/:a',
        lazy: () => import('./pages/ListeningPeriod'),
        getStaticPaths: () => [
          '/listening/all',
          ...listeningYears().map((y) => `/listening/${y}`),
        ],
      },
      {
        path: 'listening/:a/:b',
        lazy: () => import('./pages/ListeningPeriod'),
        getStaticPaths: () =>
          allPeriods()
            .filter((p) => p.kind === 'm' || p.kind === 'w')
            .map((p) => urlFor(p.kind, p.key)),
      },
      { path: 'reading', lazy: () => import('./pages/Reading') },
      { path: 'watching', lazy: () => import('./pages/Watching') },
      { path: 'moving', lazy: () => import('./pages/Moving') },
      { path: 'timeline', lazy: () => import('./pages/Timeline') },
      { path: 'guestbook', lazy: () => import('./pages/Guestbook') },
      { path: 'photos', lazy: () => import('./pages/Photos') },
      { path: 'photos/map', lazy: () => import('./pages/PhotoMap') },
      {
        path: 'photos/:id',
        lazy: () => import('./pages/PhotoDetail'),
        // Every photograph gets its own prerendered page. The ids come from the
        // build-time index rather than the manifest itself, so the browser build
        // doesn't carry a list of five hundred slugs it will never read.
        getStaticPaths: () => photoIds.map((id) => `/photos/${id}`),
      },
      { path: 'about', lazy: () => import('./pages/About') },
      { path: 'now', lazy: () => import('./pages/Now') },
      { path: 'uses', lazy: () => import('./pages/Uses') },
      { path: 'colophon', lazy: () => import('./pages/Colophon') },
      { path: 'privacy', lazy: () => import('./pages/Privacy') },
      // Catch-all (dynamic; skipped by the SSG prerenderer, served via 404.html).
      { path: '*', lazy: () => import('./pages/NotFound') },
    ]),
  },
  // Outside <Layout>: the terminal fills the viewport, header and footer included.
  ...withErrorBoundary([{ path: '/terminal', lazy: () => import('./pages/Terminal') }]),
]
