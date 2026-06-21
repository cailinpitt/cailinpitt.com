#!/usr/bin/env node
// Pull the yearly photo galleries from the still-live Squarespace site
// (cailinpitt.squarespace.com) into public/images/<gallery>/, and emit
// src/lib/gallery-images.json mapping each gallery to its image list.
//
// Idempotent: already-downloaded files are skipped. Re-run any time.
//
//   node scripts/download-galleries.mjs

import { mkdir, writeFile, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const IMAGES = path.join(ROOT, 'public', 'images')
const DATA = path.join(ROOT, 'src', 'lib', 'gallery-images.json')

const BASE = 'https://cailinpitt.squarespace.com'
const FORMAT = '1500w' // web-appropriate; original aspect ratio is preserved
const CONCURRENCY = 8

// [squarespace path, local folder, label used for generated alt text]
const GALLERIES = [
  ['2022', '2022', '2022'],
  ['2021', '2021', '2021'],
  ['2020', '2020', '2020'],
  ['2019', '2019', '2019'],
  ['2018', '2018', '2018'],
  ['latest-work', 'latest-work', '2017'],
  ['latest', 'latest', '2016'],
  ['2015', '2015', '2015'],
  ['2014', '2014', '2014'],
]

const EXT_BY_TYPE = { 'image/webp': '.webp', 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif' }

function parseImages(html) {
  const tags = html.match(/<img\b[^>]*>/g) || []
  const seen = new Set()
  const out = []
  for (const t of tags) {
    const url = (t.match(/data-(?:src|image)="(https:\/\/images\.squarespace-cdn\.com[^"?]*)/) || [])[1]
    if (!url || seen.has(url)) continue
    seen.add(url)
    const d = t.match(/data-image-dimensions="(\d+)x(\d+)"/) || []
    const alt = (t.match(/\balt="([^"]*)"/) || [])[1] || ''
    out.push({ url, width: +d[1] || undefined, height: +d[2] || undefined, rawAlt: alt })
  }
  return out
}

// Squarespace alts are usually just the filename; fall back to a clean label.
function makeAlt(raw, label) {
  const a = (raw || '').trim()
  const looksLikeFilename =
    /\.(jpe?g|png|webp|gif|heic)$/i.test(a) || /^(img|dji|dsc|image-asset|screen|unnamed)/i.test(a) || !/\s/.test(a)
  return a && !looksLikeFilename ? a : `Photograph — ${label}`
}

function baseName(url) {
  return decodeURIComponent(url.split('/').pop() || 'image').replace(/\.[a-z0-9]+$/i, '') || 'image'
}

async function download(url, destDir, taken) {
  // Force JPEG (exclude webp from Accept) so every file has one consistent extension.
  const res = await fetch(`${url}?format=${FORMAT}`, { headers: { Accept: 'image/jpeg,image/png' } })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  const ext = EXT_BY_TYPE[res.headers.get('content-type')] || '.jpg'
  let name = baseName(url).replace(/[^\w.-]+/g, '-')
  let file = `${name}${ext}`
  let i = 2
  while (taken.has(file)) file = `${name}-${i++}${ext}`
  taken.add(file)
  const dest = path.join(destDir, file)
  if (!existsSync(dest)) {
    const buf = Buffer.from(await res.arrayBuffer())
    await writeFile(dest, buf)
  }
  return file
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

async function main() {
  const manifest = {}
  for (const [spath, folder, label] of GALLERIES) {
    const html = await (await fetch(`${BASE}/${spath}`)).text()
    const imgs = parseImages(html)
    const destDir = path.join(IMAGES, folder)
    await mkdir(destDir, { recursive: true })
    const taken = new Set()
    const records = await mapLimit(imgs, CONCURRENCY, async (im) => {
      try {
        const file = await download(im.url, destDir, taken)
        return { src: `/images/${folder}/${file}`, alt: makeAlt(im.rawAlt, label), width: im.width, height: im.height }
      } catch (err) {
        console.warn(`  ⚠ skipped ${im.url.split('/').pop()}: ${err.message}`)
        return null
      }
    })
    manifest[folder] = records.filter(Boolean)
    console.log(`✓ /${spath} -> ${records.length} images`)
  }
  await writeFile(DATA, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  const total = Object.values(manifest).reduce((n, a) => n + a.length, 0)
  console.log(`\n✓ ${total} images across ${Object.keys(manifest).length} galleries → ${path.relative(ROOT, DATA)}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
