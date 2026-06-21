#!/usr/bin/env node
// Emit dist/.well-known/site.standard.publication from content/atproto.json — Phase 8.
// Runs after `npm run build` (part of "postbuild"). The file's body is the AT-URI of
// the publication record, which lets AT Protocol clients link this website to its
// standard.site records. No-op (skipped) until `npm run publish:atproto` has populated
// content/atproto.json with a publication URI.
//
// See https://standard.site/docs — the .well-known endpoint returns the publication AT-URI.

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const DIST = path.join(ROOT, 'dist')
const RECORDS_FILE = path.join(ROOT, 'content', 'atproto.json')

async function main() {
  if (!existsSync(DIST)) {
    console.error('✗ No dist/ — run `npm run build` first.')
    process.exit(1)
  }

  let records = {}
  try {
    records = JSON.parse(await readFile(RECORDS_FILE, 'utf8'))
  } catch {
    /* no records file yet */
  }

  if (!records.publication) {
    console.log('· standard.site: no publication URI yet — run `npm run publish:atproto`. Skipping.')
    return
  }

  // The well-known endpoint location depends on the publication url: at the domain
  // root it's /.well-known/site.standard.publication; if the publication lives under a
  // path (e.g. /blog), the path is appended → /.well-known/site.standard.publication/blog.
  // See https://standard.site/docs/verification.
  let endpoint = 'site.standard.publication'
  if (records.publicationUrl) {
    const pubPath = new URL(records.publicationUrl).pathname.replace(/^\/+|\/+$/g, '')
    if (pubPath) endpoint = `site.standard.publication/${pubPath}`
  }
  const file = path.join(DIST, '.well-known', ...endpoint.split('/'))
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, records.publication + '\n', 'utf8')
  console.log(`✓ .well-known/${endpoint} → ${records.publication}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
