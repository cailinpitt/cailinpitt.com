import { describe, expect, it } from 'vitest'
import { mentionKey, postMentions } from '../src/lib/mentions'

describe('mentionKey', () => {
  it('ignores scheme, www, fragment, tracking params, param order, and a trailing slash', () => {
    const key = 'example.com/a/b?x=1&y=2'
    expect(mentionKey('https://example.com/a/b?x=1&y=2')).toBe(key)
    expect(mentionKey('http://www.example.com/a/b/?y=2&x=1&utm_source=rss#top')).toBe(key)
  })

  it('keeps params that change the page', () => {
    expect(mentionKey('https://example.com/?p=12')).not.toBe(mentionKey('https://example.com/?p=13'))
  })

  it('is null for relative or non-http urls', () => {
    expect(mentionKey('/blog/2020/1/1/a')).toBeNull()
    expect(mentionKey('mailto:me@example.com')).toBeNull()
  })
})

describe('postMentions', () => {
  const older = { path: '/blog/2020/1/1/a', title: 'A', date: '2020-01-01', body: '[x](https://example.com/x)' }
  const newer = {
    path: '/blog/2021/1/1/b',
    title: 'B',
    date: '2021-01-01',
    body: 'See <https://www.example.com/x/> and [x again](https://example.com/x), [me](https://cailinpitt.com/now), [a](/blog/2020/1/1/a).',
  }

  it('maps each external url to the posts linking it, newest first, once per post', () => {
    const mentions = postMentions([older, newer])
    expect(mentions['example.com/x']).toEqual([
      { path: newer.path, title: 'B' },
      { path: older.path, title: 'A' },
    ])
  })

  it('skips links to this site', () => {
    expect(Object.keys(postMentions([newer]))).toEqual(['example.com/x'])
  })
})
