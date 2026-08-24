import type { RouteRecord } from 'vite-react-ssg'
import { Layout } from './components/Layout'
import { RouteError } from './components/RouteError'
import { photoIds } from 'virtual:site-index'
import { listeningYears } from './lib/listeningYears'
import { allPeriods, urlFor } from './lib/periodKeys'

// Applied to children, not the layout route, so the header/nav survive an errorElement
// swap. Centralized here so new routes can't opt out — mainly catches deploy-mid-visit.
const withErrorBoundary = (routes: RouteRecord[]): RouteRecord[] =>
  routes.map((route) => ({ ...route, errorElement: <RouteError /> }))

export const routes: RouteRecord[] = [
  {
    path: '/',
    element: <Layout />,
    children: withErrorBoundary([
      { index: true, lazy: () => import('./pages/Home') },
      { path: 'blog', lazy: () => import('./pages/BlogIndex') },
      // A note is addressed as `/notes#<id>`, not a route — notes live in D1 and
      // are never prerendered (see worker-notes/src/index.ts).
      { path: 'notes', lazy: () => import('./pages/Notes') },
      { path: 'notes/compose', lazy: () => import('./pages/NotesCompose') },
      // Client-fetched like the feed itself; no getStaticPaths since notes are D1-backed, not build-time.
      { path: 'notes/tag/:tag', lazy: () => import('./pages/NotesTag') },
      { path: 'blog/tag/:tag', lazy: () => import('./pages/BlogTag') },
      { path: 'blog/:year/:month/:day/:slug', lazy: () => import('./pages/BlogPost') },
      { path: 'projects', lazy: () => import('./pages/Projects') },
      { path: 'listening', lazy: () => import('./pages/Listening') },
      // Static segments outrank dynamic ones in React Router, so this wins over 'listening/:a'.
      {
        path: 'listening/wrapped',
        lazy: () => import('./pages/ListeningWrapped'),
      },
      {
        path: 'listening/wrapped/:year',
        lazy: () => import('./pages/ListeningWrapped'),
        getStaticPaths: () => listeningYears().map((y) => `/listening/wrapped/${y}`),
      },
      // Static paths come from date arithmetic, not the listening API, so a Worker outage can't fail the deploy.
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
      { path: 'reading/articles', lazy: () => import('./pages/ReadingArticles') },
      { path: 'watching', lazy: () => import('./pages/Watching') },
      { path: 'concerts', lazy: () => import('./pages/Concerts') },
      { path: 'moving', lazy: () => import('./pages/Moving') },
      { path: 'timeline', lazy: () => import('./pages/Timeline') },
      { path: 'guestbook', lazy: () => import('./pages/Guestbook') },
      { path: 'photos', lazy: () => import('./pages/Photos') },
      { path: 'photos/map', lazy: () => import('./pages/PhotoMap') },
      {
        path: 'photos/:id',
        lazy: () => import('./pages/PhotoDetail'),
        // From the build-time index, not the manifest, so the browser build skips 500 unused slugs.
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
