// Terminal rendering of the watching bundle, for `curl`-style clients.
// The counterpart to worker/src/text.ts and worker-reading/src/text.ts — same
// conventions (72 columns, ANSI on by default, `?T` to turn it off), and
// deliberately a separate copy: the workers are separate packages with no
// shared module, and this one renders different rows.

import type { Film, WatchingBundle } from './store'

const WIDTH = 72

/** How many rows the list gets. A terminal view is a glance, not the archive. */
const FILM_ROWS = 12

// 256-color approximations of the site's palette: --accent #e3925b, plus grays.
const CODES = {
  accent: '\x1b[38;5;173m',
  accentDim: '\x1b[38;5;137m',
  bold: '\x1b[1m',
  dim: '\x1b[38;5;244m',
  faint: '\x1b[38;5;240m',
  reset: '\x1b[0m',
}

type Paint = (s: string) => string

interface Ink {
  accent: Paint
  accentDim: Paint
  bold: Paint
  dim: Paint
  faint: Paint
}

function ink(color: boolean): Ink {
  const wrap = (code: string): Paint => (s) => (color ? `${code}${s}${CODES.reset}` : s)
  return {
    accent: wrap(CODES.accent),
    accentDim: wrap(CODES.accentDim),
    bold: wrap(CODES.bold),
    dim: wrap(CODES.dim),
    faint: wrap(CODES.faint),
  }
}

/** Truncate to n columns with an ellipsis. */
function clip(s: string, n: number): string {
  const clean = s.replace(/\s+/g, ' ').trim()
  return clean.length <= n ? clean : clean.slice(0, Math.max(0, n - 1)) + '…'
}

/**
 * clip() padded to exactly n, for columns with something to their right.
 * Never use this on the last field of a line: the padding sits inside the color
 * wrap, so it survives any later trimEnd() as invisible trailing whitespace.
 */
const fit = (s: string, n: number): string => clip(s, n).padEnd(n)

const num = (n: number) => n.toLocaleString('en-US')

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * "Jul 9" from a YYYY-MM-DD string, read as written.
 *
 * Letterboxd logs a date, not a timestamp, so there is no zone to convert and
 * nothing to gain from routing it through Date — parsing the digits cannot slip
 * a day the way a UTC round-trip can.
 */
function shortDate(date: string): string {
  const [, month, day] = date.split('-')
  const index = Number(month) - 1
  return MONTHS[index] ? `${MONTHS[index]} ${Number(day)}` : date
}

/**
 * "★★★½" from a 0–5 rating.
 *
 * Half stars are rendered rather than rounded, unlike the book shelf: on
 * Letterboxd the half is the whole point of the scale, and a terminal can spell
 * it without needing a second glyph set.
 */
function stars(rating: number | null): string {
  if (rating == null || rating <= 0) return ''
  const full = Math.floor(rating)
  return '★'.repeat(full) + (rating - full >= 0.5 ? '½' : '')
}

function filmLine(film: Film, c: Ink): string {
  const title = `${film.title}${film.year ? ` (${film.year})` : ''}`
  const marks = `${film.rewatch ? '↻ ' : ''}${film.liked ? '♥ ' : ''}`
  return (
    c.dim(fit(shortDate(film.watchedDate), 7)) +
    c.accentDim(fit(stars(film.rating) || '—', 6)) +
    clip(`${marks}${title}`, WIDTH - 13)
  ).trimEnd()
}

export function renderText(
  bundle: WatchingBundle,
  options: { color: boolean; year: number },
): string {
  const c = ink(options.color)
  const { counts } = bundle
  const lines: string[] = []

  lines.push(c.bold(c.accent('cailinpitt.com/watching')), c.faint('─'.repeat(WIDTH)), '')

  const mean = counts.meanRating != null ? `${counts.meanRating.toFixed(2)} avg` : 'unrated'
  lines.push(
    c.dim(
      `${num(counts.films)} films · ${num(counts.filmsThisYear)} in ${options.year} · ` +
        `${num(counts.rewatches)} rewatches · ${mean}`,
    ),
    '',
  )

  if (bundle.films.length) {
    for (const film of bundle.films.slice(0, FILM_ROWS)) lines.push(filmLine(film, c))
  } else {
    lines.push(c.dim('Nothing logged yet.'))
  }

  lines.push(
    '',
    c.faint('Films logged on Letterboxd'),
    c.faint('The whole log → https://cailinpitt.com/watching'),
    '',
  )

  return lines.join('\n')
}
