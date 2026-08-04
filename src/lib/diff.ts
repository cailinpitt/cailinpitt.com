/**
 * `git show` implementation for blog posts.
 *
 * Everything here is pure and runs at build time (the cailinpitt:post-history
 * plugin in vite.config.ts).
 */

export type TokenKind = 'same' | 'add' | 'del' | 'gap'

export interface Token {
  kind: TokenKind
  text: string
}

export type DiffRow =
  /** A line matched with its replacement, refined to the changed words. */
  | { kind: 'changed'; tokens: Token[] }
  /** A line with no counterpart — added or removed outright. */
  | { kind: 'add' | 'del'; text: string }

export interface FileDiff {
  /** Path within the repo, as git prints it. */
  file: string
  rows: DiffRow[]
  /** Whether rows were dropped to keep the page (and the build) small. */
  truncated: boolean
}

/** Rows past this are dropped: nobody reads the 41st changed paragraph inline. */
const MAX_ROWS = 40

/**
 * Above this many words on either side, a pair is shown as a plain
 * replacement instead of being refined. The refinement below is quadratic, and
 * a pair this size is a rewrite — every word has changed, so marking them all
 * says nothing the two lines don't already say.
 */
const MAX_REFINE_TOKENS = 1200

/**
 * How much of a pair must survive for the refinement to be worth showing. Below
 * this the two lines have little in common, and a word diff turns into confetti
 * — better to show the old line and the new one whole.
 */
const MIN_SIMILARITY = 0.3

/**
 * Split into words and the whitespace between them, keeping both, so the text
 * can be reassembled exactly as written. Punctuation rides along with its word,
 * which is what makes "cooked." → "cooked!" one changed token rather than three.
 */
const tokenize = (line: string): string[] => line.split(/(\s+)/).filter((part) => part !== '')

/**
 * Longest common subsequence of two token lists, as a merged token stream.
 *
 * The classic dynamic-programming table. Quadratic, but it runs at build time
 * on one paragraph at a time, and MAX_REFINE_TOKENS keeps the worst case small.
 */
export function wordDiff(before: string, after: string): Token[] {
  const a = tokenize(before)
  const b = tokenize(after)

  const lengths: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  )
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lengths[i][j] =
        a[i] === b[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1])
    }
  }

  const tokens: Token[] = []
  // Runs of the same kind are merged as they're emitted, so a five-word
  // insertion is one <ins> rather than five adjacent ones.
  const push = (kind: TokenKind, text: string) => {
    const last = tokens[tokens.length - 1]
    if (last?.kind === kind) last.text += text
    else tokens.push({ kind, text })
  }

  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push('same', a[i])
      i++
      j++
    } else if (lengths[i + 1][j] >= lengths[i][j + 1]) {
      push('del', a[i++])
    } else {
      push('add', b[j++])
    }
  }
  while (i < a.length) push('del', a[i++])
  while (j < b.length) push('add', b[j++])
  return tokens
}

/**
 * Unchanged text kept on each side of a change, in characters. Enough to place
 * the edit in its sentence.
 */
const CONTEXT_CHARS = 90

/** A run of unchanged text shorter than this isn't worth eliding. */
const MIN_ELIDE = 60

/**
 * Cut the untouched middle out of long unchanged runs.
 *
 * A post's paragraph runs to a thousand characters, and a typo fix changes one
 * word of it. Without this the diff opens on a wall of prose with the change
 * somewhere below the fold — the reader has to hunt for the thing the diff
 * exists to show. Trimming to the neighborhood of each change also cuts what
 * the page has to carry, since these end up in the prerendered loader data.
 */
export function elide(tokens: Token[]): Token[] {
  const out: Token[] = []
  for (const [index, token] of tokens.entries()) {
    if (token.kind !== 'same') {
      out.push(token)
      continue
    }
    const atStart = index === 0
    const atEnd = index === tokens.length - 1
    // Nothing changed on either side of it, so there's no change to sit near.
    if (atStart && atEnd) {
      out.push(token)
      continue
    }
    // A run bounded by changes on both sides keeps context twice over.
    const budget = (atStart || atEnd ? 1 : 2) * CONTEXT_CHARS
    if (token.text.length <= budget + MIN_ELIDE) {
      out.push(token)
      continue
    }
    // Cut at a space so the elision doesn't land mid-word.
    const head = atStart ? '' : token.text.slice(0, CONTEXT_CHARS).replace(/\S*$/, '')
    const tail = atEnd ? '' : token.text.slice(-CONTEXT_CHARS).replace(/^\S*/, '')
    if (head) out.push({ kind: 'same', text: head })
    out.push({ kind: 'gap', text: '…' })
    if (tail) out.push({ kind: 'same', text: tail })
  }
  return out
}

/** The share of a refined pair that didn't change, by character count. */
function similarity(tokens: Token[]): number {
  let same = 0
  let total = 0
  for (const token of tokens) {
    if (token.kind === 'same') same += token.text.length * 2
    total += token.text.length
  }
  return total === 0 ? 1 : same / (total + same)
}

/**
 * Pair removed lines with added ones, in order, and refine each pair.
 *
 * Git has already decided which lines correspond by position within the hunk,
 * so pairing them in order is its judgment, not a second guess at it. Leftovers
 * on either side had no counterpart and stay whole.
 */
function rowsFor(dels: string[], adds: string[]): DiffRow[] {
  const rows: DiffRow[] = []
  const pairs = Math.min(dels.length, adds.length)
  for (let n = 0; n < pairs; n++) {
    const before = dels[n]
    const after = adds[n]
    const tooBig =
      tokenize(before).length > MAX_REFINE_TOKENS || tokenize(after).length > MAX_REFINE_TOKENS
    const tokens = tooBig ? null : wordDiff(before, after)
    // Similarity is judged on the whole pair, then the untouched middle goes.
    if (tokens && similarity(tokens) >= MIN_SIMILARITY) {
      rows.push({ kind: 'changed', tokens: elide(tokens) })
    } else {
      rows.push({ kind: 'del', text: before })
      rows.push({ kind: 'add', text: after })
    }
  }
  for (const text of dels.slice(pairs)) rows.push({ kind: 'del', text })
  for (const text of adds.slice(pairs)) rows.push({ kind: 'add', text })
  return rows
}

/**
 * Parse `git show --unified=0 --format=''` into one entry per file.
 *
 * Files the commit *created* are skipped: the "diff" of a new post is the post,
 * which the page is already showing. Context lines don't appear at all at
 * --unified=0, which is what's wanted here — the changed paragraphs are the
 * story, and in markdown the surrounding context is a blank line.
 */
export function parseUnifiedDiff(patch: string): FileDiff[] {
  const files: FileDiff[] = []
  // Split on the header rather than on "---", which also opens frontmatter.
  for (const section of patch.split(/^diff --git /m).slice(1)) {
    const lines = section.split('\n')
    const file = lines[0].match(/ b\/(.+)$/)?.[1]
    if (!file) continue
    // A new file has no prior version to compare against.
    if (lines.some((line) => line.startsWith('--- /dev/null'))) continue

    const rows: DiffRow[] = []
    let dels: string[] = []
    let adds: string[] = []
    let truncated = false
    const flush = () => {
      if (dels.length || adds.length) rows.push(...rowsFor(dels, adds))
      dels = []
      adds = []
    }

    for (const line of lines) {
      if (line.startsWith('--- ') || line.startsWith('+++ ')) continue
      if (line.startsWith('@@')) {
        flush()
        continue
      }
      // Blank lines moving around are paragraph spacing, not an edit anyone
      // wants to read about, and they'd render as empty rows.
      if (line.startsWith('-') && line.slice(1).trim()) dels.push(line.slice(1))
      else if (line.startsWith('+') && line.slice(1).trim()) adds.push(line.slice(1))
    }
    flush()

    if (rows.length > MAX_ROWS) {
      rows.length = MAX_ROWS
      truncated = true
    }
    if (rows.length) files.push({ file, rows, truncated })
  }
  return files
}
