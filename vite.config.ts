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
 * Each post's git history, as a virtual module — the data behind the provenance
 * line at the foot of a post (src/components/PostHistory.tsx).
 *
 * One `git log` for the whole directory, not one per file: 32 subprocesses to
 * say what a single pass already knows would be the slowest thing in the build.
 * Renames aren't followed (`--follow` takes exactly one pathspec), which costs
 * nothing here — a post's file name is its URL, so renaming one is a redirect
 * problem nobody has taken on.
 *
 * Keyed by post path rather than by file name, because `path:` is the site's
 * unique key for a post and a frontmatter `slug:` may disagree with the file.
 *
 * **A shallow clone reports almost no history**, and would quietly show every
 * post as brand new. .github/workflows/deploy.yml checks out with
 * `fetch-depth: 0` for this reason. Outside a git repo entirely — a tarball, a
 * fresh unzip — the map comes back empty and the line simply doesn't render.
 */
function postHistory(): Plugin {
  const dir = path.join(process.cwd(), 'content', 'blog')
  const rel = 'content/blog'

  async function collect() {
    let byFile: Record<string, PostHistory> = {}
    let repo: string | null = null
    try {
      const { stdout } = await run('git', gitLogArgs(rel), { maxBuffer: 32 * 1024 * 1024 })
      byFile = parsePostHistory(stdout)
      const remote = await run('git', ['remote', 'get-url', 'origin'])
      repo = repoWebUrl(remote.stdout)
    } catch {
      // No git, no remote, or not a repo. The feature is additive: without
      // history the page renders exactly as it did before it existed.
      return { repo: null, history: {} }
    }

    // One `git show` per commit, not per commit *per post*: the reformat that
    // touched 31 posts is one patch containing all 31, and asking git 31 times
    // for slices of it would be the slowest thing in the build.
    const shas = new Set<string>()
    for (const entry of Object.values(byFile)) {
      // Commits are newest-first, so dropping the last one drops the commit
      // that created the file — whose "diff" is the whole post.
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
        // A patch git won't produce (a binary blob, a broken object) costs the
        // page its diff, not its history.
      }
    }

    const history: Record<string, PostHistory & { file: string }> = {}
    for (const file of (await readdir(dir)).filter((f) => f.endsWith('.md'))) {
      const entry = byFile[`${rel}/${file}`]
      if (!entry) continue
      const { data } = parseFrontmatter(await readFile(path.join(dir, file), 'utf8'))
      const postPath = (data.path as string) ?? `/blog/${file.replace(/\.md$/, '')}`
      history[postPath] = { ...entry, file: `${rel}/${file}` }
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
  plugins: [react(), siteIndex(), postHistory(), postSource()],
  build: {
    // Emit clean, fingerprinted assets; HTML is generated per-route by vite-react-ssg.
    outDir: 'dist',
  },
  ssr: {
    // Bundle the markdown/unified ecosystem for the SSG prerender pass.
    noExternal: ['react-markdown', 'remark-gfm', 'rehype-raw', 'rehype-slug'],
  },
})
