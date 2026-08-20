// One flat, chronological feed of every photograph on the site (replaced the old per-year
// galleries). Manifest is src/lib/photos.json, written by `npm run images:sync`. `id` is
// assigned once and never recomputed, so renaming the file on disk can't 404 the page; `date` is the sort key.

import type { PhotoExif } from './exif'
import { formatShotDate, formatShotDateShort } from './exif'
import { imageUrl } from './images'

export interface Photo {
  /** Permalink slug: /photos/<id>. Stable for the life of the photo. */
  id: string
  /** Full-size rendition — what the photo's own page loads. */
  src: string
  /** Grid rendition (1000px), generated alongside `src` by `npm run images:sync`. */
  thumb?: string
  /** Grid rendition widths, narrowest first — what `thumbSrcset` offers. Absent pre-migration entries fall back to `thumb` alone. */
  widths?: number[]
  alt: string
  /** Dimensions of `src`, to hold the aspect ratio and prevent layout shift. */
  width?: number
  height?: number
  /** Average color, `#rrggbb` (scripts/tint.mjs), painted under an unloaded tile instead of gray. Absent pre-migration. */
  tint?: string
  /** Wall clock without a zone ("2026-07-18T19:32:23"), same shape as `exif.shot` when it's the source. */
  date: string
  /** The filing year — not always `date`'s year, since an approximate date may be a Squarespace upload time that landed the next year. */
  year: string
  /** Set when `date` isn't a real capture time (pre-2026 Squarespace uploads, EXIF-stripped) — UI shows only the year for these, see formatPhotoDate. */
  approx?: boolean
  /** Capture metadata, when the original had any. */
  exif?: PhotoExif
}

// Newest first: by year, then date within it, id as a stable tiebreak. Year leads because an
// approximate date can sit outside the year the photo is filed under.
export function byNewest(a: Photo, b: Photo): number {
  if (a.year !== b.year) return a.year < b.year ? 1 : -1
  if (a.date !== b.date) return a.date < b.date ? 1 : -1
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
}

/**
 * How a photo's date is phrased: "July 18, 2026" for a capture time, bare
 * "2019" when all we honestly know is the year.
 */
export function formatPhotoDate(photo: Photo): string {
  if (photo.approx) return photo.year
  return formatShotDate(photo.date) ?? photo.year
}

/** The compact form, for a label under a thumbnail: "Jul 18", or the year. */
export function formatPhotoDateShort(photo: Photo): string {
  if (photo.approx) return photo.year
  return formatShotDateShort(photo.date) ?? photo.year
}

/** A thumbnail in a "recent photos" strip — see src/components/PhotoStrip.tsx. */
export interface PhotoPreview {
  href: string
  src: string
  /** Same narrow-first candidate list the feed tiles get; see thumbSrcset. */
  srcset?: string
  /** "Jul 18" for a photo with a capture time, else its year. */
  label: string
  /** Placeholder color, as on the feed tiles. */
  tint?: string
}

/** The newest `count` photographs, each linking to its own page. */
export function toPreviews(photos: Photo[], count: number): PhotoPreview[] {
  return photos.slice(0, count).map((photo) => {
    const srcset = thumbSrcset(photo)
    return {
      href: `/photos/${photo.id}`,
      src: photo.thumb ?? photo.src,
      ...(srcset ? { srcset } : {}),
      label: formatPhotoDateShort(photo),
      tint: photo.tint,
    }
  })
}

// Mirrors GRID_WIDTHS in scripts/photo-manifest.mjs (which encodes them); tests/photos.test.ts
// pins the two together, since a width listed but never encoded is a 404.
export const GRID_WIDTHS = [400, 800, 1000]

/** The grid rendition of `src` at `width`: /images/2026/x.webp -> …/x-400.webp */
export const renditionPath = (src: string, width: number) =>
  src.replace(/\.[^.]+$/, `-${width}.webp`)

// undefined when the photo has only one rendition. Paired with a `sizes` describing the
// three-across feed, this stops a phone downloading a 1000px file to paint a 117px square.
export function thumbSrcset(photo: Pick<Photo, 'src' | 'widths'>): string | undefined {
  if (!photo.widths || photo.widths.length < 2) return undefined
  return photo.widths.map((w) => `${imageUrl(renditionPath(photo.src, w))} ${w}w`).join(', ')
}

// Three across a grid that's 92vw until the 58rem cap, less two 4px gaps. Kept next to the
// srcset it describes — a `sizes` that disagrees with the CSS picks the wrong file confidently.
export const FEED_TILE_SIZES = '(min-width: 63rem) 306px, 30vw'

/** Anchor id for the first photo of a year, so /photos#y2019 still lands. */
export const yearAnchor = (year: string) => `y${year}`

// The id of the first photo of each year — a set rather than positions, so the caller can
// ask about a photo it's already holding.
export function photoYearBreaks(photos: { id: string; year: string }[]): Set<string> {
  const first = new Set<string>()
  let year: string | null = null
  for (const photo of photos) {
    if (photo.year === year) continue
    year = photo.year
    first.add(photo.id)
  }
  return first
}

/** Where a photo sits in the feed, for its page's previous/next links. */
export function photoNeighbors(photos: Photo[], id: string) {
  const index = photos.findIndex((photo) => photo.id === id)
  if (index < 0) return { index, photo: undefined, newer: undefined, older: undefined }
  return {
    index,
    photo: photos[index],
    // The feed is newest-first, so the newer photo is the one before it.
    newer: photos[index - 1],
    older: photos[index + 1],
  }
}

// All images are served from R2; see src/lib/images.ts.
export { imageUrl } from './images'
