// One flat, chronological feed of every photograph on the site.
//
// There used to be a gallery per year, each with its own URL preserved from
// Squarespace and a lightbox addressed by `?photo=12`. That's gone: photos are
// one stream now, newest first, and every frame has a page of its own at
// /photos/<id>.
//
// The manifest (src/lib/photos.json) is written by `npm run images:sync` from
// what's on disk under images/<year>/ — see that script for how each
// field is filled in. Two fields are load-bearing enough to say twice:
//
//   id     the permalink. Assigned once, when a file is first seen, and then
//          never recomputed — renaming the file on disk must not 404 the page.
//   date   the sort key, and the only thing that decides feed order.

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
  /**
   * Grid rendition widths that exist for this photo, narrowest first — what
   * `thumbSrcset` offers the browser. Absent on an entry synced before the
   * smaller sizes existed, which falls back to `thumb` alone.
   */
  widths?: number[]
  alt: string
  /** Dimensions of `src`, to hold the aspect ratio and prevent layout shift. */
  width?: number
  height?: number
  /**
   * Average color of the photograph, `#rrggbb`, written by `npm run images:sync`
   * (see scripts/tint.mjs). Painted under the image so a tile that hasn't loaded
   * yet is roughly the right color instead of a gray rectangle. Absent for a
   * photo synced before this existed, which simply falls back to the surface.
   */
  tint?: string
  /**
   * When the photo was taken, as a wall clock without a zone
   * ("2026-07-18T19:32:23") — the same shape as `exif.shot`, which is where it
   * comes from when the original still carries EXIF.
   */
  date: string
  /**
   * The year the photo is filed under, which is not always `date`'s year: for an
   * approximate photo the date may be a Squarespace *upload* time that landed in
   * the following year. This is the label, and the feed's grouping.
   */
  year: string
  /**
   * Set when `date` is not a capture time. The pre-2026 photos came back from
   * Squarespace EXIF-stripped, so their dates are the day the file was uploaded
   * there (recovered from the export) or, failing that, the first of their year.
   * That's a real ordering signal but not a real day, so the UI shows only the
   * year for these — see formatPhotoDate.
   */
  approx?: boolean
  /** Capture metadata, when the original had any. */
  exif?: PhotoExif
}

/**
 * Newest first: by year, then by date within it, with the id as a stable
 * tiebreak. Year leads rather than date because an approximate date can sit
 * outside the year the photo is filed under.
 */
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

/**
 * Grid rendition widths, narrowest first. Mirrors GRID_WIDTHS in
 * scripts/photo-manifest.mjs, which is what encodes them; tests/photos.test.ts
 * pins the two together, because a width listed here that was never encoded is
 * a 404 the browser picks on its own.
 */
export const GRID_WIDTHS = [400, 800, 1000]

/** The grid rendition of `src` at `width`: /images/2026/x.webp -> …/x-400.webp */
export const renditionPath = (src: string, width: number) =>
  src.replace(/\.[^.]+$/, `-${width}.webp`)

/**
 * The `srcset` for a grid tile, or undefined when the photo has only the one
 * rendition and a plain `src` says the same thing.
 *
 * Paired with a `sizes` that describes the three-across feed, this is what stops
 * a phone downloading a 1000px file to paint a 117px square.
 */
export function thumbSrcset(photo: Pick<Photo, 'src' | 'widths'>): string | undefined {
  if (!photo.widths || photo.widths.length < 2) return undefined
  return photo.widths.map((w) => `${imageUrl(renditionPath(photo.src, w))} ${w}w`).join(', ')
}

/**
 * How wide a feed tile actually paints: three across a grid that is 92vw until
 * it hits the 58rem cap, less the two 4px gaps. Kept next to the srcset it
 * describes — the two only work as a pair, and a `sizes` that disagrees with
 * the CSS makes the browser choose the wrong file with total confidence.
 */
export const FEED_TILE_SIZES = '(min-width: 63rem) 306px, 30vw'

/** Anchor id for the first photo of a year, so /photos#y2019 still lands. */
export const yearAnchor = (year: string) => `y${year}`

/**
 * The id of the first photo of each year in a sorted feed — the tiles that carry
 * a year anchor. A set of ids rather than positions so the caller can ask about
 * a photo it's already holding.
 */
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
