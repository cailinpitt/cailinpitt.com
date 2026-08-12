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
// Three layouts, all 1200x630 (see src/components/Seo.tsx for where they're linked):
//   - terminal: /terminal only, via `layout: 'terminal'` in the hint — its own dark screen.
//   - photo: pages with a photograph — full-bleed image under an ink scrim.
//   - paper: everything else — the site's paper/ink palette, clay spine, hairline rules.
//
// A page that names its own og:image is skipped entirely: it has a card already
// and doesn't want a generated one. That is how the ~500 photo permalinks stay
// cheap — each of those shares the photograph itself, so rendering a card apiece
// would be most of a deploy for no gain.
//
// The ~360 /listening period pages do the same, pointing at /og/listening.jpg.
// At ~1 card/second they were adding ~6 minutes to every build for URLs nobody
// shares. See LISTENING_OG_CARD in src/lib/listening.ts. The six wrapped pages
// are excluded from that and still render their own.

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { W, H, loadFonts, el, row, col, text, fitSize, clampText, renderCard } from './og-shared.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
import { localImagePath } from './paths.mjs'
const DIST = path.join(ROOT, 'dist')
const SITE_NAME = 'Cailin Pitt'
const SITE_HOST = 'cailinpitt.com'

const args = process.argv.slice(2)
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null
const outDir = args.includes('--out')
  ? path.resolve(ROOT, args[args.indexOf('--out') + 1])
  : path.join(DIST, 'og')

// Straight from src/styles/global.css — the light theme, since a card has no theme
// of its own and paper reads better than ink in a feed.
const C = {
  bg: '#faf8f4',
  fg: '#1b1a17',
  muted: '#766f64',
  rule: '#e5dfd5',
  accent: '#b34a26',
}

// The dark theme, for the terminal card — the one page that is ink-on-screen.
const D = {
  bg: '#141312',
  fg: '#ece8e1',
  muted: '#a49c90',
  rule: '#2c2a26',
  accent: '#e3925b',
}

const fonts = await loadFonts()

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

const MONO = { fontFamily: 'Mono' }
/** JetBrains Mono's advance width, in ems. Every glyph is this wide. */
const CH = 0.6

/** Largest size in [min, max] at which `s` fits one monospace line in `boxWidth`. */
const monoFit = (s, boxWidth, max, min) =>
  Math.max(min, Math.min(max, Math.floor(boxWidth / (s.length * CH))))

/** Terminal card: the /terminal page's own dark screen, as a session. */
function terminalCard({ title, dek, kicker, meta }) {
  const prompt = (after) =>
    row({ alignItems: 'center' },
      text({ ...MONO, fontSize: 26, color: D.accent, marginRight: 14 }, '~ $'),
      after)

  return col({ width: W, height: H, background: D.bg, padding: '46px 56px 44px' },
    row({ justifyContent: 'space-between', alignItems: 'center', borderBottom: `1px solid ${D.rule}`, paddingBottom: 20 },
      text({ ...MONO, fontSize: 19, letterSpacing: 2.2, color: D.muted }, 'cailin@cailinpitt.com'),
      text({ ...MONO, fontSize: 19, letterSpacing: 2.6, textTransform: 'uppercase', color: D.accent }, kicker)),
    col({ flex: 1, justifyContent: 'center' },
      prompt(text({ ...MONO, fontSize: 26, color: D.fg }, 'open /terminal')),
      text({ ...MONO, fontWeight: 600, fontSize: monoFit(title, 1040, 66, 30), color: D.fg, marginTop: 26 }, title),
      dek ? text({ ...MONO, fontSize: 24, lineHeight: 1.5, color: D.muted, marginTop: 20 }, clampText(dek, 108)) : null,
      // A block cursor, which is the one thing that says "this is still waiting for you".
      row({ marginTop: 30 }, prompt(row({ width: 15, height: 26, background: D.accent })))),
    row({ justifyContent: 'space-between', alignItems: 'center', borderTop: `1px solid ${D.rule}`, paddingTop: 20 },
      text({ ...MONO, fontSize: 20, color: D.muted }, meta ?? SITE_HOST),
      text({ ...MONO, fontSize: 20, color: D.muted }, SITE_HOST))
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
 * usually has working copies under images, which are used first. Cropping here
 * rather than letting satori do it keeps the SVG (and the memory it costs) small.
 */
const photoCache = new Map()
async function loadPhoto(url) {
  if (photoCache.has(url)) return photoCache.get(url)
  const promise = (async () => {
    const local = url.replace(/^https?:\/\/[^/]+/, '')
    const localFile = localImagePath(local)
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

/**
 * Section label for pages that don't name one themselves.
 *
 * Only the routes whose label *isn't* their own name are listed; everything else
 * falls back to the first path segment, title-cased. That way a page added later
 * gets a correct kicker without anyone remembering to come back here — which is
 * exactly what went wrong when this ended in a bare `return 'Photographs'` and
 * /now, /uses, /guestbook, and /privacy all quietly claimed to be photography.
 */
function kickerFor(route) {
  if (route === '/') return 'Portfolio'
  if (route.startsWith('/blog')) return 'Writing'
  if (route.startsWith('/photos')) return 'Photographs'

  const segment = route.split('/').filter(Boolean)[0]
  if (!segment) return 'Portfolio'
  return segment
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
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
    layout: hint.layout,
  }
}

async function render(spec) {
  let node
  if (spec.layout === 'terminal') {
    node = terminalCard(spec)
  } else if (spec.photo) {
    try {
      node = setImageSrc(photoCard(spec), await loadPhoto(spec.photo))
    } catch (err) {
      // A missing or unfetchable photo is not worth failing a deploy over — the
      // paper card says the same thing.
      console.warn(`  ! photo unavailable (${spec.photo}): ${err.message} — using the paper card`)
    }
  }
  return renderCard(node ?? paperCard(spec), fonts)
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
