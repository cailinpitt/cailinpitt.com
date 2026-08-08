// The average color of a photograph, recorded in the manifest so a tile has
// something to be before its image arrives.
//
// The feed is ~500 lazy <img> tags in a grid of squares. Until one loads its
// tile paints the surface color, so scrolling the feed is a wave of identical
// gray rectangles resolving into photographs. A single averaged color per photo
// costs 7 bytes in photos.json and turns that into a wave of roughly the right
// color — the same trick as a blurhash, minus the decoder.
//
// It's read from the *rendition* in images, not the original: renditions
// are what the browser actually displays (EXIF orientation already baked in),
// and they exist even in a checkout where originals/ was never pulled down.

/**
 * Average color as `#rrggbb`, or undefined if the image can't be read.
 *
 * Averaging happens in sRGB rather than linear light, which biases the result
 * darker and less saturated than the "true" mean. That's the right bias here:
 * this color sits under a photograph for a fraction of a second, and a muted
 * one reads as a placeholder while a vivid one reads as a mistake.
 */
export async function readTint(sharp, file) {
  try {
    // fit:'fill' so the whole frame is averaged; the default would crop first.
    // resolveWithObject, because the bare toBuffer() resolves to the Buffer and
    // destructuring `data` off that silently yields undefined.
    const { data } = await sharp(file)
      .resize(1, 1, { fit: 'fill' })
      // Flattened onto mid-gray so a transparent PNG averages to something
      // neutral rather than to whatever the fully-transparent pixels claim.
      .flatten({ background: '#808080' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    if (!data || data.length < 3) return undefined
    const hex = (n) => n.toString(16).padStart(2, '0')
    return `#${hex(data[0])}${hex(data[1])}${hex(data[2])}`
  } catch {
    // A file sharp won't decode costs its tile a placeholder, not the sync.
    return undefined
  }
}
