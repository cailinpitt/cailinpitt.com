import { describe, expect, it } from 'vitest'
import {
  countWords,
  formatMonthDay,
  formatReadingTime,
  postsByYear,
  toPost,
  type PostSummary,
} from '../src/lib/posts'

const summary = (path: string, date: string, tags: string[] = []): PostSummary => ({
  path,
  title: path,
  date,
  slug: path,
  tags,
  words: 0,
})

describe('countWords', () => {
  it('counts prose', () => {
    expect(countWords('One two three four five.')).toBe(5)
  })

  it('ignores code, embeds, and image syntax', () => {
    // Photo essays are mostly images/iframes; counting those as prose falsely claimed a long read.
    const body = [
      'Two words.',
      '',
      '```js',
      'const a = 1 + 2 + 3 + 4 + 5 + 6 + 7',
      '```',
      '',
      '<iframe src="https://open.spotify.com/embed/track/abc" width="100%"></iframe>',
      '',
      '![A photograph of the lake at dusk](/images/post/lake.webp)',
      '',
      'Inline `code here` too.',
    ].join('\n')
    expect(countWords(body)).toBe(4) // "Two words." + "Inline too."
  })

  it('counts link text but not link targets', () => {
    // "Read the whole thing." — the url contributes nothing.
    expect(countWords('Read [the whole thing](https://example.com/a/very/long/path).')).toBe(4)
  })

  it('is zero for a body of nothing but markup', () => {
    expect(countWords('---\n\n<br />\n\n***')).toBe(0)
  })
})

describe('formatReadingTime', () => {
  it('says nothing about a post with almost no prose', () => {
    expect(formatReadingTime(0)).toBeNull()
    expect(formatReadingTime(99)).toBeNull()
  })

  it('rounds to whole minutes once there is enough to estimate', () => {
    expect(formatReadingTime(100)).toBe('1 min read')
    expect(formatReadingTime(1000)).toBe('5 min read')
  })
})

describe('postsByYear', () => {
  it('groups consecutive posts under their year, keeping the incoming order', () => {
    const groups = postsByYear([
      summary('/c', '2026-02-01'),
      summary('/b', '2026-01-01'),
      summary('/a', '2019-05-05'),
    ])
    expect(groups.map((g) => g.year)).toEqual(['2026', '2019'])
    expect(groups[0].posts.map((p) => p.path)).toEqual(['/c', '/b'])
  })

  it('collects undated posts rather than dropping them', () => {
    const groups = postsByYear([summary('/a', '2026-02-01'), summary('/b', '')])
    expect(groups.map((g) => g.year)).toEqual(['2026', 'Undated'])
  })
})

describe('formatMonthDay', () => {
  it('drops the year, since /blog carries it in the heading above the row', () => {
    expect(formatMonthDay('2023-03-03')).toBe('March 3')
  })

  it('returns an unparsable date unchanged rather than an empty row', () => {
    expect(formatMonthDay('sometime')).toBe('sometime')
  })
})

describe('toPost', () => {
  it('falls back to the filename when path, slug, and title are missing', () => {
    const post = toPost('content/blog/my-post.md', '---\ndate: 2026-01-01\n---\n\nHi.')
    expect(post.path).toBe('/blog/my-post')
    expect(post.slug).toBe('my-post')
    expect(post.title).toBe('my-post')
  })

  it('carries the revision date through', () => {
    // Parsed, shown in .post-meta, and emitted as JSON-LD dateModified.
    const raw = '---\ntitle: x\ndate: 2026-01-01\nupdated: 2026-02-03\n---\n\nHi.'
    expect(toPost('content/blog/x.md', raw).updated).toBe('2026-02-03')
  })

  it('attaches the AT-URI matching the post path', () => {
    const raw = '---\ntitle: x\npath: /blog/2026/1/1/x\n---\n\nHi.'
    const post = toPost('content/blog/x.md', raw, {
      did: 'did:plc:abc',
      publication: 'at://pub',
      documents: { '/blog/2026/1/1/x': 'at://doc' },
    })
    expect(post.atUri).toBe('at://doc')
  })
})
