import { describe, expect, it } from 'vitest'
import { linkedKeys, postKey, postLinks } from '../src/lib/postLinks'
import type { Post } from '../src/lib/posts'

const post = (path: string, body = ''): Post => ({
  path,
  title: path,
  date: '2026-01-01',
  slug: path.split('/').pop()!,
  tags: [],
  words: 0,
  body,
})

describe('postKey', () => {
  it('ignores origin, padding, and anything after the slug', () => {
    const key = '/blog/2026/8/1/some-post'
    expect(postKey('/blog/2026/8/01/some-post')).toBe(key)
    expect(postKey('https://cailinpitt.com/blog/2026/08/1/some-post/')).toBe(key)
    expect(postKey('https://www.cailinpitt.com/blog/2026/8/1/some-post#heading')).toBe(key)
    expect(postKey('/blog/2026/8/1/some-post.md')).toBe(key)
  })

  it('is null for anything that is not a post', () => {
    expect(postKey('/blog/tag/music')).toBeNull()
    expect(postKey('https://example.com/blog/2026/8/1/some-post')).toBeNull()
    expect(postKey('/images/some-post/a.webp')).toBeNull()
  })
})

describe('linkedKeys', () => {
  it('finds inline, html, reference, and autolinks once each, in order', () => {
    const body = [
      '[a](/blog/2020/1/1/a) and [a again](https://cailinpitt.com/blog/2020/1/1/a)',
      '<a href="/blog/2020/1/2/b">b</a> <https://www.cailinpitt.com/blog/2020/1/3/c>',
      '',
      '[d]: /blog/2020/1/4/d',
    ].join('\n')
    expect(linkedKeys(body)).toEqual([
      '/blog/2020/1/1/a',
      '/blog/2020/1/2/b',
      '/blog/2020/1/3/c',
      '/blog/2020/1/4/d',
    ])
  })

  it('skips links inside code', () => {
    expect(linkedKeys('`[a](/blog/2020/1/1/a)`\n```\n[b](/blog/2020/1/2/b)\n```')).toEqual([])
  })
})

describe('postLinks', () => {
  const a = post('/blog/2020/1/1/a', 'See [b](/blog/2020/1/02/b), [gone](/blog/2020/1/9/gone), [me](/blog/2020/1/1/a).')
  const b = post('/blog/2020/1/02/b')
  const c = post('/blog/2020/1/3/c', 'Like [b](https://cailinpitt.com/blog/2020/1/2/b).')
  const posts = [c, b, a]

  it('resolves outgoing links, dropping missing posts and self-links', () => {
    expect(postLinks(posts, a).outgoing).toEqual([b])
  })

  it('finds the posts linking in, in the order given', () => {
    expect(postLinks(posts, b).incoming).toEqual([c, a])
    expect(postLinks(posts, b).outgoing).toEqual([])
  })
})
