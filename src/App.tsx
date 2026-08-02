import type { RouteRecord } from 'vite-react-ssg'
import { Layout } from './components/Layout'
import { RouteError } from './components/RouteError'
import { galleryDefinitions } from './lib/galleries'
import { listeningYears } from './lib/listeningYears'

// Child paths are relative (no leading slash) under the '/' layout route.
const stripSlash = (p: string) => p.replace(/^\//, '')

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
      { path: 'timeline', lazy: () => import('./pages/Timeline') },
      { path: 'guestbook', lazy: () => import('./pages/Guestbook') },
      { path: 'photos', lazy: () => import('./pages/Photos') },
      { path: 'photos/map', lazy: () => import('./pages/PhotoMap') },
      { path: 'colophon', lazy: () => import('./pages/Colophon') },
      { path: 'privacy', lazy: () => import('./pages/Privacy') },
      // Photo galleries at their preserved Squarespace paths.
      ...galleryDefinitions.map((gallery) => ({
        path: stripSlash(gallery.path),
        lazy: () => import('./pages/Gallery'),
      })),
      // Catch-all (dynamic; skipped by the SSG prerenderer, served via 404.html).
      { path: '*', lazy: () => import('./pages/NotFound') },
    ]),
  },
]
