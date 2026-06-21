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

  const wellKnown = path.join(DIST, '.well-known')
  await mkdir(wellKnown, { recursive: true })
  await writeFile(path.join(wellKnown, 'site.standard.publication'), records.publication + '\n', 'utf8')
  console.log(`✓ .well-known/site.standard.publication → ${records.publication}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
