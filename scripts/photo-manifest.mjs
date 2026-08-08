// The rules that decide a photo's permalink and its place in the feed.
//
// Split out of sync-images.mjs because these two are the parts worth testing on
// their own (tests/photos.test.ts) — everything else in that script is disk I/O.

/** `IMG_0116` → `img-0116`. Lowercase, and nothing but letters, digits, dashes. */
export function slugify(stem) {
  return stem
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
}

/**
 * The permalink for a photo: `<year>-<slug>`, e.g. `2019-img-0116`. Filenames
 * repeat across years (every phone eventually produces a second IMG_0116), so
 * the year is part of the id rather than decoration; a collision *within* a year
 * takes a `-2`, `-3` suffix.
 *
 * Assigned once, when sync first sees the file, and stored in the manifest. It
 * is a public URL from that moment on — renaming the file on disk later must not
 * change it, which is why nothing recomputes this for an entry that has one.
 */
export function assignPhotoId(year, stem, used) {
  const base = `${year}-${slugify(stem)}`
  let id = base
  for (let n = 2; used.has(id); n++) id = `${base}-${n}`
  used.add(id)
  return id
}

/**
 * Stand-in date for a photo whose original carries no capture time: the first of
 * its year, flagged approximate. Real enough to sort the feed by year, and the
 * flag is what stops the UI printing "January 1, 2019" as though it meant it.
 */
export const approxDateForYear = (year) => `${year}-01-01T00:00:00`

/**
 * When a photo was taken, and which year it belongs to. Those are two answers
 * because for most of the archive they come from different places.
 *
 * `date`, best source first:
 *
 *   1. the capture time in the original's EXIF — the only exact one;
 *   2. whatever the manifest already says, which is either an earlier run's
 *      answer, the Squarespace upload date recovered by
 *      scripts/backfill-photo-dates.mjs, or a hand correction;
 *   3. the first of the folder's year.
 *
 * `year` is the folder the photo is filed under, except when there's a real
 * capture time, which outranks it. The folder is a decade of curation and the
 * label the site has always shown; a recovered *upload* date can easily land in
 * the following year (a 2014 photo posted in 2016) and must not relabel the
 * photo — it orders the year's photos among themselves and nothing more.
 *
 * A photo that gains EXIF later (a re-read with --reexif, say) is upgraded to
 * the capture time and loses the approximate flag.
 */
export function resolveDate({ exif, existing, year }) {
  if (exif?.shot) return { date: exif.shot, year: exif.shot.slice(0, 4) }
  if (existing?.date) return { date: existing.date, year, approx: true }
  return { date: approxDateForYear(year), year, approx: true }
}

/**
 * Widths the grid renditions are encoded at, narrowest first.
 *
 * A feed tile is three-across at every viewport: ~117px on a phone, ~306px at
 * the feed's 58rem cap. Times a 2–3x display that spans ~234–918 real pixels,
 * which one 1000px file served badly at both ends — a phone was downloading
 * about eight times the pixels it could show.
 *
 * 1000 stays because it is what `thumb` has always pointed at, and the photo's
 * own page and older manifest entries both still expect it.
 *
 * Mirrored by GRID_WIDTHS in src/lib/photos.ts, which builds the srcset the
 * browser actually reads; tests/photos.test.ts pins the two together.
 */
export const GRID_WIDTHS = [400, 800, 1000]

/** The grid rendition of `src` at `width`: /images/2026/x.webp -> …/x-400.webp */
export function renditionPath(src, width) {
  return src.replace(/\.[^.]+$/, `-${width}.webp`)
}

/**
 * Everything on disk and in R2 that belongs to one photo, derived from its
 * manifest entry.
 *
 * Note the folder comes from the `src` path, not from `photo.year`: those
 * disagree whenever a capture date puts a photo in a different year than the
 * folder it's filed under (see resolveDate), and it's the path that says where
 * the bytes actually are.
 *
 * `originalStem` is a stem, not a filename — an original may be `.jpg`, `.jpeg`,
 * `.png`, whatever came off the camera, while the renditions are always `.webp`.
 * The caller matches it against what it finds.
 */
export function photoFiles(photo) {
  const [, , folder, file] = photo.src.split('/')
  const stem = file.replace(/\.[^.]+$/, '')
  /**
   * Root-relative paths, which are also the R2 keys minus the leading slash.
   *
   * Driven by the entry's own `widths` rather than GRID_WIDTHS, so removing a
   * photo deletes the renditions it actually has: an entry written before a
   * width was added never had that file, and a stale constant must not make
   * `photos:rm` report a phantom as missing. `thumb` is folded in for entries
   * predating `widths` entirely.
   */
  const grid = (photo.widths ?? []).map((width) => renditionPath(photo.src, width))
  const renditions = [...new Set([photo.src, photo.thumb, ...grid].filter(Boolean))]
  return { folder, stem, renditions, originalStem: stem }
}

/**
 * Newest first: by year, then by date within it, with the id as a stable
 * tiebreak. Year leads because an approximate date can sit outside the year the
 * photo is filed under — see resolveDate. Mirrors byNewest in src/lib/photos.ts.
 */
export function byNewest(a, b) {
  if (a.year !== b.year) return a.year < b.year ? 1 : -1
  if (a.date !== b.date) return a.date < b.date ? 1 : -1
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
}
