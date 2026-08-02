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
 */
function siteIndex(): Plugin {
  const dir = path.join(process.cwd(), 'content', 'blog')

  return {
    name: 'cailinpitt:site-index',
    resolveId: (id) => (id === VIRTUAL_ID ? RESOLVED_ID : undefined),

    async load(id) {
      if (id !== RESOLVED_ID) return
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
      return `export const posts = ${JSON.stringify(posts)}\n`
    },

    // In dev the module is generated once, and would otherwise go stale the
    // moment a post is added or retitled.
    configureServer(server: ViteDevServer) {
      server.watcher.add(dir)
      const refresh = (file: string) => {
        if (!file.startsWith(dir) || !file.endsWith('.md')) return
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

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), siteIndex()],
  build: {
    // Emit clean, fingerprinted assets; HTML is generated per-route by vite-react-ssg.
    outDir: 'dist',
  },
  ssr: {
    // Bundle the markdown/unified ecosystem for the SSG prerender pass.
    noExternal: ['react-markdown', 'remark-gfm', 'rehype-raw', 'rehype-slug'],
  },
})
