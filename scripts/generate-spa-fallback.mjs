#!/usr/bin/env node
// dist/404.html = dist/index.html, so GitHub Pages' 404 fallback boots the SPA instead of a
// dead static page — a direct hit on a client-only route (/timeline/<date>, /notes/tag/<tag>)
// had no prerendered file and nothing else to serve it. NotFound.tsx (the `*` route) now
// covers genuinely unknown paths once JS loads.

import { copyFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DIST = path.resolve(__dirname, '..', 'dist')

await copyFile(path.join(DIST, 'index.html'), path.join(DIST, '404.html'))
