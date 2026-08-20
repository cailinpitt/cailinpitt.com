import { execFile } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { defineConfig, type Plugin, type ViteDevServer } from 'vite'
import react from '@vitejs/plugin-react'
import { parseFrontmatter } from './src/lib/frontmatter'
import { parseUnifiedDiff } from './src/lib/diff'
import {
  gitLogArgs,
  gitShowArgs,
  parsePostHistory,
  repoWebUrl,
  type PostHistory,
} from './src/lib/history'

const run = promisify(execFile)

const VIRTUAL_ID = 'virtual:site-index'
// The \0 prefix is the convention that marks an id as not-a-file, so Vite and
// other plugins leave it alone rather than trying to resolve it on disk.
const RESOLVED_ID = '\0virtual:site-index'
const HISTORY_ID = 'virtual:post-history'
const RESOLVED_HISTORY_ID = '\0virtual:post-history'

// Build-time post index for the command palette (⌘K) — frontmatter only, no bodies, no fetch.
// photoIds (photo permalink slugs, for App.tsx's /photos/:id prerender paths) is SSR-only;
// the browser build has no use for 500 ids.
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

// Per-post git history (src/components/PostHistory.tsx). One `git log` for all of content/
// rather than per-file, and keyed by route (frontmatter `path:`) since a `slug:` may disagree
// with the file name. Needs a full clone — .github/workflows/deploy.yml uses `fetch-depth: 0`,
// otherwise every post would look brand new.
function postHistory(): Plugin {
  const dir = path.join(process.cwd(), 'content', 'blog')
  const content = path.join(process.cwd(), 'content')
  const rel = 'content'

  async function collect() {
    let byFile: Record<string, PostHistory> = {}
    let repo: string | null = null
    try {
      const { stdout } = await run('git', gitLogArgs(rel), { maxBuffer: 32 * 1024 * 1024 })
      byFile = parsePostHistory(stdout)
      const remote = await run('git', ['remote', 'get-url', 'origin'])
      repo = repoWebUrl(remote.stdout)
    } catch {
      // No git, no remote, or not a repo — feature is additive, page just renders without history.
      return { repo: null, history: {} }
    }

    // One `git show` per commit, not per commit per post, since one commit can touch many posts.
    const shas = new Set<string>()
    for (const entry of Object.values(byFile)) {
      // Commits are newest-first; drop the last one, whose "diff" is the whole file being created.
      for (const commit of entry.commits.slice(0, -1)) shas.add(commit.sha)
    }
    for (const sha of shas) {
      try {
        const { stdout } = await run('git', gitShowArgs(sha, rel), { maxBuffer: 32 * 1024 * 1024 })
        for (const fileDiff of parseUnifiedDiff(stdout)) {
          const commit = byFile[fileDiff.file]?.commits.find((c) => c.sha === sha)
          if (!commit) continue
          commit.diff = fileDiff.rows
          if (fileDiff.truncated) commit.truncated = true
        }
      } catch {
        // A patch git won't produce costs the page its diff, not its history.
      }
    }

    const history: Record<string, PostHistory & { file: string }> = {}

    for (const file of (await readdir(dir)).filter((f) => f.endsWith('.md'))) {
      const entry = byFile[`${rel}/blog/${file}`]
      if (!entry) continue
      const { data } = parseFrontmatter(await readFile(path.join(dir, file), 'utf8'))
      const postPath = (data.path as string) ?? `/blog/${file.replace(/\.md$/, '')}`
      history[postPath] = { ...entry, file: `${rel}/blog/${file}` }
    }

    // Pages: content/colophon.md is /colophon.
    for (const file of (await readdir(content, { withFileTypes: true }))
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => e.name)) {
      const entry = byFile[`${rel}/${file}`]
      if (entry) history[`/${file.replace(/\.md$/, '')}`] = { ...entry, file: `${rel}/${file}` }
    }

    return { repo, history }
  }

  return {
    name: 'cailinpitt:post-history',
    resolveId: (id) => (id === HISTORY_ID ? RESOLVED_HISTORY_ID : undefined),

    async load(id) {
      if (id !== RESOLVED_HISTORY_ID) return
      const { repo, history } = await collect()
      return (
        `export const repo = ${JSON.stringify(repo)}\n` +
        `export const history = ${JSON.stringify(history)}\n`
      )
    },
  }
}

// In production scripts/generate-markdown.mjs copies sources next to their prerendered HTML;
// this serves the same `.md` URLs in dev so the ".md file" link doesn't only work in prod.
function markdownSource(): Plugin {
  const content = path.join(process.cwd(), 'content')
  const blog = path.join(content, 'blog')

  return {
    name: 'cailinpitt:markdown-source',
    configureServer(server: ViteDevServer) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url?.split('?')[0]
        if (!url?.endsWith('.md')) return next()
        const send = (raw: string) => {
          res.setHeader('Content-Type', 'text/markdown; charset=utf-8')
          return res.end(raw)
        }

        // A page: content/colophon.md answers at /colophon.md, same rule the build applies.
        if (!url.startsWith('/blog/')) {
          const name = url.slice(1)
          // Bare filename only, no separators — can't be used to traverse outside content/.
          if (/^[a-z0-9-]+\.md$/i.test(name)) {
            const raw = await readFile(path.join(content, name), 'utf8').catch(() => null)
            if (raw !== null) return send(raw)
          }
          return next()
        }

        const wanted = url.slice(0, -3)
        for (const file of (await readdir(blog)).filter((f) => f.endsWith('.md'))) {
          const raw = await readFile(path.join(blog, file), 'utf8')
          const { data } = parseFrontmatter(raw)
          const postPath = (data.path as string) ?? `/blog/${file.replace(/\.md$/, '')}`
          if (postPath !== wanted) continue
          return send(raw)
        }
        next()
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), siteIndex(), postHistory(), markdownSource()],
  build: {
    // Emit clean, fingerprinted assets; HTML is generated per-route by vite-react-ssg.
    outDir: 'dist',
  },
  ssr: {
    // Bundle the markdown/unified ecosystem for the SSG prerender pass.
    noExternal: ['react-markdown', 'remark-gfm', 'rehype-raw', 'rehype-slug'],
  },
})
