// Terminal rendering of the guestbook, for `curl guestbook.cailinpitt.com`.
// Same conventions as the listening and reading workers' text views (72
// columns, ANSI on by default, `?T` to turn it off), and deliberately a
// separate copy — the three workers are separate packages with no shared module.

import type { Entry } from './store'

const WIDTH = 72

/** How many entries the terminal view shows. A glance, not the archive. */
export const TEXT_ROWS = 15

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
 * This is the one place in the whole feature where escaping actually matters.
 * Entries are written by strangers, and a raw byte stream is exactly how a
 * message could carry ANSI escape sequences that retitle a reader's window,
 * repaint their scrollback, or hide the rest of the guestbook. The browser page
 * doesn't care — React renders text nodes — but a terminal does, so strip C0/C1
 * controls here rather than mangling the stored value on the way in.
 */
function safe(s: string): string {
  return s.replace(/\p{Cc}|\p{Cf}/gu, ' ')
}

/** Truncate to n columns with an ellipsis. */
function clip(s: string, n: number): string {
  const clean = safe(s).replace(/\s+/g, ' ').trim()
  return clean.length <= n ? clean : clean.slice(0, Math.max(0, n - 1)) + '…'
}

const num = (n: number) => n.toLocaleString('en-US')

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "Jun 9, 2026" in the site's fixed local offset. */
function shortDate(uts: number, offset: number): string {
  const d = new Date((uts + offset) * 1000)
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`
}

/**
 * Wrap a message to the column width at word boundaries, with a hard split for
 * any single "word" longer than the line — a 400-character URL or a keysmash
 * would otherwise blow out the layout.
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

/** A country code as its flag emoji, via regional indicator codepoints. */
function flag(code: string | null): string {
  if (!code || !/^[A-Za-z]{2}$/.test(code)) return ''
  return String.fromCodePoint(
    ...[...code.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65),
  )
}

export function renderText(
  page: { entries: Entry[]; total: number },
  opts: { color: boolean; offset: number },
): string {
  const c = ink(opts.color)
  const lines: string[] = []

  lines.push(c.bold('  cailinpitt.com guestbook'))
  lines.push(c.faint('  ' + '─'.repeat(WIDTH - 4)))
  lines.push('')

  if (!page.entries.length) {
    lines.push(c.dim('  Nobody has signed it yet. You could be first:'))
    lines.push(c.accent('  https://cailinpitt.com/guestbook'))
    lines.push('')
    return lines.join('\n') + '\n'
  }

  for (const entry of page.entries.slice(0, TEXT_ROWS)) {
    // The byline: name, then the optional where-from bits, then the date.
    const where = [entry.location && clip(entry.location, 28), flag(entry.country)]
      .filter(Boolean)
      .join(' ')
    lines.push(
      `  ${c.accent(clip(entry.name, 34))}${where ? c.dim(`  ${where}`) : ''}` +
        c.faint(`  ${shortDate(entry.createdAt, opts.offset)}`),
    )
    if (entry.website) lines.push(`  ${c.faint(clip(entry.website, WIDTH - 4))}`)
    for (const line of wrap(entry.message, WIDTH - 6)) lines.push(line ? `    ${line}` : '')
    lines.push('')
  }

  const shown = Math.min(TEXT_ROWS, page.entries.length)
  if (page.total > shown) {
    lines.push(c.dim(`  ${num(shown)} of ${num(page.total)} entries.`))
  } else {
    lines.push(c.dim(`  ${num(page.total)} ${page.total === 1 ? 'entry' : 'entries'}.`))
  }
  lines.push(c.dim('  Sign it at ') + c.accent('https://cailinpitt.com/guestbook'))
  lines.push('')

  return lines.join('\n') + '\n'
}
