import type { RouteRecord } from 'vite-react-ssg'
import { Layout } from './components/Layout'
import Home from './pages/Home'
import BlogIndex from './pages/BlogIndex'
import BlogPost from './pages/BlogPost'
import Gallery from './pages/Gallery'
import NotFound from './pages/NotFound'
import { posts } from './lib/posts'
import { galleries } from './lib/galleries'

// Child paths are relative (no leading slash) under the '/' layout route.
const stripSlash = (p: string) => p.replace(/^\//, '')

export const routes: RouteRecord[] = [
  {
    path: '/',
    element: <Layout />,
    children: [
      { index: true, element: <Home /> },
      { path: 'blog', element: <BlogIndex /> },
      // One static route per blog post, at its exact preserved Squarespace path.
      ...posts.map((post) => ({
        path: stripSlash(post.path),
        element: <BlogPost post={post} />,
      })),
      // Photo galleries at their preserved Squarespace paths.
      ...galleries.map((gallery) => ({
        path: stripSlash(gallery.path),
        element: <Gallery gallery={gallery} />,
      })),
      // Catch-all (dynamic; skipped by the SSG prerenderer, served via 404.html).
      { path: '*', element: <NotFound /> },
    ],
  },
]
