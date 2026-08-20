import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { glyphs, MAX_LENGTH, notePath, noteUrl, paragraphs, segments } from '../src/lib/notes'
import { clean, validate, MAX_LENGTH as WORKER_MAX } from '../worker-notes/src/validate'

// The pure halves of the microblog. worker-notes/ has no test setup of its own, same arrangement as worker-guestbook's validate.ts.

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

describe('the character limit', () => {
  it('is the same number on both sides of the wire', () => {
    // The compose box counts down from its own copy; if these drift it accepts a note the Worker refuses.
    expect(MAX_LENGTH).toBe(WORKER_MAX)
  })

  it('is the number the schema comment claims', () => {
    // schema.sql documents the cap next to the column; a stale comment teaches the wrong limit.
    const schema = readFileSync(path.join(ROOT, 'worker-notes', 'schema.sql'), 'utf8')
    expect(schema).toContain(`<= ${MAX_LENGTH} code points`)
  })

  it('counts an emoji as one character', () => {
    // '👋'.length is 2; a counter using it would disagree with the Worker.
    expect(glyphs('👋')).toBe(1)
    expect(glyphs('👋👋')).toBe(2)
    expect(glyphs('hello')).toBe(5)
  })
})

describe('validate', () => {
  it('accepts an ordinary note', () => {
    const result = validate({ text: 'trains are good, actually' })
    expect(result).toEqual({
      ok: true,
      value: 'trains are good, actually',
      context: null,
      link: { url: null, hidden: false },
    })
  })

  it('refuses an empty note', () => {
    expect(validate({ text: '   \n  ' }).ok).toBe(false)
    expect(validate({}).ok).toBe(false)
    expect(validate({ text: 42 }).ok).toBe(false)
  })

  it('refuses one character over the limit, and accepts one under', () => {
    expect(validate({ text: 'a'.repeat(MAX_LENGTH) }).ok).toBe(true)
    expect(validate({ text: 'a'.repeat(MAX_LENGTH + 1) }).ok).toBe(false)
  })

  it('measures the limit in code points, not UTF-16 units', () => {
    // MAX_LENGTH emoji is at the limit, but would be twice over it under .length.
    expect(validate({ text: '👋'.repeat(MAX_LENGTH) }).ok).toBe(true)
    expect(validate({ text: '👋'.repeat(MAX_LENGTH + 1) }).ok).toBe(false)
  })

  it('accepts a note with no context, same as before context existed', () => {
    const result = validate({ text: 'no reference here' })
    expect(result).toEqual({
      ok: true,
      value: 'no reference here',
      context: null,
      link: { url: null, hidden: false },
    })
  })

  it('accepts a note with a well-formed context', () => {
    const result = validate({ text: 'about that ride', contextType: 'activity', contextRef: '12345' })
    expect(result).toEqual({
      ok: true,
      value: 'about that ride',
      context: { type: 'activity', ref: '12345' },
      link: { url: null, hidden: false },
    })
  })

  it('refuses a context type it does not recognize', () => {
    expect(validate({ text: 'hm', contextType: 'tweet', contextRef: '1' }).ok).toBe(false)
  })

  it('refuses a context type with no ref to go with it', () => {
    expect(validate({ text: 'hm', contextType: 'photo' }).ok).toBe(false)
  })

  it('refuses a ref with no context type to go with it', () => {
    // Half a reference is a client bug, not something to guess at.
    expect(validate({ text: 'hm', contextRef: 'abc123' }).ok).toBe(false)
  })

  it('accepts a well-formed link', () => {
    const result = validate({ text: 'see https://example.com', linkUrl: 'https://example.com' })
    expect(result).toEqual({
      ok: true,
      value: 'see https://example.com',
      context: null,
      link: { url: 'https://example.com', hidden: false },
    })
  })

  it('accepts a hidden link whose text still contains it', () => {
    const result = validate({
      text: 'see https://example.com',
      linkUrl: 'https://example.com',
      linkHidden: true,
    })
    expect(result).toEqual({
      ok: true,
      value: 'see https://example.com',
      context: null,
      link: { url: 'https://example.com', hidden: true },
    })
  })

  it('accepts a hidden link even once the text no longer contains it', () => {
    // Re-saving a note whose link text was already stripped on a previous edit. See validateLink in validate.ts.
    expect(validate({ text: 'just the caption now', linkUrl: 'https://example.com', linkHidden: true }).ok).toBe(
      true,
    )
  })

  it('refuses something that is not a link', () => {
    expect(validate({ text: 'hm', linkUrl: 'not a url' }).ok).toBe(false)
  })

  it('refuses a hidden flag with no link to hide', () => {
    expect(validate({ text: 'hm', linkHidden: true }).ok).toBe(false)
  })
})

describe('clean', () => {
  it('keeps newlines but drops the other control characters', () => {
    // Zero-width and bidi chars are how stored text renders in an order it isn't stored in.
    expect(clean('a​b')).toBe('ab')
    expect(clean('a‮b')).toBe('ab')
    expect(clean('one\ntwo')).toBe('one\ntwo')
  })

  it('collapses a run of blank lines to one', () => {
    // A stray paste of newlines would be a note three screens tall in a feed with no height limit.
    expect(clean('a\n\n\n\n\nb')).toBe('a\n\nb')
  })

  it('normalizes line endings and trailing space', () => {
    expect(clean('a  \r\nb\r')).toBe('a\nb')
  })
})

describe('segments', () => {
  it('leaves ordinary prose alone', () => {
    expect(segments('just a thought')).toEqual([{ kind: 'text', value: 'just a thought' }])
  })

  it('links a bare url', () => {
    expect(segments('see https://example.com now')).toEqual([
      { kind: 'text', value: 'see ' },
      { kind: 'link', value: 'https://example.com', href: 'https://example.com' },
      { kind: 'text', value: ' now' },
    ])
  })

  it('gives back the full stop at the end of a sentence', () => {
    // "see https://example.com." should link the URL, not the punctuation.
    const parts = segments('see https://example.com.')
    expect(parts[1]).toEqual({
      kind: 'link',
      value: 'https://example.com',
      href: 'https://example.com',
    })
    expect(parts[2]).toEqual({ kind: 'text', value: '.' })
  })

  it('gives back a closing paren it never opened', () => {
    const parts = segments('(see https://example.com)')
    expect(parts[1].value).toBe('https://example.com')
    expect(parts[2]).toEqual({ kind: 'text', value: ')' })
  })

  it('keeps a paren that is part of the url', () => {
    const parts = segments('https://en.wikipedia.org/wiki/Tag_(2018_film)')
    expect(parts[0].value).toBe('https://en.wikipedia.org/wiki/Tag_(2018_film)')
  })

  it('gives a www host a scheme', () => {
    expect(segments('www.example.com')).toEqual([
      { kind: 'link', value: 'www.example.com', href: 'https://www.example.com' },
    ])
  })

  it('does not link a sentence that merely contains a period', () => {
    // Deliberately narrow: anything cleverer starts turning ordinary prose into links.
    expect(segments('I went to bed.Then I got up')).toEqual([
      { kind: 'text', value: 'I went to bed.Then I got up' },
    ])
  })

  it('loses no text, whatever the input', () => {
    // segments() must partition the string; a trimming bug would silently eat characters.
    for (const text of [
      'plain',
      'https://a.example',
      'a https://b.example c',
      '(https://c.example), and www.d.example!',
      'https://e.example/x?y=1&z=2#frag done',
      'a #tag and https://f.example#frag together',
      '## not a tag',
      '',
    ]) {
      expect(segments(text).map((s) => s.value).join('')).toBe(text)
    }
  })

  it('links a hashtag', () => {
    expect(segments('a #running day')).toEqual([
      { kind: 'text', value: 'a ' },
      { kind: 'hashtag', value: '#running', tag: 'running' },
      { kind: 'text', value: ' day' },
    ])
  })

  it('lowercases the tag for grouping but keeps what was typed as the display value', () => {
    expect(segments('#RunClub')).toEqual([{ kind: 'hashtag', value: '#RunClub', tag: 'runclub' }])
  })

  it('stops a hashtag at punctuation', () => {
    expect(segments('#running, today')).toEqual([
      { kind: 'hashtag', value: '#running', tag: 'running' },
      { kind: 'text', value: ', today' },
    ])
  })

  it('does not turn a url fragment into a hashtag', () => {
    // The `#section` here belongs to the link, same as a URL's own query string.
    expect(segments('see https://example.com#section')).toEqual([
      { kind: 'text', value: 'see ' },
      { kind: 'link', value: 'https://example.com#section', href: 'https://example.com#section' },
    ])
  })

  it('does not link a bare ## or a hashtag with nothing after it', () => {
    expect(segments('## nope')).toEqual([{ kind: 'text', value: '## nope' }])
  })
})

describe('paragraphs', () => {
  it('splits on blank lines and keeps single breaks inside', () => {
    expect(paragraphs('one\ntwo\n\nthree')).toEqual(['one\ntwo', 'three'])
  })

  it('produces nothing for an empty note', () => {
    expect(paragraphs('')).toEqual([])
  })
})

describe('notePath', () => {
  it('is an anchor on the feed, not a route', () => {
    // For the SPA's internal navigation only; noteUrl below is the shareable address, deliberately different.
    expect(notePath('a3f91c2b40d1')).toBe('/notes#a3f91c2b40d1')
  })
})

describe('noteUrl', () => {
  it('points at the real permalink, not the feed anchor', () => {
    // worker-notes serves this path directly, meant to be shared outside the SPA (a bot needs a URL, not a hash).
    expect(noteUrl('a3f91c2b40d1', 'https://cailinpitt.com')).toBe(
      'https://cailinpitt.com/notes/a3f91c2b40d1',
    )
  })
})
