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

export function byNewest(
  a: { id: string; year: string; date: string },
  b: { id: string; year: string; date: string },
): number
