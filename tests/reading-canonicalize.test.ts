import { describe, expect, it } from 'vitest'
import { canonicalizeUrl } from '../worker-reading/src/articles'

describe('canonicalizeUrl', () => {
  it('strips common tracking params', () => {
    expect(
      canonicalizeUrl(
        'https://example.com/post?utm_source=x&gclid=1&fbclid=2&mc_eid=3&_hsenc=4&mtm_campaign=5&srsltid=6&mkt_tok=7',
      ),
    ).toBe('https://example.com/post')
  })

  it('keeps params that change the page', () => {
    expect(canonicalizeUrl('https://example.com/?p=12&utm_medium=email&q=cats')).toBe(
      'https://example.com/?p=12&q=cats',
    )
  })

  it('keeps gift-link access params', () => {
    expect(
      canonicalizeUrl('https://www.nytimes.com/a.html?referringSource=articleShare&smid=url-share&unlocked_article_code=1.x'),
    ).toBe('https://www.nytimes.com/a.html?unlocked_article_code=1.x')
    expect(canonicalizeUrl('https://www.bloomberg.com/news/a?accessToken=tok&leadSource=article-gifting')).toBe(
      'https://www.bloomberg.com/news/a?accessToken=tok',
    )
  })

  it('matches tracking params case-insensitively', () => {
    expect(canonicalizeUrl('https://example.com/a?UTM_Source=x&trackingId=y')).toBe('https://example.com/a')
  })

  it('strips site-specific params only on that site', () => {
    expect(canonicalizeUrl('https://x.com/user/status/1?s=20&t=abc')).toBe('https://x.com/user/status/1')
    expect(canonicalizeUrl('https://www.youtube.com/watch?v=abc&feature=share&si=xyz')).toBe(
      'https://www.youtube.com/watch?v=abc',
    )
    expect(
      canonicalizeUrl('https://foo.substack.com/p/bar?isFreemail=true&post_id=1&publication_id=2&r=abc&triedRedirect=true'),
    ).toBe('https://foo.substack.com/p/bar')
    expect(canonicalizeUrl('https://foo.blogspot.com/2026/08/post.html?m=1')).toBe('https://foo.blogspot.com/2026/08/post.html')
    expect(canonicalizeUrl('https://example.com/search?s=20&t=abc')).toBe('https://example.com/search?s=20&t=abc')
  })

  it('drops the fragment, sorts params, and trims a trailing slash', () => {
    expect(canonicalizeUrl('https://example.com/a/?b=2&a=1#section')).toBe('https://example.com/a?a=1&b=2')
  })

  it('rejects non-web urls', () => {
    expect(canonicalizeUrl('ftp://example.com/file')).toBeNull()
    expect(canonicalizeUrl('not a url')).toBeNull()
  })
})
