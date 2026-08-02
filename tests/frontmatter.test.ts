import { describe, expect, it } from 'vitest'
import { parseFrontmatter } from '../src/lib/frontmatter'

// The hand-rolled parser in src/lib/frontmatter.ts is the one thing standing
// between a post's frontmatter and every listing on the site. It is deliberately
// not YAML, so what it does and doesn't support is worth pinning down.

describe('parseFrontmatter', () => {
  it('reads plain, quoted, and JSON-array values', () => {
    const { data } = parseFrontmatter(
      ['---', 'title: "A post"', 'date: 2026-01-15', 'tags: ["music", "Year in Review"]', '---', '', 'Body.'].join(
        '\n',
      ),
    )
    expect(data.title).toBe('A post')
    expect(data.date).toBe('2026-01-15')
    expect(data.tags).toEqual(['music', 'Year in Review'])
  })

  it('keeps colons in a value', () => {
    // Only the *first* colon separates, or a title with a subtitle would truncate.
    const { data } = parseFrontmatter('---\ntitle: Cleveland: a love letter\n---\n')
    expect(data.title).toBe('Cleveland: a love letter')
  })

  it('returns the whole document as body when there is no frontmatter', () => {
    expect(parseFrontmatter('# Just markdown\n')).toEqual({ data: {}, body: '# Just markdown' })
  })

  it('strips the delimiters from the body', () => {
    const { body } = parseFrontmatter('---\ntitle: x\n---\n\nFirst line.\n\nSecond.\n')
    expect(body).toBe('First line.\n\nSecond.')
  })

  it('handles CRLF line endings', () => {
    const { data, body } = parseFrontmatter('---\r\ntitle: x\r\n---\r\nBody.\r\n')
    expect(data.title).toBe('x')
    expect(body).toBe('Body.')
  })

  it('skips comments and blank lines rather than storing them', () => {
    const { data } = parseFrontmatter('---\n# a comment\n\ntitle: x\nnot a pair\n---\n')
    expect(Object.keys(data)).toEqual(['title'])
  })

  it('falls back to the raw string when an array value will not parse', () => {
    // A typo in the brackets should show up as a visibly wrong tag, not throw
    // and take the whole build down.
    const { data } = parseFrontmatter('---\ntags: ["music"\n---\n')
    expect(data.tags).toBe('["music"')
  })
})
