import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { defineConfig, type Plugin, type ViteDevServer } from 'vite'
import react from '@vitejs/plugin-react'
import { parseFrontmatter } from './src/lib/frontmatter'

const VIRTUAL_ID = 'virtual:site-index'
// The \0 prefix is the convention that marks an id as not-a-file, so Vite and
// other plugins leave it alone rather than trying to resolve it on disk.
const RESOLVED_ID = '\0virtual:site-index'

/**
 * A tiny post index for the command palette (⌘K), as a virtual module.
 *
 * The palette needs the title, path, date, and tags of every post *on every
 * page*, which no route loader provides — those are per-route by design. The two
 * obvious alternatives are both worse: an eager `import.meta.glob` of the
 * Markdown would ship every post's body to the browser, and a generated JSON
 * file would cost a request before the palette could open.
 *
 * So the frontmatter is read at build time and inlined as a module — roughly a
 * hundred bytes per post, no bodies, no fetch. It uses the same parser the site
 * does, so it can't disagree with the rendered pages about what a post is called.
 *
 * It also carries two things about the photo feed:
 *
 *   photoIds    every photo's permalink slug, which App.tsx hands to the
 *               prerenderer as the static paths for /photos/:id. Emitted **only
 *               into the SSR build** — the browser has no use for five hundred
 *               ids, and shipping them would cost more than the palette saves.
 *   photoYears  the years the feed covers, which the palette does need.
 */
function siteIndex(): Plugin {
  const dir = path.join(process.cwd(), 'content', 'blog')
  const manifest = path.join(process.cwd(), 'src', 'lib', 'photos.json')

  return {
    name: 'cailinpitt:site-index',
    resolveId: (id) => (id === VIRTUAL_ID ? RESOLVED_ID : undefined),

    async load(id, options) {
      if (id !== RESOLVED_ID) return
      const photos = JSON.parse(await readFile(manifest, 'utf8')) as { id: string; year: string }[]
      const photoIds = options?.ssr ? photos.map((photo) => photo.id) : []
      const photoYears = [...new Set(photos.map((photo) => photo.year))].sort().reverse()
      const files = (await readdir(dir)).filter((file) => file.endsWith('.md'))
      const posts = await Promise.all(
        files.map(async (file) => {
          const { data } = parseFrontmatter(await readFile(path.join(dir, file), 'utf8'))
          const slug = file.replace(/\.md$/, '')
          return {
            path: (data.path as string) ?? `/blog/${slug}`,
            title: (data.title as string) ?? slug,
            date: (data.date as string) ?? '',
            tags: Array.isArray(data.tags) ? data.tags : [],
          }
        }),
      )
      // Newest first, matching every other list of posts on the site.
      posts.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
      return (
        `export const posts = ${JSON.stringify(posts)}\n` +
        `export const photoIds = ${JSON.stringify(photoIds)}\n` +
        `export const photoYears = ${JSON.stringify(photoYears)}\n`
      )
    },

    // In dev the module is generated once, and would otherwise go stale the
    // moment a post is added or a photo synced.
    configureServer(server: ViteDevServer) {
      server.watcher.add(dir)
      server.watcher.add(manifest)
      const refresh = (file: string) => {
        if (file !== manifest && (!file.startsWith(dir) || !file.endsWith('.md'))) return
        const mod = server.moduleGraph.getModuleById(RESOLVED_ID)
        if (mod) server.moduleGraph.invalidateModule(mod)
        server.hot.send({ type: 'full-reload' })
      }
      server.watcher.on('add', refresh)
      server.watcher.on('change', refresh)
      server.watcher.on('unlink', refresh)
    },
  }
}

/**
 * Serve `/blog/<path>.md` in dev, the way the built site does.
 *
 * In production those files are real: scripts/generate-markdown.mjs copies each
 * post's source next to its prerendered HTML. Without this the ".md file" link
 * on every post would be the one thing on the page that only works in
 * production, which is how it ends up broken.
 */
function postSource(): Plugin {
  const dir = path.join(process.cwd(), 'content', 'blog')

  return {
    name: 'cailinpitt:post-source',
    configureServer(server: ViteDevServer) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url?.split('?')[0]
        if (!url?.startsWith('/blog/') || !url.endsWith('.md')) return next()
        const wanted = url.slice(0, -3)
        for (const file of (await readdir(dir)).filter((f) => f.endsWith('.md'))) {
          const raw = await readFile(path.join(dir, file), 'utf8')
          const { data } = parseFrontmatter(raw)
          const postPath = (data.path as string) ?? `/blog/${file.replace(/\.md$/, '')}`
          if (postPath !== wanted) continue
          res.setHeader('Content-Type', 'text/markdown; charset=utf-8')
          return res.end(raw)
        }
        next()
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), siteIndex(), postSource()],
  build: {
    // Emit clean, fingerprinted assets; HTML is generated per-route by vite-react-ssg.
    outDir: 'dist',
  },
  ssr: {
    // Bundle the markdown/unified ecosystem for the SSG prerender pass.
    noExternal: ['react-markdown', 'remark-gfm', 'rehype-raw', 'rehype-slug'],
  },
})
