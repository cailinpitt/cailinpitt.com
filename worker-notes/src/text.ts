// Terminal rendering of the notes feed, for `curl notes.cailinpitt.com`.
//
// Same conventions as the listening, reading, watching, moving, and guestbook
// workers' text views (72 columns, ANSI on by default, `?T` to turn it off), and
// deliberately a separate copy — the workers are separate packages with no
// shared module.

import type { Note, NotePage } from './store'

const WIDTH = 72

/** How many notes the terminal view shows. A glance, not the archive. */
export const TEXT_ROWS = 20

// 256-color approximations of the site's palette: --accent #e3925b, plus grays.
const CODES = {
  accent: '\x1b[38;5;173m',
  bold: '\x1b[1m',
  dim: '\x1b[38;5;244m',
  faint: '\x1b[38;5;240m',
  reset: '\x1b[0m',
}

type Paint = (s: string) => string

function ink(color: boolean) {
  const wrap = (code: string): Paint => (s) => (color ? `${code}${s}${CODES.reset}` : s)
  return {
    accent: wrap(CODES.accent),
    bold: wrap(CODES.bold),
    dim: wrap(CODES.dim),
    faint: wrap(CODES.faint),
  }
}

/**
 * Text safe to print into someone's terminal.
 *
 * Notes are written by one authenticated person rather than by strangers, so
 * this is far less load-bearing than the guestbook's equivalent — but a note
 * pasted from somewhere else can still carry an escape sequence by accident, and
 * a raw byte stream is how that would end up repainting a reader's scrollback.
 */
const safe = (s: string): string => s.replace(/\p{Cc}|\p{Cf}/gu, (c) => (c === '\n' ? c : ' '))

const num = (n: number) => n.toLocaleString('en-US')

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "Jun 9, 2026 · 4:12pm" in the site's fixed local offset. */
function stamp(uts: number, offset: number): string {
  const d = new Date((uts + offset) * 1000)
  const hours = d.getUTCHours()
  const suffix = hours < 12 ? 'am' : 'pm'
  const hour12 = hours % 12 === 0 ? 12 : hours % 12
  const minutes = String(d.getUTCMinutes()).padStart(2, '0')
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()} · ${hour12}:${minutes}${suffix}`
}

/**
 * Wrap to the column width at word boundaries, with a hard split for any single
 * "word" longer than the line — a long URL would otherwise blow out the layout.
 */
function wrap(text: string, width: number): string[] {
  const out: string[] = []
  for (const paragraph of safe(text).split('\n')) {
    if (!paragraph.trim()) {
      out.push('')
      continue
    }
    let line = ''
    for (const word of paragraph.trim().split(/\s+/)) {
      let w = word
      while (w.length > width) {
        if (line) {
          out.push(line)
          line = ''
        }
        out.push(w.slice(0, width))
        w = w.slice(width)
      }
      if (!line) line = w
      else if (line.length + 1 + w.length <= width) line += ` ${w}`
      else {
        out.push(line)
        line = w
      }
    }
    if (line) out.push(line)
  }
  return out
}

export function renderText(
  page: NotePage,
  opts: { color: boolean; offset: number; site: string },
): string {
  const c = ink(opts.color)
  const lines: string[] = []

  lines.push(c.bold('  cailinpitt.com notes'))
  lines.push(c.faint('  ' + '─'.repeat(WIDTH - 4)))
  lines.push('')

  if (!page.notes.length) {
    lines.push(c.dim('  Nothing here yet.'))
    lines.push('')
    return lines.join('\n') + '\n'
  }

  for (const note of page.notes.slice(0, TEXT_ROWS)) {
    const edited = note.editedAt ? c.faint('  (edited)') : ''
    lines.push(`  ${c.dim(stamp(note.createdAt, opts.offset))}${edited}`)
    for (const line of wrap(note.text, WIDTH - 6)) lines.push(line ? `    ${line}` : '')
    lines.push('')
  }

  const shown = Math.min(TEXT_ROWS, page.notes.length)
  if (page.total > shown) {
    lines.push(c.dim(`  ${num(shown)} of ${num(page.total)} notes.`))
  } else {
    lines.push(c.dim(`  ${num(page.total)} ${page.total === 1 ? 'note' : 'notes'}.`))
  }
  lines.push(c.dim('  Read them at ') + c.accent(`${opts.site}/notes`))
  lines.push('')

  return lines.join('\n') + '\n'
}

/** One note as a line of text, for `notes` in the site's /terminal. */
export const oneLine = (note: Note, width = WIDTH): string =>
  wrap(note.text, width).join(' ').trim()
