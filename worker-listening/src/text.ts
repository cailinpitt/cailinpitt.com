// Terminal rendering of the listening bundle, for `curl`-style clients. 
// Same data the page shows, laid out for an 80-column terminal.
//
// ANSI color is on by default (curl has no way to tell us it is a TTY, and the
// convention these sites follow is to send color and let `?T` turn it off).

import type { Bundle, StatWindow } from './stats'
import type { Scrobble } from './lastfm'
import type { PeriodStats } from './aggregate'

const WIDTH = 72
const BAR_WIDTH = 26
const LABEL_WIDTH = 22

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

// Eighth-width blocks let a bar end mid-cell, so short bars stay distinguishable
// instead of all collapsing to one full block.
const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']

function bar(value: number, max: number, width: number): string {
  if (max <= 0 || value <= 0) return ''
  const units = Math.max(1, Math.round((value / max) * width * 8))
  return '█'.repeat(Math.floor(units / 8)) + EIGHTHS[units % 8]
}

const SPARKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']

function sparkline(values: number[]): string {
  const max = values.reduce((m, v) => (v > m ? v : m), 0)
  if (max <= 0) return SPARKS[0].repeat(values.length)
  // A blank for a zero day reads as a rendering hole; a dot reads as "nothing here".
  return values
    .map((v) => (v <= 0 ? '·' : SPARKS[Math.min(7, Math.floor((v / max) * 7.999))]))
    .join('')
}

/** Local wall-clock parts for a scrobble, using the same fixed offset as the site. */
function localParts(uts: number, offset: number) {
  const d = new Date((uts + offset) * 1000)
  return {
    date: d.toISOString().slice(0, 10),
    hh: d.getUTCHours(),
    mm: d.getUTCMinutes(),
  }
}

function clockTime(uts: number, offset: number): string {
  const { hh, mm } = localParts(uts, offset)
  const period = hh >= 12 ? 'pm' : 'am'
  const h12 = hh % 12 === 0 ? 12 : hh % 12
  return `${String(h12).padStart(2, ' ')}:${String(mm).padStart(2, '0')}${period}`
}

function relative(uts: number, now: number): string {
  const secs = Math.max(0, now - uts)
  if (secs < 60) return 'just now'
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return days < 30 ? `${days}d ago` : `${Math.floor(days / 30)}mo ago`
}

// ---- sections ------------------------------------------------------------

function header(c: Ink): string[] {
  const title = 'cailinpitt.com/listening'
  const inner = WIDTH - 4 // columns between the two box verticals
  return [
    '',
    `  ${c.accent('┌' + '─'.repeat(inner) + '┐')}`,
    `  ${c.accent('│')}${c.bold(' ' + fit(title, inner - 1))}${c.accent('│')}`,
    `  ${c.accent('└' + '─'.repeat(inner) + '┘')}`,
  ]
}

function nowSection(b: Bundle, c: Ink, now: number): string[] {
  const live = Boolean(b.nowPlaying)
  const track = b.nowPlaying ?? b.lastPlayed
  if (!track) return []

  const heading = live ? c.accent('♫ now playing') : c.dim('■ last played')
  const when = !live && b.lastPlayed ? c.faint(`  (${relative(b.lastPlayed.uts, now)})`) : ''
  const sub = [track.artist, track.album].filter(Boolean).join(' · ')

  return [
    '',
    `  ${heading}${when}`,
    `     ${c.bold(clip(track.track, WIDTH - 7))}`,
    `     ${c.dim(clip(sub, WIDTH - 7))}`,
  ]
}

function topArtists(w: StatWindow, c: Ink): string[] {
  if (!w.topArtists.length) return []
  const max = w.topArtists[0].count
  const lines = w.topArtists.map((a) => {
    const label = c.dim(fit(a.name, LABEL_WIDTH))
    const fill = c.accent(bar(a.count, max, BAR_WIDTH).padEnd(BAR_WIDTH))
    return `    ${label} ${fill} ${c.bold(String(a.count))}`
  })
  return ['', `  ${c.accentDim('top artists')}`, ...lines]
}

function topList(
  title: string,
  rows: { primary: string; secondary: string; count: number }[],
  c: Ink,
): string[] {
  if (!rows.length) return []
  const lines = rows.map((r, i) => {
    const rank = c.faint(String(i + 1).padStart(2) + '.')
    const primary = fit(r.primary, 30)
    const secondary = c.dim(fit(r.secondary, 24))
    return `   ${rank} ${primary} ${secondary} ${c.bold(String(r.count).padStart(3))}`
  })
  return ['', `  ${c.accentDim(title)}`, ...lines]
}

function statsLine(w: StatWindow, label: string, c: Ink): string[] {
  const parts = [
    `${num(w.scrobbles)} scrobbles`,
    `${num(w.artists)} artists`,
    `${num(w.albums)} albums`,
    `${w.perDay}/day`,
  ]
  return ['', `  ${c.bold(label)}  ${c.dim(parts.join(' · '))}`]
}

/**
 * Last 30 local days as a sparkline.
 *
 * The heatmap only recomputes every 6 h, so its entry for today is usually stale
 * or missing — which would draw the most-looked-at cell as an empty day.
 * recentDays covers the last ~10 days on the 15-minute cadence, so take whichever
 * source reports more for a given day.
 */
function recentSpark(b: Bundle, c: Ink, offset: number, now: number): string[] {
  const fresh = new Map(b.recentDays.map((d) => [d.date, d.count]))
  const days: number[] = []
  const labels: string[] = []
  for (let i = 29; i >= 0; i--) {
    const key = new Date((now + offset - i * 86400) * 1000).toISOString().slice(0, 10)
    days.push(Math.max(b.heatmap.days[key] ?? 0, fresh.get(key) ?? 0))
    labels.push(key)
  }
  const total = days.reduce((s, v) => s + v, 0)
  return [
    '',
    `  ${c.accentDim('last 30 days')}  ${c.dim(`${num(total)} scrobbles`)}`,
    `    ${c.accent(sparkline(days))}`,
    `    ${c.faint(labels[0])}${' '.repeat(Math.max(1, 30 - 20))}${c.faint(labels[29])}`,
  ]
}

function recentTracks(b: Bundle, c: Ink, offset: number): string[] {
  const flat: Scrobble[] = []
  for (const day of b.recentDays) {
    for (const t of day.tracks) {
      if (flat.length < 8) flat.push(t)
    }
  }
  if (!flat.length) return []

  let lastDate = ''
  const lines: string[] = []
  for (const t of flat) {
    const { date } = localParts(t.uts, offset)
    if (date !== lastDate) {
      lines.push(`    ${c.faint(date)}`)
      lastDate = date
    }
    const time = c.dim(clockTime(t.uts, offset))
    lines.push(`      ${time}  ${fit(t.track, 28)} ${c.dim(clip(t.artist, 24))}`)
  }
  return ['', `  ${c.accentDim('recently played')}`, ...lines]
}

function footer(b: Bundle, c: Ink): string[] {
  return [
    '',
    `  ${c.dim('─'.repeat(WIDTH - 4))}`,
    `  ${c.dim(`${num(b.totalScrobbles)} scrobbles all-time · via Last.fm (${b.user})`)}`,
    `  ${c.faint('?T for no color · ?w=30d for the 30-day window · /listening.json for JSON')}`,
    '',
  ]
}

// ---- year in review ------------------------------------------------------

const MONTH_INITIALS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D']

/** Twelve months as a labelled bar row — the shape of the year at a glance. */
function monthBars(months: number[], c: Ink): string[] {
  const max = months.reduce((m, v) => (v > m ? v : m), 0)
  const rows = months.map((n, i) => {
    const label = c.dim(MONTH_INITIALS[i])
    const fill = c.accent(bar(n, max, 30).padEnd(30))
    return `    ${label} ${fill} ${c.bold(String(n).padStart(5))}`
  })
  return ['', `  ${c.accentDim('by month')}`, ...rows]
}

/**
 * A year for the terminal, rendered from the same period blob the web page uses.
 *
 * Previously this took a `YearReview` computed from D1 on request. That was a
 * ~18,700-row aggregation on the read path — the one thing the period
 * architecture exists to prevent — and it meant `curl` saw a different, poorer
 * year than the site. One shape now feeds both, so genres and listening time
 * come along for free and the two can't drift.
 */
export function renderYear(y: PeriodStats, color: boolean): string {
  const c = ink(color)
  const title = `cailinpitt.com/listening · ${y.key}${y.complete ? '' : ' (in progress)'}`
  const inner = WIDTH - 4

  const headline = [
    `${num(y.scrobbles)} scrobbles`,
    `${num(y.artists)} artists`,
    `${num(y.albums)} albums`,
    `${y.perDay}/day`,
  ]
  const second = [
    `${num(y.activeDays)} days with music`,
    `${num(y.discovery?.artists ?? 0)} new artists`,
  ]
  if (y.listening?.seconds) second.push(`${num(Math.round(y.listening.seconds / 3600))}h listened`)

  const lines = [
    '',
    `  ${c.accent('┌' + '─'.repeat(inner) + '┐')}`,
    `  ${c.accent('│')}${c.bold(' ' + fit(title, inner - 1))}${c.accent('│')}`,
    `  ${c.accent('└' + '─'.repeat(inner) + '┘')}`,
    '',
    `  ${c.dim(headline.join(' · '))}`,
    `  ${c.dim(second.join(' · '))}`,
  ]

  if (y.busiestDay) {
    lines.push(
      `  ${c.dim(`busiest day ${y.busiestDay.date} — ${num(y.busiestDay.count)} scrobbles`)}`,
    )
  }
  if (y.peakHour !== null && y.peakHour !== undefined) {
    lines.push(`  ${c.dim(`peak hour ${hourLabel(y.peakHour)} · ${y.lateNightShare}% after midnight`)}`)
  }
  if (y.first) {
    lines.push('', `  ${c.accentDim('first play of the year')}`)
    lines.push(`    ${c.bold(clip(y.first.track, WIDTH - 6))}`)
    lines.push(`    ${c.dim(clip(y.first.artist, WIDTH - 6))}`)
  }

  lines.push(
    ...topList(
      'top artists',
      y.top.artists.map((a) => ({ primary: a.name, secondary: '', count: a.count })),
      c,
    ),
  )
  lines.push(
    ...topList(
      'top albums',
      y.top.albums.map((a) => ({ primary: a.album, secondary: a.artist, count: a.count })),
      c,
    ),
  )
  lines.push(
    ...topList(
      'top tracks',
      y.top.tracks.map((t) => ({ primary: t.track, secondary: t.artist, count: t.count })),
      c,
    ),
  )

  // Only worth printing when enough of the year is actually classified — the
  // same threshold the web page uses.
  if (y.genreCoverage >= 50 && y.genres?.length) {
    lines.push(
      ...topList(
        'top genres',
        y.genres.slice(0, 5).map((g) => ({ primary: g.name, secondary: '', count: g.count })),
        c,
      ),
    )
  }

  lines.push(...monthBars(y.series.map((p) => p.count), c))
  lines.push(
    '',
    `  ${c.dim('─'.repeat(WIDTH - 4))}`,
    `  ${c.faint('?T for no color · /' + y.key + '.json for JSON · / for the current view')}`,
    '',
  )
  return lines.join('\n')
}

/** 17 → "5pm". Matches the web page's phrasing. */
function hourLabel(hour: number): string {
  if (hour === 0) return 'midnight'
  if (hour === 12) return 'noon'
  return hour < 12 ? `${hour}am` : `${hour - 12}pm`
}

// ---- entry point ---------------------------------------------------------

export interface TextOptions {
  color: boolean
  window: '7d' | '30d'
  offset: number
}

export function renderText(b: Bundle, opts: TextOptions): string {
  const c = ink(opts.color)
  const now = Math.floor(Date.now() / 1000)
  const w = b.windows[opts.window]
  const label = opts.window === '7d' ? 'past 7 days' : 'past 30 days'

  return [
    ...header(c),
    ...nowSection(b, c, now),
    ...statsLine(w, label, c),
    ...topArtists(w, c),
    ...topList(
      'top albums',
      w.topAlbums.map((a) => ({ primary: a.album, secondary: a.artist, count: a.count })),
      c,
    ),
    ...topList(
      'top tracks',
      w.topTracks.map((t) => ({ primary: t.track, secondary: t.artist, count: t.count })),
      c,
    ),
    ...recentSpark(b, c, opts.offset, now),
    ...recentTracks(b, c, opts.offset),
    ...footer(b, c),
  ].join('\n')
}
