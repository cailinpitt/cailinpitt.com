// Capture metadata read off a photo's original, for the gallery manifest.
//
// Only originals carry this: the web renditions are encoded with EXIF stripped
// (see sync-images.mjs), and the pre-2026 galleries came from Squarespace, which
// stripped it before we ever saw the files. So most images have no metadata and
// that's expected — every field here is optional, and a photo with nothing
// usable gets no `exif` key at all rather than an object full of nulls.
//
// Reading needs `sharp`, which sync-images.mjs already requires to encode
// renditions from originals/ — no new dependency on the path that has originals.

import exifReader from 'exif-reader'

/**
 * Coordinates are rounded to 2 decimal places — about 0.7 miles. That's enough
 * to place a photo on a map or name the neighborhood, and not enough to point at
 * a house. The manifest is committed and served to browsers, so this rounding is
 * the privacy boundary: full precision stays in the originals, which are
 * gitignored and never uploaded.
 */
const GPS_DECIMALS = 2

/** [degrees, minutes, seconds] + a N/S/E/W reference → signed decimal degrees. */
function toDecimal(dms, ref) {
  if (!Array.isArray(dms) || dms.length < 3) return null
  const [deg, min, sec] = dms.map(Number)
  if (![deg, min, sec].every(Number.isFinite)) return null
  const magnitude = deg + min / 60 + sec / 3600
  const signed = ref === 'S' || ref === 'W' ? -magnitude : magnitude
  return Number(signed.toFixed(GPS_DECIMALS))
}

/**
 * EXIF timestamps carry no timezone — "2026:07:18 19:32:23" is just what the
 * camera's clock read. exif-reader parses that string into the *UTC* fields of a
 * Date, so the wall clock has to be read back with the UTC getters: using local
 * ones would shift every photo by the offset of whichever machine ran the sync,
 * which is both wrong and not reproducible.
 *
 * Stored back without a zone ("2026-07-18T19:32:23"), so anything formatting it
 * must likewise treat it as floating local time or photos drift across midnight.
 */
function toWallClock(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return null
  // Squarespace's exports carry a zeroed DateTime that decodes to the Unix epoch,
  // which is a valid Date and would otherwise caption 259 photos "December 31,
  // 1969". Anything outside a plausible range is a sentinel, not a capture time.
  const year = date.getUTCFullYear()
  if (year < 1990 || year > new Date().getUTCFullYear() + 1) return null
  const pad = (n) => String(n).padStart(2, '0')
  return (
    `${year}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
  )
}

const num = (value) => {
  const n = Number(Array.isArray(value) ? value[0] : value)
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * Read capture metadata from `file`. Returns null when there's nothing usable,
 * so callers can leave the manifest entry untouched.
 */
export async function readPhotoExif(sharp, file) {
  let raw
  try {
    raw = (await sharp(file).metadata()).exif
  } catch {
    return null // unreadable or not an image sharp handles
  }
  if (!raw) return null

  let tags
  try {
    tags = exifReader(raw)
  } catch {
    return null // present but malformed
  }

  const image = tags.Image ?? {}
  const photo = tags.Photo ?? {}
  const gps = tags.GPSInfo ?? {}

  // Model alone reads better than "Apple iPhone 15" and is what the caption
  // shows; Make is only a fallback for files that omit the model.
  const camera = (image.Model || image.Make || '').trim() || null
  const shot = toWallClock(photo.DateTimeOriginal ?? image.DateTime ?? null)
  const place =
    gps.GPSLatitude && gps.GPSLongitude
      ? [toDecimal(gps.GPSLatitude, gps.GPSLatitudeRef), toDecimal(gps.GPSLongitude, gps.GPSLongitudeRef)]
      : null

  const exif = {
    ...(shot ? { shot } : {}),
    ...(camera ? { camera } : {}),
    ...(num(photo.FNumber) ? { fNumber: num(photo.FNumber) } : {}),
    ...(num(photo.ExposureTime) ? { exposure: num(photo.ExposureTime) } : {}),
    ...(num(photo.ISOSpeedRatings) ? { iso: num(photo.ISOSpeedRatings) } : {}),
    ...(num(photo.FocalLength) ? { focalLength: num(photo.FocalLength) } : {}),
    ...(place && place.every((v) => v != null) ? { place } : {}),
  }

  return Object.keys(exif).length ? exif : null
}
