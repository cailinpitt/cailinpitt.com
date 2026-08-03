// Types for photo-manifest.mjs, so tests/photos.test.ts can hold the sync
// script's rules to the same standard as the site's own code. The script itself
// stays plain JavaScript — it runs under bare `node`, with no build step.

export function slugify(stem: string): string

export function assignPhotoId(year: string, stem: string, used: Set<string>): string

export function approxDateForYear(year: string): string

export function resolveDate(input: {
  exif?: { shot?: string }
  existing?: { date?: string; approx?: boolean }
  year: string
}): { date: string; year: string; approx?: boolean }

// Takes a whole manifest entry; only `src` and `thumb` are read, and the index
// signature is what lets a caller pass the rest of the entry along with them.
export function photoFiles(photo: {
  src: string
  thumb?: string
  [key: string]: unknown
}): { folder: string; stem: string; renditions: string[]; originalStem: string }

export function byNewest(
  a: { id: string; year: string; date: string },
  b: { id: string; year: string; date: string },
): number
