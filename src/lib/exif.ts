// Capture metadata carried by gallery images, and how it's phrased in the UI.
// Written into src/lib/gallery-images.json by `npm run images:sync`, which reads
// it from the originals — see scripts/exif.mjs for where each field comes from.
//
// Everything is optional. Only galleries built from originals/ have any of this:
// the pre-2026 photos came from Squarespace with their EXIF already stripped, so
// most images carry no `exif` at all and the caption simply omits the line.

export interface PhotoExif {
  /** Camera wall clock, without a timezone: "2026-07-18T19:32:23". */
  shot?: string
  /** Model, e.g. "iPhone 15" — or the make, for files that omit the model. */
  camera?: string
  fNumber?: number
  /** Shutter speed in seconds (0.0167 = 1/60). */
  exposure?: number
  iso?: number
  /** Actual focal length in mm, not 35mm-equivalent. */
  focalLength?: number
  /**
   * [lat, lon], rounded to ~0.7 miles. Deliberately coarse — see scripts/exif.mjs.
   * Not a tuple type: the manifest is a JSON import, which infers number[], and
   * widening here beats casting the whole manifest through `unknown`.
   */
  place?: number[]
}

const dateFmt = new Intl.DateTimeFormat('en-US', {
  month: 'long',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
})

/**
 * "July 18, 2026" from a stored wall clock. The stamp has no zone, so only the
 * date half is used and it's pinned to UTC — letting the browser's zone near it
 * would slide an evening photo onto the next day.
 */
export function formatShotDate(shot?: string): string | null {
  if (!shot) return null
  const parsed = new Date(`${shot.slice(0, 10)}T12:00:00Z`)
  return Number.isNaN(parsed.getTime()) ? null : dateFmt.format(parsed)
}

const shortDateFmt = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
})

/** "Jul 18" — the compact form, for labels over a thumbnail. */
export function formatShotDateShort(shot?: string): string | null {
  if (!shot) return null
  const parsed = new Date(`${shot.slice(0, 10)}T12:00:00Z`)
  return Number.isNaN(parsed.getTime()) ? null : shortDateFmt.format(parsed)
}

/** Trim a trailing ".0" so f/8 doesn't render as "f/8.0". */
const trim = (value: number, places: number) =>
  Number(value.toFixed(places)).toString()

/** "1/60" for fractions of a second, "2.5s" for long exposures. */
export function formatExposure(seconds?: number): string | null {
  if (!seconds || seconds <= 0) return null
  if (seconds >= 1) return `${trim(seconds, 1)}s`
  return `1/${Math.round(1 / seconds)}`
}

/**
 * The shooting settings as one line: "ƒ/1.6 · 1/60 · ISO 100 · 6mm". Returns null
 * when a photo carries none of them, so the caption can skip the whole row.
 */
export function formatSettings(exif?: PhotoExif): string | null {
  if (!exif) return null
  const parts = [
    exif.fNumber ? `ƒ/${trim(exif.fNumber, 1)}` : null,
    formatExposure(exif.exposure),
    exif.iso ? `ISO ${exif.iso}` : null,
    exif.focalLength ? `${Math.round(exif.focalLength)}mm` : null,
  ].filter(Boolean)
  return parts.length ? parts.join(' · ') : null
}

/** "July 18, 2026 · iPhone 15" — either half may be missing. */
export function formatCapture(exif?: PhotoExif): string | null {
  if (!exif) return null
  const parts = [formatShotDate(exif.shot), exif.camera].filter(Boolean)
  return parts.length ? parts.join(' · ') : null
}
