import { describe, expect, it } from 'vitest'
import { LIMITS, validate } from '../worker-comments/src/validate'

const ok = (over: Record<string, unknown> = {}) => ({
  postPath: '/blog/2026/8/21/some-slug',
  name: 'Ada',
  message: 'Hello!',
  ...over,
})

describe('validate', () => {
  it('accepts an ordinary comment', () => {
    const result = validate(ok())
    expect(result).toEqual({
      ok: true,
      value: {
        postPath: '/blog/2026/8/21/some-slug',
        name: 'Ada',
        message: 'Hello!',
        website: null,
      },
    })
  })

  it('rejects a post path that is not shaped like a post', () => {
    for (const postPath of ['/blog/', '/guestbook', '/blog/2026/8/21', 'not-a-path']) {
      expect(validate(ok({ postPath })), postPath).toMatchObject({ ok: false, field: 'postPath' })
    }
  })

  it('accepts both padded and unpadded month/day, since frontmatter paths are free-form', () => {
    expect(validate(ok({ postPath: '/blog/2026/08/01/some-slug' })).ok).toBe(true)
    expect(validate(ok({ postPath: '/blog/2026/8/1/some-slug' })).ok).toBe(true)
  })

  it('requires a name and a message', () => {
    expect(validate(ok({ name: undefined }))).toMatchObject({ ok: false, field: 'name' })
    expect(validate(ok({ message: undefined }))).toMatchObject({ ok: false, field: 'message' })
  })

  it('measures length in code points, so an emoji costs one character', () => {
    expect(validate(ok({ name: '👋'.repeat(LIMITS.name) })).ok).toBe(true)
    expect(validate(ok({ name: '👋'.repeat(LIMITS.name + 1) }))).toMatchObject({
      ok: false,
      field: 'name',
    })
  })

  it('rejects a multi-line name', () => {
    expect(validate(ok({ name: 'Ada\nLovelace' }))).toMatchObject({ ok: false, field: 'name' })
  })

  it('allows a couple of links and refuses an advert', () => {
    expect(validate(ok({ message: 'See example.com and www.example.org' })).ok).toBe(true)
    expect(
      validate(ok({ message: 'buy.shop cheap.top now.click deals.xyz' })),
    ).toMatchObject({ ok: false, field: 'message' })
  })

  it('upgrades a bare host to https and re-serializes it', () => {
    expect(validate(ok({ website: 'Example.com/page' }))).toMatchObject({
      ok: true,
      value: { website: 'https://example.com/page' },
    })
  })

  it('refuses a website that is not an ordinary http(s) address', () => {
    for (const website of ['javascript:alert(1)', 'https://paypal.com@evil.example']) {
      expect(validate(ok({ website })), website).toMatchObject({ ok: false, field: 'website' })
    }
  })
})
