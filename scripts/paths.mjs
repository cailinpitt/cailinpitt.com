// Where the web-sized image renditions live on disk.
//
// `images/` sits at the repo root rather than under `public/`, and deliberately:
// Vite copies the whole of public/ into dist/, but nothing on the built site
// ever requests a /images/... path — src/lib/images.ts rewrites every one of
// them to https://images.cailinpitt.com at render time. Keeping the renditions
// in public/ meant uploading ~240 MB to GitHub Pages on every deploy to serve
// files no page asks for.
//
// So this is a local staging area, not a served directory: images:sync writes
// renditions here from originals/, images:upload pushes them to R2, and that is
// the only way they reach a browser. It is gitignored, like originals/.

import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** The renditions directory itself. */
export const IMAGES_DIR = path.join(ROOT, 'images')

/**
 * The file behind a root-relative src.
 *
 * Manifest entries and Markdown both store `/images/2026/x.webp`, which is the
 * R2 object key with a leading slash — and now also the path from the repo root,
 * which is what makes this a plain join.
 */
export const localImagePath = (src) => path.join(ROOT, src)
