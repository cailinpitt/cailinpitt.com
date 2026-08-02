import { describe, expect, it } from 'vitest'
import { collectTags, postsWithTag, relatedPosts, tagSlug } from '../src/lib/tags'
import type { PostSummary } from '../src/lib/posts'

const post = (path: string, tags: string[]): PostSummary => ({
  path,
  title: path,
  date: '2026-01-01',
  slug: path,
  tags,
  words: 0,
})

describe('tagSlug', () => {
  it('collapses casing and punctuation, which is what keeps one tag from becoming two', () => {
    expect(tagSlug('Year in Review')).toBe('year-in-review')
    expect(tagSlug('year in review')).toBe('year-in-review')
    expect(tagSlug('  Music!  ')).toBe('music')
  })

  it('is empty for a tag with nothing url-safe in it', () => {
    // collectTags and the palette both skip these; a `/blog/tag/` page with no
    // slug would be the blog index wearing a hat.
    expect(tagSlug('...')).toBe('')
  })
})

describe('collectTags', () => {
  it('counts by slug and labels with the most recent spelling', () => {
    // Posts arrive newest-first, so the first spelling seen is the current one.
    const tags = collectTags([post('/new', ['Music']), post('/old', ['music'])])
    expect(tags).toEqual([{ slug: 'music', label: 'Music', count: 2 }])
  })

  it('orders by count, then alphabetically', () => {
    const tags = collectTags([post('/a', ['zebra', 'music']), post('/b', ['music', 'apple'])])
    expect(tags.map((t) => t.slug)).toEqual(['music', 'apple', 'zebra'])
  })
})

describe('postsWithTag', () => {
  it('matches on slug, so a casing difference still lands on the page', () => {
    const posts = [post('/a', ['Year in Review']), post('/b', ['music'])]
    expect(postsWithTag(posts, 'year-in-review').map((p) => p.path)).toEqual(['/a'])
  })
})

describe('relatedPosts', () => {
  it('ranks by shared tags and never returns the post itself', () => {
    const self = post('/self', ['music', 'reviews'])
    const posts = [self, post('/one', ['music']), post('/both', ['music', 'reviews'])]
    expect(relatedPosts(posts, self).map((p) => p.path)).toEqual(['/both', '/one'])
  })

  it('gives an untagged post nothing rather than three arbitrary ones', () => {
    const self = post('/self', [])
    expect(relatedPosts([self, post('/a', ['music'])], self)).toEqual([])
  })

  it('breaks ties toward the newer post', () => {
    // The incoming order is newest-first and the sort is stable, so among the
    // posts sharing exactly one tag the recent ones surface.
    const self = post('/self', ['music'])
    const posts = [self, post('/newer', ['music']), post('/older', ['music'])]
    expect(relatedPosts(posts, self, 1).map((p) => p.path)).toEqual(['/newer'])
  })

  it('honors the limit', () => {
    const self = post('/self', ['music'])
    const posts = [self, ...['/a', '/b', '/c', '/d'].map((p) => post(p, ['music']))]
    expect(relatedPosts(posts, self)).toHaveLength(3)
  })
})
