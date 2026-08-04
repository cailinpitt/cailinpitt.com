import { describe, expect, it } from 'vitest'
import { elide, parseUnifiedDiff, wordDiff, type Token } from '../src/lib/diff'

// A post's markdown puts a whole paragraph on one line, so git's line diff says
// "this 1,200-character paragraph left, this near-identical one arrived". The
// refinement in src/lib/diff.ts is what makes that readable, and these pin down
// the cases where it should and shouldn't apply.

/** The rendered result of a token stream, as three strings. */
const parts = (tokens: Token[]) => ({
  same: tokens.filter((t) => t.kind === 'same').map((t) => t.text),
  add: tokens.filter((t) => t.kind === 'add').map((t) => t.text),
  del: tokens.filter((t) => t.kind === 'del').map((t) => t.text),
})

/** Rebuilding one side of a diff has to give back exactly what went in. */
const rebuild = (tokens: Token[], side: 'before' | 'after') =>
  tokens
    .filter((t) => t.kind === 'same' || t.kind === (side === 'before' ? 'del' : 'add'))
    .map((t) => t.text)
    .join('')

describe('wordDiff', () => {
  it('finds the one word that changed in a paragraph', () => {
    const before = 'It also turnes out the tech CEOs were wrong about this.'
    const after = 'It also turned out the tech CEOs were wrong about this.'
    const tokens = wordDiff(before, after)
    expect(parts(tokens).del).toEqual(['turnes'])
    expect(parts(tokens).add).toEqual(['turned'])
  })

  it('reconstructs both sides exactly', () => {
    const before = 'I was able to find a sweet new job within a month.'
    const after = 'I was able to find a great new job within two months.'
    const tokens = wordDiff(before, after)
    expect(rebuild(tokens, 'before')).toBe(before)
    expect(rebuild(tokens, 'after')).toBe(after)
  })

  it('merges a run of inserted words into one token', () => {
    const tokens = wordDiff('the drums drive the rhythm', 'the drums really do drive the rhythm')
    expect(parts(tokens).add).toHaveLength(1)
  })

  it('handles insertion at either end', () => {
    expect(rebuild(wordDiff('b c', 'a b c'), 'after')).toBe('a b c')
    expect(rebuild(wordDiff('a b', 'a b c'), 'after')).toBe('a b c')
  })

  it('says nothing changed when nothing changed', () => {
    const tokens = wordDiff('same line', 'same line')
    expect(parts(tokens).add).toEqual([])
    expect(parts(tokens).del).toEqual([])
  })
})

describe('elide', () => {
  const long = (n: number) => 'word '.repeat(n).trim()

  it('cuts the untouched middle between two edits', () => {
    const tokens = elide([
      { kind: 'del', text: 'before' },
      { kind: 'same', text: ` ${long(200)} ` },
      { kind: 'add', text: 'after' },
    ])
    expect(tokens.filter((t) => t.kind === 'gap')).toHaveLength(1)
    // Context survives on both sides of the cut.
    expect(tokens[1].kind).toBe('same')
    expect(tokens[tokens.length - 2].kind).toBe('same')
  })

  it('drops the run before the first change entirely', () => {
    // Nobody needs the opening of a paragraph to understand a change at its end.
    const tokens = elide([
      { kind: 'same', text: `${long(200)} ` },
      { kind: 'add', text: 'new' },
    ])
    expect(tokens[0].kind).toBe('gap')
  })

  it('leaves a short run alone', () => {
    const tokens = elide([
      { kind: 'del', text: 'a' },
      { kind: 'same', text: ' short middle ' },
      { kind: 'add', text: 'b' },
    ])
    expect(tokens.some((t) => t.kind === 'gap')).toBe(false)
  })

  it('never cuts mid-word', () => {
    const tokens = elide([
      { kind: 'del', text: 'x' },
      { kind: 'same', text: ` ${long(200)} ` },
      { kind: 'add', text: 'y' },
    ])
    for (const token of tokens.filter((t) => t.kind === 'same')) {
      expect(token.text).toMatch(/^\s|\s$/)
      expect(token.text).not.toMatch(/wor$|^ord/)
    }
  })

  it('keeps a row that never changed intact', () => {
    expect(elide([{ kind: 'same', text: long(200) }])).toEqual([
      { kind: 'same', text: long(200) },
    ])
  })
})

/** A patch in the shape `git show --unified=0 --format=''` produces. */
const patch = (file: string, hunks: string[]) =>
  [
    `diff --git a/${file} b/${file}`,
    'index 001f014..3853029 100644',
    `--- a/${file}`,
    `+++ b/${file}`,
    ...hunks,
    '',
  ].join('\n')

describe('parseUnifiedDiff', () => {
  it('refines a changed line into one row', () => {
    const [diff] = parseUnifiedDiff(
      patch('content/blog/a.md', ['@@ -19 +19 @@', '-A sentence with a typo.', '+A sentence with a fix.']),
    )
    expect(diff.file).toBe('content/blog/a.md')
    expect(diff.rows).toHaveLength(1)
    expect(diff.rows[0].kind).toBe('changed')
  })

  it('keeps lines that have no counterpart whole', () => {
    const [diff] = parseUnifiedDiff(
      patch('content/blog/a.md', ['@@ -19,0 +20 @@', '+An entirely new paragraph.']),
    )
    expect(diff.rows).toEqual([{ kind: 'add', text: 'An entirely new paragraph.' }])
  })

  it('shows a rewrite as a replacement rather than confetti', () => {
    // Two lines with almost nothing in common: word-marking every token would
    // be less readable than the before and after.
    const [diff] = parseUnifiedDiff(
      patch('content/blog/a.md', [
        '@@ -7 +7 @@',
        '-description: "Paramore is one of my top five favorite bands of all time and I"',
        '+description: "Thoughts on the 2023 album."',
      ]),
    )
    expect(diff.rows.map((row) => row.kind)).toEqual(['del', 'add'])
  })

  it('skips a file the commit created', () => {
    const created = [
      'diff --git a/content/blog/new.md b/content/blog/new.md',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/content/blog/new.md',
      '@@ -0,0 +1 @@',
      '+The whole post.',
    ].join('\n')
    expect(parseUnifiedDiff(created)).toEqual([])
  })

  it('ignores blank lines moving around', () => {
    const [diff] = parseUnifiedDiff(patch('content/blog/a.md', ['@@ -19 +19 @@', '-', '+']))
    expect(diff).toBeUndefined()
  })

  it('separates the files of a commit that touched several posts', () => {
    const both =
      patch('content/blog/a.md', ['@@ -7 +7 @@', '-description: "old a"', '+description: "new a"']) +
      patch('content/blog/b.md', ['@@ -7 +7 @@', '-description: "old b"', '+description: "new b"'])
    const diffs = parseUnifiedDiff(both)
    expect(diffs.map((d) => d.file)).toEqual(['content/blog/a.md', 'content/blog/b.md'])
    expect(diffs[0].rows).toHaveLength(1)
  })

  it('does not treat a frontmatter fence as a file header', () => {
    // Frontmatter opens with "---", the same three characters that open the
    // old-file line of a patch.
    const [diff] = parseUnifiedDiff(
      patch('content/blog/a.md', ['@@ -1,3 +1,3 @@', '----', '-title: "Old"', '+title: "New"']),
    )
    expect(diff.rows.some((row) => row.kind === 'changed' || row.kind === 'del')).toBe(true)
  })

  it('returns nothing for an empty patch', () => {
    expect(parseUnifiedDiff('')).toEqual([])
  })
})
