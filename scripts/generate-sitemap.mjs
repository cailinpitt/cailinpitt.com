#!/usr/bin/env node
// Generate dist/sitemap.xml from the prerendered HTML files. Runs automatically after
// `npm run build` (as the "postbuild" script), so every static route is included without
// having to maintain a separate URL list.

import { readdir, writeFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const DIST = path.join(ROOT, 'dist')
const SITE = 'https://cailinpitt.com'

async function htmlFiles(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'assets' || entry.name.startsWith('static-loader')) continue
      out.push(...(await htmlFiles(p)))
    } else if (entry.name.endsWith('.html') && entry.name !== '404.html') {
      out.push(p)
    }
  }
  return out
}

function toUrlPath(file) {
  let rel = path.relative(DIST, file).split(path.sep).join('/')
  rel = rel.replace(/\.html$/, '')
  rel = rel.replace(/(^|\/)index$/, '$1')
  const clean = '/' + rel.replace(/^\//, '')
  return clean === '/' ? '/' : clean.replace(/\/$/, '')
}

async function main() {
  if (!existsSync(DIST)) {
    console.error('✗ No dist/ — run `npm run build` first.')
    process.exit(1)
  }
  const files = await htmlFiles(DIST)
  const urls = await Promise.all(
    files.map(async (f) => {
      const lastmod = (await stat(f)).mtime.toISOString().slice(0, 10)
      return { loc: SITE + toUrlPath(f), lastmod }
    }),
  )
  urls.sort((a, b) => a.loc.localeCompare(b.loc))

  const body = urls
    .map((u) => `  <url><loc>${u.loc}</loc><lastmod>${u.lastmod}</lastmod></url>`)
    .join('\n')
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`

  await writeFile(path.join(DIST, 'sitemap.xml'), xml, 'utf8')
  console.log(`✓ sitemap.xml with ${urls.length} URLs`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
