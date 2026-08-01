// Terminal rendering of the reading bundle, for `curl`-style clients.
// The counterpart to the listening worker's src/text.ts — same conventions
// (72 columns, ANSI on by default, `?T` to turn it off), and deliberately a
// separate copy: the two workers are separate packages with no shared module,
// and this one renders different rows.

import type { Article, Book, ReadingBundle } from './store'

const WIDTH = 72

/** How many rows each list gets. A terminal view is a glance, not the archive. */
const FINISHED_ROWS = 8
const ARTICLE_ROWS = 8

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

// ---- text helpers --------------------------------------------------------

/** Truncate to n columns with an ellipsis. */
function clip(s: string, n: number): string {
  const clean = s.replace(/\s+/g, ' ').trim()
  return clean.length <= n ? clean : clean.slice(0, Math.max(0, n - 1)) + '…'
}

/**
 * clip() padded to exactly n, for columns that have something to their right.
 * Never use this on the last field of a line: the padding sits inside the color
 * wrap, so it survives any later trimEnd() as invisible trailing whitespace.
 */
const fit = (s: string, n: number): string => clip(s, n).padEnd(n)

const num = (n: number) => n.toLocaleString('en-US')

/** Where a Hardcover slug points. Books without one simply render unlinked. */
const bookUrl = (slug: string | null) => (slug ? `https://hardcover.app/books/${slug}` : null)

/**
 * OSC 8 hyperlink: makes the label clickable in iTerm2, WezTerm, kitty, GNOME
 * Terminal and Windows Terminal. Terminals without support ignore the sequence
 * and print the label unchanged, and it occupies zero columns — so wrap text
 * that has *already* been clip()/fit()ed, exactly like the color codes.
 *
 * Article URLs arrive from /ingest, so strip C0/C1 control characters before
 * embedding: an ESC or BEL inside the URL would terminate the sequence early and
 * let saved data write arbitrary escapes to the reader's terminal.
 */
function link(url: string | null | undefined, label: string, enabled: boolean): string {
  if (!enabled || !url) return label
  // Only http(s): a saved javascript:/file: URL must never become clickable.
  const safe = url.replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
  if (!/^https?:\/\//i.test(safe)) return label
  return `\x1b]8;;${safe}\x1b\\${label}\x1b]8;;\x1b\\`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * "Jun 9" from a YYYY-MM-DD string, read as written.
 *
 * Hardcover stores dates, not timestamps, so there is no zone to convert and
 * nothing to be gained by routing this through Date — parsing the digits can't
 * slide a finish date onto the day before.
 */
function shortDate(date: string | null): string {
  if (!date) return ''
  const [y, m, d] = date.slice(0, 10).split('-').map(Number)
  if (!y || !m || !d) return ''
  return `${MONTHS[m - 1]} ${d}`
}

/** Whole days between a YYYY-MM-DD date and now, or null if it doesn't parse. */
function daysSince(date: string | null, now: number): number | null {
  if (!date) return null
  // Noon UTC, so a day boundary can't be crossed by the reader's offset.
  const then = Date.parse(`${date.slice(0, 10)}T12:00:00Z`) / 1000
  if (Number.isNaN(then)) return null
  return Math.max(0, Math.floor((now - then) / 86400))
}

/** "today" / "3d ago" / "2mo ago" — the phrasing the listening view uses. */
function agoLabel(days: number): string {
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days}d ago`
  if (days < 365) return `${Math.floor(days / 30)}mo ago`
  return `${Math.floor(days / 365)}y ago`
}

/** Local wall clock for an article's readAt, using the same fixed offset as the site. */
function localParts(uts: number, offset: number) {
  const d = new Date((uts + offset) * 1000)
  return { date: d.toISOString().slice(0, 10), hh: d.getUTCHours(), mm: d.getUTCMinutes() }
}

function clockTime(uts: number, offset: number): string {
  const { hh, mm } = localParts(uts, offset)
  const period = hh >= 12 ? 'pm' : 'am'
  const h12 = hh % 12 === 0 ? 12 : hh % 12
  return `${String(h12).padStart(2, ' ')}:${String(mm).padStart(2, '0')}${period}`
}

/**
 * "★★★★☆" from a 0–5 rating, matching the site's rounding (half stars round up
 * rather than introducing a third glyph). Unrated books get blanks, so the
 * column still lines up.
 */
function stars(rating: number | null): string {
  if (rating == null || rating <= 0) return '     '
  const filled = Math.min(5, Math.round(rating))
  return '★'.repeat(filled) + '☆'.repeat(5 - filled)
}

// ---- sections ------------------------------------------------------------

function header(c: Ink): string[] {
  const title = 'cailinpitt.com/reading'
  const inner = WIDTH - 4 // columns between the two box verticals
  return [
    '',
    `  ${c.accent('┌' + '─'.repeat(inner) + '┐')}`,
    `  ${c.accent('│')}${c.bold(' ' + fit(title, inner - 1))}${c.accent('│')}`,
    `  ${c.accent('└' + '─'.repeat(inner) + '┘')}`,
  ]
}

/**
 * What's open right now. Falls back to the most recent finish, so the top of
 * the view is never blank between books — the same choice the homepage strip
 * makes.
 */
function currentSection(b: ReadingBundle, c: Ink, now: number, links: boolean): string[] {
  const reading = b.currentlyReading.length > 0
  const books = reading ? b.currentlyReading.slice(0, 3) : b.finishedBooks.slice(0, 1)
  if (!books.length) return []

  const lines = [
    '',
    `  ${reading ? c.accent('▸ currently reading') : c.dim('■ last finished')}`,
  ]
  for (const book of books) {
    const started = daysSince(book.startedAt, now)
    const finished = daysSince(book.finishedAt, now)
    const detail = [
      book.authors,
      book.pages ? `${num(book.pages)} pages` : null,
      reading
        ? started != null
          ? `started ${agoLabel(started)}`
          : null
        : finished != null
          ? `finished ${agoLabel(finished)}`
          : null,
      reading ? null : stars(book.rating).trim() || null,
    ]
      .filter(Boolean)
      .join(' · ')

    lines.push(`     ${link(bookUrl(book.slug), c.bold(clip(book.title, WIDTH - 7)), links)}`)
    if (detail) lines.push(`     ${c.dim(clip(detail, WIDTH - 7))}`)
  }
  return lines
}

function statsSection(b: ReadingBundle, c: Ink, year: number): string[] {
  const thisYear = [
    `${num(b.counts.booksThisYear)} books`,
    `${num(b.counts.pagesThisYear)} pages`,
  ].join(' · ')
  const allTime = [
    `${num(b.counts.booksRead)} books`,
    `${num(b.counts.articles)} articles`,
  ].join(' · ')

  return [
    '',
    `  ${c.bold(String(year).padEnd(9))}${c.dim(thisYear)}`,
    `  ${c.bold('all time'.padEnd(9))}${c.dim(allTime)}`,
  ]
}

function finishedSection(books: Book[], c: Ink, links: boolean): string[] {
  const rows = books.filter((book) => book.finishedAt).slice(0, FINISHED_ROWS)
  if (!rows.length) return []

  const lines = rows.map((book, i) => {
    const rank = c.faint(String(i + 1).padStart(2) + '.')
    // Wrap *after* fit(): the escape is zero-width, so padding must be computed
    // on the bare text or every column after it shifts.
    const title = link(bookUrl(book.slug), fit(book.title, 30), links)
    const authors = c.dim(fit(book.authors ?? '', 20))
    const rating = c.accent(stars(book.rating))
    return `   ${rank} ${title} ${authors} ${rating} ${c.faint(shortDate(book.finishedAt))}`
  })
  return ['', `  ${c.accentDim('recently finished')}`, ...lines]
}

/** Saved articles, grouped under their local date like the listening log's days. */
function articlesSection(articles: Article[], c: Ink, offset: number, links: boolean): string[] {
  const rows = articles.slice(0, ARTICLE_ROWS)
  if (!rows.length) return []

  let lastDate = ''
  const lines: string[] = []
  for (const article of rows) {
    const { date } = localParts(article.readAt, offset)
    if (date !== lastDate) {
      lines.push(`    ${c.faint(date)}`)
      lastDate = date
    }
    const time = c.dim(clockTime(article.readAt, offset))
    const site = clip(article.site ?? '', 18)
    // Only pad the title when the site column is actually there to its right —
    // fit() on a last field leaves trailing spaces inside the color wrap, which
    // no later trim can reach. Plenty of saved links have no og:site_name.
    const label = site ? fit(article.title ?? article.url, 34) : clip(article.title ?? article.url, 34)
    const title = link(article.url, label, links)
    lines.push(`      ${time}  ${title}${site ? ` ${c.dim(site)}` : ''}`)
  }
  return ['', `  ${c.accentDim('recently saved')}`, ...lines]
}

function footer(c: Ink): string[] {
  return [
    '',
    `  ${c.dim('─'.repeat(WIDTH - 4))}`,
    `  ${c.dim('books via hardcover.app · articles saved as I read them')}`,
    `  ${c.faint('?T for no color · /reading.json for JSON · /listening for music')}`,
    '',
  ]
}

// ---- entry point ---------------------------------------------------------

export interface TextOptions {
  color: boolean
  /** Seconds east of UTC, the same fixed offset the rest of the site buckets by. */
  offset: number
  /** Local calendar year, for the "this year" row. */
  year: number
  /**
   * Emit OSC 8 hyperlinks. Tied to `color`: ?T means "plain text please", and
   * someone piping this to a file wants neither escape.
   */
  links: boolean
}

export function renderText(b: ReadingBundle, opts: TextOptions): string {
  const c = ink(opts.color)
  const now = Math.floor(Date.now() / 1000)

  return [
    ...header(c),
    ...currentSection(b, c, now, opts.links),
    ...statsSection(b, c, opts.year),
    ...finishedSection(b.finishedBooks, c, opts.links),
    ...articlesSection(b.articles, c, opts.offset, opts.links),
    ...footer(c),
  ].join('\n')
}
