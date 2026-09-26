import { describe, expect, it } from 'vitest'
import { commentPing } from '../worker-comments/src/pingMessage'
import { entryPing } from '../worker-guestbook/src/pingMessage'

describe('entryPing', () => {
  const entry = {
    id: 'abc123',
    name: 'Ada',
    message: 'Lovely site!',
    website: null,
    location: 'Chicago',
    country: 'US',
    createdAt: 0,
  }

  it('titles with the name and location', () => {
    expect(entryPing(entry)).toEqual({
      title: 'Ada · Chicago',
      body: 'Lovely site!',
      click: 'https://cailinpitt.com/guestbook',
    })
  })

  it('falls back to the country, then to just the name', () => {
    expect(entryPing({ ...entry, location: null }).title).toBe('Ada · US')
    expect(entryPing({ ...entry, location: null, country: null }).title).toBe('Ada')
  })
})

describe('commentPing', () => {
  it('names the post and links to its comments', () => {
    expect(
      commentPing({
        postPath: '/blog/2026/8/21/some-slug',
        name: 'Ada',
        message: 'Great post',
      }),
    ).toEqual({
      title: 'Ada on some-slug',
      body: 'Great post',
      click: 'https://cailinpitt.com/blog/2026/8/21/some-slug#comments-heading',
    })
  })
})
