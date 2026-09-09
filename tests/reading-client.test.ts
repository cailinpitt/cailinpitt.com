import { describe, expect, it } from 'vitest'
import { titleFromUrl } from '../src/lib/reading'

describe('titleFromUrl', () => {
  it('de-slugifies the last path segment with the host', () => {
    expect(titleFromUrl('https://tonsky.me/blog/checkbox')).toBe('Checkbox — tonsky.me')
    expect(titleFromUrl('https://en.wikipedia.org/wiki/Viola_jokes')).toBe(
      'Viola jokes — en.wikipedia.org',
    )
  })

  it('skips a trailing numeric id segment', () => {
    expect(
      titleFromUrl('https://www.startribune.com/move-over-coachella-the-fair/601881172'),
    ).toBe('Move over coachella the fair — startribune.com')
  })

  it('drops the query string and strips a file extension', () => {
    expect(titleFromUrl('https://sebsite.pw/w/20260806-pystrings.html?x=1')).toBe(
      '20260806 pystrings — sebsite.pw',
    )
  })

  it('falls back to the host when there is no usable slug', () => {
    expect(titleFromUrl('https://example.com/')).toBe('example.com')
  })

  it('returns the raw string when it will not parse', () => {
    expect(titleFromUrl('not a url')).toBe('not a url')
  })
})
