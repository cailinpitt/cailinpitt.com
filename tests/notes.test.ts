import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { glyphs, MAX_LENGTH, notePath, noteUrl, paragraphs, segments } from '../src/lib/notes'
import { clean, validate, MAX_LENGTH as WORKER_MAX } from '../worker-notes/src/validate'

// The pure halves of the microblog, on both sides of the wire.
//
// worker-notes/ has no test setup of its own — same arrangement as
// worker-guestbook's validate.ts, which is tested from here for the same reason:
// the file is pure, it decides what may be stored, and it is worth more covered
// from the site's suite than uncovered in a package nobody runs `vitest` in.

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

describe('the character limit', () => {
  it('is the same number on both sides of the wire', () => {
    // The compose box counts down from its own copy so the counter is right on
    // the first keystroke, before any request could have landed. If these drift,
    // the box happily accepts a note the Worker then refuses.
    expect(MAX_LENGTH).toBe(WORKER_MAX)
  })

  it('is the number the schema comment claims', () => {
    // schema.sql documents the cap next to the column it bounds. A stale comment
    // there is how the next person learns the wrong limit.
    const schema = readFileSync(path.join(ROOT, 'worker-notes', 'schema.sql'), 'utf8')
    expect(schema).toContain(`<= ${MAX_LENGTH} code points`)
  })

  it('counts an emoji as one character', () => {
    // '👋'.length is 2. A counter that used it would tell you a note of emoji
    // was twice as long as it is, and the Worker would disagree.
    expect(glyphs('👋')).toBe(1)
    expect(glyphs('👋👋')).toBe(2)
    expect(glyphs('hello')).toBe(5)
  })
})

describe('validate', () => {
  it('accepts an ordinary note', () => {
    const result = validate({ text: 'trains are good, actually' })
    expect(result).toEqual({ ok: true, value: 'trains are good, actually', context: null })
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
    // MAX_LENGTH emoji is exactly at the limit, and would be twice over it if
    // anything here used .length.
    expect(validate({ text: '👋'.repeat(MAX_LENGTH) }).ok).toBe(true)
    expect(validate({ text: '👋'.repeat(MAX_LENGTH + 1) }).ok).toBe(false)
  })

  it('accepts a note with no context, same as before context existed', () => {
    const result = validate({ text: 'no reference here' })
    expect(result).toEqual({ ok: true, value: 'no reference here', context: null })
  })

  it('accepts a note with a well-formed context', () => {
    const result = validate({ text: 'about that ride', contextType: 'activity', contextRef: '12345' })
    expect(result).toEqual({
      ok: true,
      value: 'about that ride',
      context: { type: 'activity', ref: '12345' },
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
})

describe('clean', () => {
  it('keeps newlines but drops the other control characters', () => {
    // The zero-width and bidi characters are the ones worth naming: they are how
    // stored text renders in an order it isn't stored in.
    expect(clean('a​b')).toBe('ab')
    expect(clean('a‮b')).toBe('ab')
    expect(clean('one\ntwo')).toBe('one\ntwo')
  })

  it('collapses a run of blank lines to one', () => {
    // A stray paste of newlines would otherwise be a note three screens tall in
    // a feed with no per-note height limit.
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
    // The rule is deliberately narrow: anything cleverer starts turning ordinary
    // prose into links.
    expect(segments('I went to bed.Then I got up')).toEqual([
      { kind: 'text', value: 'I went to bed.Then I got up' },
    ])
  })

  it('loses no text, whatever the input', () => {
    // The invariant that matters: segments() is a partition of the string. A bug
    // in the trailing-punctuation trimming would silently eat characters out of
    // a published note.
    for (const text of [
      'plain',
      'https://a.example',
      'a https://b.example c',
      '(https://c.example), and www.d.example!',
      'https://e.example/x?y=1&z=2#frag done',
      '',
    ]) {
      expect(segments(text).map((s) => s.value).join('')).toBe(text)
    }
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
    // notePath is for the SPA's own internal navigation, which stays a
    // client-side jump rather than a round trip through the Worker. The real,
    // externally-shareable address is noteUrl, below — the two are deliberately
    // different, not a leftover of one replacing the other.
    expect(notePath('a3f91c2b40d1')).toBe('/notes#a3f91c2b40d1')
  })
})

describe('noteUrl', () => {
  it('points at the real permalink, not the feed anchor', () => {
    // worker-notes serves this path directly (see the header of
    // worker-notes/src/index.ts) — unlike notePath, this is meant to be shared
    // outside the SPA, where a bot needs a URL to fetch rather than a hash to
    // scroll to.
    expect(noteUrl('a3f91c2b40d1', 'https://cailinpitt.com')).toBe(
      'https://cailinpitt.com/notes/a3f91c2b40d1',
    )
  })
})
