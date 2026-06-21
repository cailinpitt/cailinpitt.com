import type { RouteRecord } from 'vite-react-ssg'
import { Layout } from './components/Layout'
import { galleryDefinitions } from './lib/galleries'

// Child paths are relative (no leading slash) under the '/' layout route.
const stripSlash = (p: string) => p.replace(/^\//, '')

export const routes: RouteRecord[] = [
  {
    path: '/',
    element: <Layout />,
    children: [
      { index: true, lazy: () => import('./pages/Home') },
      { path: 'blog', lazy: () => import('./pages/BlogIndex') },
      { path: 'blog/:year/:month/:day/:slug', lazy: () => import('./pages/BlogPost') },
      { path: 'projects', lazy: () => import('./pages/Projects') },
      { path: 'photos', lazy: () => import('./pages/Photos') },
      { path: 'privacy', lazy: () => import('./pages/Privacy') },
      // Photo galleries at their preserved Squarespace paths.
      ...galleryDefinitions.map((gallery) => ({
        path: stripSlash(gallery.path),
        lazy: () => import('./pages/Gallery'),
      })),
      // Catch-all (dynamic; skipped by the SSG prerenderer, served via 404.html).
      { path: '*', lazy: () => import('./pages/NotFound') },
    ],
  },
]
