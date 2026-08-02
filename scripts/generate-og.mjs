#!/usr/bin/env node
// Generate the Open Graph card for every prerendered page into dist/og/. Runs after
// `npm run build` (part of the "postbuild" script), alongside the sitemap and llms.txt.
//
//   npm run og                 # render every card (what postbuild does)
//   npm run og -- --only /blog/2021/8/8/ebikes-completely-changed-how-i-get-around
//   npm run og -- --out .og-preview   # render somewhere other than dist/, to look at
//
// Like the sitemap script, this reads the *built* HTML rather than re-deriving the
// site's content: each page's <Seo> already emits the title and description, plus a
// <meta name="og-card"> hint carrying the things only the page knows (its kicker, its
// date/reading-time line, and the photo to use as a background). So the card copy can
// never drift from the copy in the page's own tags.
//
// Two layouts, both 1200x630 (see src/components/Seo.tsx for where they're linked):
//   - photo: pages with a photograph — full-bleed image under an ink scrim.
//   - paper: everything else — the site's paper/ink palette, clay spine, hairline rules.
//
// A page that names its own og:image is skipped entirely: it has a card already
// and doesn't want a generated one. That is how the ~500 photo permalinks stay
// cheap — each of those shares the photograph itself, so rendering a card apiece
// would be most of a deploy for no gain.

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import satori from 'satori'
import { Resvg } from '@resvg/resvg-js'
import sharp from 'sharp'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const DIST = path.join(ROOT, 'dist')
const FONTS = path.join(ROOT, 'node_modules', '@fontsource')
const SITE_NAME = 'Cailin Pitt'
const SITE_HOST = 'cailinpitt.com'

const args = process.argv.slice(2)
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null
const outDir = args.includes('--out')
  ? path.resolve(ROOT, args[args.indexOf('--out') + 1])
  : path.join(DIST, 'og')

// Card geometry. 1200x630 is the size every network crops from; anything important
// stays clear of the outer ~40px, which Twitter/X shaves off in the timeline preview.
const W = 1200
const H = 630

// Straight from src/styles/global.css — the light theme, since a card has no theme
// of its own and paper reads better than ink in a feed.
const C = {
  bg: '#faf8f4',
  fg: '#1b1a17',
  muted: '#766f64',
  rule: '#e5dfd5',
  accent: '#b34a26',
}

// The site's own faces are Iowan Old Style (macOS-only) and system-ui, neither of
// which a Linux build runner has. Source Serif 4 and Inter are the closest open
// stand-ins and ship as .woff in node_modules, so nothing binary lives in the repo.
// satori converts glyphs to paths, so resvg never needs the fonts itself.
const fontFile = (pkg, file) => readFile(path.join(FONTS, pkg, 'files', file))
const fonts = [
  { name: 'Serif', weight: 400, style: 'normal', data: await fontFile('source-serif-4', 'source-serif-4-latin-400-normal.woff') },
  { name: 'Serif', weight: 600, style: 'normal', data: await fontFile('source-serif-4', 'source-serif-4-latin-600-normal.woff') },
  { name: 'Sans', weight: 400, style: 'normal', data: await fontFile('inter', 'inter-latin-400-normal.woff') },
  { name: 'Sans', weight: 500, style: 'normal', data: await fontFile('inter', 'inter-latin-500-normal.woff') },
]

// satori takes React-shaped nodes; these build them without needing JSX in a .mjs.
// Every node is explicitly display:flex, which is all satori's layout engine supports.
const el = (type, style, ...children) => ({
  type,
  props: { style, children: children.length > 1 ? children : children[0] },
})
const row = (style, ...kids) => el('div', { display: 'flex', ...style }, ...kids)
const col = (style, ...kids) => el('div', { display: 'flex', flexDirection: 'column', ...style }, ...kids)
const text = (style, s) => el('div', { display: 'flex', ...style }, s)

// Rough per-character advance widths, in ems, for the auto-fit below. satori gives
// no way to measure text, so the fit is estimated: these are close enough for the
// serif at display sizes, and the layouts leave slack for where they are not.
const NARROW = new Set([...'ijltfrI().,;:\'"!|-'])
const WIDE = new Set([...'mwMW@'])
const charWidth = (ch) => (NARROW.has(ch) ? 0.31 : WIDE.has(ch) ? 0.86 : ch === ch.toUpperCase() && /\p{L}/u.test(ch) ? 0.64 : 0.5)
const wordWidth = (word) => [...word].reduce((sum, ch) => sum + charWidth(ch), 0)

/** Estimated line count for `s` set at `size` px in a `boxWidth` px column. */
function lineCount(s, size, boxWidth) {
  const space = 0.26 * size
  let lines = 1
  let x = 0
  for (const word of s.split(/\s+/)) {
    const w = wordWidth(word) * size
    if (x > 0 && x + space + w > boxWidth) {
      lines += 1
      x = w
    } else {
      x += (x > 0 ? space : 0) + w
    }
  }
  return lines
}

/** Largest size in [min, max] at which `s` wraps to at most `maxLines`. */
function fitSize(s, boxWidth, maxLines, max, min) {
  for (let size = max; size > min; size -= 2) {
    if (lineCount(s, size, boxWidth) <= maxLines) return size
  }
  return min
}

/** Trim to a whole word within `n` characters, so a long dek can't push the layout. */
function clampText(s, n) {
  if (!s || s.length <= n) return s
  const cut = s.slice(0, n)
  return cut.slice(0, cut.lastIndexOf(' ')).replace(/[,;:.\s]+$/, '') + '…'
}

const KICKER = { fontFamily: 'Sans', fontSize: 19, fontWeight: 500, letterSpacing: 2.6, textTransform: 'uppercase' }
const META = { fontFamily: 'Sans', fontSize: 21, letterSpacing: 0.2 }
const TITLE = { fontFamily: 'Serif', fontWeight: 600, lineHeight: 1.12, letterSpacing: -0.5 }
const DEK = { fontFamily: 'Serif', fontSize: 27, lineHeight: 1.45 }

/** Paper card: clay spine bleeding off the left edge, hairline rules top and bottom. */
function paperCard({ title, dek, kicker, meta }) {
  const size = fitSize(title, 960, 3, 74, 40)
  return row({ width: W, height: H, background: C.bg },
    row({ width: 14, height: H, background: C.accent }),
    col({ flex: 1, padding: '46px 56px 42px 52px' },
      row({ justifyContent: 'space-between', alignItems: 'center', borderBottom: `1px solid ${C.rule}`, paddingBottom: 20 },
        text({ ...KICKER, color: C.fg }, SITE_NAME),
        text({ ...KICKER, color: C.accent }, kicker)),
      col({ flex: 1, justifyContent: 'center' },
        text({ ...TITLE, fontSize: size, color: C.fg }, title),
        dek ? text({ ...DEK, color: C.muted, marginTop: 22 }, clampText(dek, 120)) : null),
      // Pages with nothing to date (the section indexes) put the domain on the left
      // rather than leaving a lone item hanging off the right edge.
      row({ justifyContent: 'space-between', alignItems: 'center', borderTop: `1px solid ${C.rule}`, paddingTop: 20 },
        text({ ...META, color: C.muted }, meta ?? SITE_HOST),
        meta ? text({ ...META, color: C.muted }, SITE_HOST) : null))
  )
}

/** Photo card: the same furniture, over a full-bleed photograph darkened by a scrim. */
function photoCard({ title, kicker, meta, src }) {
  const size = fitSize(title, 1000, 3, 68, 38)
  return col({ width: W, height: H, position: 'relative' },
    el('img', { position: 'absolute', top: 0, left: 0, width: W, height: H, objectFit: 'cover' }, undefined),
    col({ position: 'absolute', top: 0, left: 0, width: W, height: H,
      background: 'linear-gradient(to top, rgba(12,11,10,0.93) 14%, rgba(12,11,10,0.58) 50%, rgba(12,11,10,0.18) 100%)' }),
    col({ position: 'absolute', top: 0, left: 0, width: W, height: H, padding: '46px 56px 44px', justifyContent: 'space-between' },
      row({ justifyContent: 'space-between', alignItems: 'center' },
        text({ ...KICKER, color: '#ffffff' }, SITE_NAME),
        text({ ...KICKER, color: '#f0b48a' }, kicker)),
      col({},
        text({ ...TITLE, fontSize: size, color: '#ffffff' }, title),
        row({ alignItems: 'center', marginTop: 22 },
          row({ width: 44, height: 3, background: C.accent, marginRight: 18 }),
          text({ ...META, color: 'rgba(255,255,255,0.85)' }, meta ?? SITE_HOST))))
  )
}

// satori wants `src` as a prop on the <img> itself, which the `el` helper above
// reserves for style; setting it after the tree is built keeps that helper simple.
function setImageSrc(node, src) {
  if (node?.type === 'img') node.props.src = src
  const kids = node?.props?.children
  if (Array.isArray(kids)) kids.forEach((k) => setImageSrc(k, src))
  else if (kids && typeof kids === 'object') setImageSrc(kids, src)
  return node
}

/**
 * A photo, pre-cropped to the card and inlined as a data URI.
 *
 * Images live in R2, not the repo, so the build fetches them — but a local checkout
 * usually has working copies under public/images, which are used first. Cropping here
 * rather than letting satori do it keeps the SVG (and the memory it costs) small.
 */
const photoCache = new Map()
async function loadPhoto(url) {
  if (photoCache.has(url)) return photoCache.get(url)
  const promise = (async () => {
    const local = url.replace(/^https?:\/\/[^/]+/, '')
    const localFile = path.join(ROOT, 'public', local)
    let input
    if (local.startsWith('/images/') && existsSync(localFile)) {
      input = localFile
    } else {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
      input = Buffer.from(await res.arrayBuffer())
    }
    const buf = await sharp(input)
      .resize(W, H, { fit: 'cover', position: 'attention' })
      .jpeg({ quality: 78 })
      .toBuffer()
    return `data:image/jpeg;base64,${buf.toString('base64')}`
  })()
  photoCache.set(url, promise)
  return promise
}

/** Section label for pages that don't name one themselves. */
function kickerFor(route) {
  if (route === '/') return 'Portfolio'
  if (route.startsWith('/blog')) return 'Writing'
  if (route.startsWith('/listening')) return 'Listening'
  if (route.startsWith('/reading')) return 'Reading'
  if (route.startsWith('/projects')) return 'Projects'
  if (route.startsWith('/timeline')) return 'Timeline'
  if (route.startsWith('/colophon')) return 'Colophon'
  return 'Photographs'
}

// --- reading the built pages ------------------------------------------------

async function htmlFiles(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'assets' || entry.name === 'og' || entry.name.startsWith('static-loader')) continue
      out.push(...(await htmlFiles(p)))
    } else if (entry.name.endsWith('.html')) {
      out.push(p)
    }
  }
  return out
}

function toRoute(file) {
  const rel = path.relative(DIST, file).split(path.sep).join('/').replace(/\.html$/, '').replace(/(^|\/)index$/, '$1')
  const clean = '/' + rel.replace(/^\//, '')
  return clean === '/' ? '/' : clean.replace(/\/$/, '')
}

/** Mirrors ogCardPath() in src/components/Seo.tsx — the two must agree. */
const cardFile = (route) => (route === '/' ? 'index' : route.replace(/^\//, '')) + '.jpg'

const decodeEntities = (s) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')

const metaContent = (html, attr, name) => {
  const re = new RegExp(`<meta[^>]+${attr}="${name}"[^>]+content="([^"]*)"`, 'i')
  const alt = new RegExp(`<meta[^>]+content="([^"]*)"[^>]+${attr}="${name}"`, 'i')
  const m = html.match(re) ?? html.match(alt)
  return m ? decodeEntities(m[1]) : undefined
}

function cardSpec(html, route) {
  const fullTitle = metaContent(html, 'property', 'og:title') ?? metaContent(html, 'name', 'twitter:title')
  if (!fullTitle) return null
  // Pages that bring their own image — see the header.
  const image = metaContent(html, 'property', 'og:image')
  if (image && !image.includes(`/og/${cardFile(route)}`)) return null
  // <Seo> appends the site name to every title but the home page's.
  const title = fullTitle.replace(new RegExp(`\\s+—\\s+${SITE_NAME}$`), '')
  const hint = JSON.parse(metaContent(html, 'name', 'og-card') ?? '{}')
  return {
    title,
    dek: metaContent(html, 'property', 'og:description'),
    kicker: hint.kicker ?? kickerFor(route),
    meta: hint.meta,
    photo: hint.photo,
  }
}

async function render(spec) {
  let node
  if (spec.photo) {
    try {
      node = setImageSrc(photoCard(spec), await loadPhoto(spec.photo))
    } catch (err) {
      // A missing or unfetchable photo is not worth failing a deploy over — the
      // paper card says the same thing.
      console.warn(`  ! photo unavailable (${spec.photo}): ${err.message} — using the paper card`)
    }
  }
  const svg = await satori(node ?? paperCard(spec), { width: W, height: H, fonts })
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: W } }).render().asPng()
  // JPEG, not the PNG resvg hands back: a hundred photo cards at ~400 KB each is
  // most of a deploy. Chroma subsampling stays off so the type keeps its edges.
  return sharp(png).jpeg({ quality: 84, chromaSubsampling: '4:4:4', mozjpeg: true }).toBuffer()
}

async function main() {
  if (!existsSync(DIST)) {
    console.error('✗ No dist/ — run `npm run build` first.')
    process.exit(1)
  }
  const files = (await htmlFiles(DIST)).sort()
  let written = 0
  let photos = 0
  for (const file of files) {
    const route = toRoute(file)
    if (only && route !== only) continue
    const spec = cardSpec(await readFile(file, 'utf8'), route)
    if (!spec) continue
    const out = path.join(outDir, cardFile(route))
    await mkdir(path.dirname(out), { recursive: true })
    await writeFile(out, await render(spec))
    if (spec.photo) photos += 1
    written += 1
  }
  const where = path.relative(ROOT, outDir)
  console.log(
    `✓ ${written} og cards in ${where}/ (${photos} over photographs, ${files.length - written} pages skipped)`,
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
