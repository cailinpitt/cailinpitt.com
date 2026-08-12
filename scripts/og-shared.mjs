// Shared by scripts/generate-og.mjs and scripts/generate-note-og.mjs: font
// loading, satori's JSX-builder helpers, auto-fit text sizing, and the
// satori -> resvg -> sharp encode pipeline.

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import satori from 'satori'
import { Resvg } from '@resvg/resvg-js'
import sharp from 'sharp'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FONTS = path.join(ROOT, 'node_modules', '@fontsource')

export const W = 1200
export const H = 630

const fontFile = (pkg, file) => readFile(path.join(FONTS, pkg, 'files', file))

export async function loadFonts() {
  return [
    { name: 'Serif', weight: 400, style: 'normal', data: await fontFile('source-serif-4', 'source-serif-4-latin-400-normal.woff') },
    { name: 'Serif', weight: 600, style: 'normal', data: await fontFile('source-serif-4', 'source-serif-4-latin-600-normal.woff') },
    { name: 'Sans', weight: 400, style: 'normal', data: await fontFile('inter', 'inter-latin-400-normal.woff') },
    { name: 'Sans', weight: 500, style: 'normal', data: await fontFile('inter', 'inter-latin-500-normal.woff') },
    { name: 'Mono', weight: 400, style: 'normal', data: await fontFile('jetbrains-mono', 'jetbrains-mono-latin-400-normal.woff') },
    { name: 'Mono', weight: 600, style: 'normal', data: await fontFile('jetbrains-mono', 'jetbrains-mono-latin-600-normal.woff') },
  ]
}

export const el = (type, style, ...children) => ({
  type,
  props: { style, children: children.length > 1 ? children : children[0] },
})
export const row = (style, ...kids) => el('div', { display: 'flex', ...style }, ...kids)
export const col = (style, ...kids) => el('div', { display: 'flex', flexDirection: 'column', ...style }, ...kids)
export const text = (style, s) => el('div', { display: 'flex', ...style }, s)

const NARROW = new Set([...'ijltfrI().,;:\'"!|-'])
const WIDE = new Set([...'mwMW@'])
const charWidth = (ch) =>
  NARROW.has(ch) ? 0.31 : WIDE.has(ch) ? 0.86 : ch === ch.toUpperCase() && /\p{L}/u.test(ch) ? 0.64 : 0.5
const wordWidth = (word) => [...word].reduce((sum, ch) => sum + charWidth(ch), 0)

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

/** Largest size in [min, max] at which `s` wraps to at most `maxLines`. satori can't measure text itself. */
export function fitSize(s, boxWidth, maxLines, max, min) {
  for (let size = max; size > min; size -= 2) {
    if (lineCount(s, size, boxWidth) <= maxLines) return size
  }
  return min
}

export function clampText(s, n) {
  if (!s || s.length <= n) return s
  const cut = s.slice(0, n)
  return cut.slice(0, cut.lastIndexOf(' ')).replace(/[,;:.\s]+$/, '') + '…'
}

export async function renderCard(node, fonts) {
  const svg = await satori(node, { width: W, height: H, fonts })
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: W } }).render().asPng()
  // JPEG, not the PNG resvg returns — much smaller, and chroma subsampling
  // stays off so text keeps sharp edges.
  return sharp(png).jpeg({ quality: 84, chromaSubsampling: '4:4:4', mozjpeg: true }).toBuffer()
}
