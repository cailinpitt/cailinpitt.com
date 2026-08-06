import type { RouteRecord } from 'vite-react-ssg'
import { Layout } from './components/Layout'
import { RouteError } from './components/RouteError'
import { photoIds } from 'virtual:site-index'
import { listeningYears } from './lib/listeningYears'

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
      {
        path: 'listening/:year',
        lazy: () => import('./pages/ListeningYear'),
        // Concrete paths for the prerenderer. Sourced from a constant rather than
        // the listening API so a Worker outage can't fail an unrelated deploy.
        getStaticPaths: () => listeningYears().map((y) => `/listening/${y}`),
      },
      { path: 'reading', lazy: () => import('./pages/Reading') },
      { path: 'watching', lazy: () => import('./pages/Watching') },
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
