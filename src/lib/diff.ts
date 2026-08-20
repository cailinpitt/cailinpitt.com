// `git show` implementation for blog posts. Pure, runs at build time (cailinpitt:post-history
// plugin in vite.config.ts).

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

// Above this many words on a side, refinement (quadratic) is skipped and the pair shown as
// a plain replacement — a pair this size is a rewrite anyway.
const MAX_REFINE_TOKENS = 1200

// Below this, a refined pair has too little in common and reads as confetti — show old/new whole instead.
const MIN_SIMILARITY = 0.3

// Keeps whitespace so text reassembles exactly as written; punctuation rides with its word
// so "cooked." → "cooked!" is one changed token, not three.
const tokenize = (line: string): string[] => line.split(/(\s+)/).filter((part) => part !== '')

// Classic LCS DP table. Quadratic, but runs at build time on one paragraph, bounded by MAX_REFINE_TOKENS.
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
  // Merge same-kind runs as emitted, so a five-word insertion is one <ins>, not five.
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

/** Unchanged chars kept on each side of a change — enough to place the edit in its sentence. */
const CONTEXT_CHARS = 90

/** A run of unchanged text shorter than this isn't worth eliding. */
const MIN_ELIDE = 60

// Cuts the untouched middle out of long unchanged runs, so the diff opens on the change
// rather than a wall of prose (and shrinks what the prerendered loader data has to carry).
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

// Pairs removed/added lines in order (git's hunk order is its own correspondence judgment,
// not a second guess) and refines each pair. Leftovers on either side had no counterpart.
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

// Parses `git show --unified=0 --format=''` into one entry per file. Created files are
// skipped — their "diff" is the whole post, already shown on the page.
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
      // Blank lines are paragraph spacing, not an edit worth showing.
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
