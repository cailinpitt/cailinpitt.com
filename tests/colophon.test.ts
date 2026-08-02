import { describe, expect, it } from 'vitest'
import { fillTemplate } from '../src/lib/colophon'

// The substitution step behind the numbers quoted in content/colophon.md. It is
// a fill-in-the-blanks pass, not a template language — these tests are mostly
// about the three decisions in it that aren't obvious.

describe('fillTemplate', () => {
  it('substitutes values, thousands-separating numbers', () => {
    expect(fillTemplate('{{photos}} photographs in {{galleries}} galleries', {
      photos: 1234,
      galleries: 9,
    })).toBe('1,234 photographs in 9 galleries')
  })

  it('leaves an unknown placeholder in the text rather than blanking it', () => {
    // A typo should be visible the first time the page is previewed, not quietly
    // delete half a sentence.
    expect(fillTemplate('{{photoss}} photographs', { photos: 10 })).toBe('{{photoss}} photographs')
  })

  it('keeps a section when its count is non-zero', () => {
    expect(fillTemplate('a {{#located}}{{located}} located{{/located}} b', { located: 42 })).toBe(
      'a 42 located b',
    )
  })

  it('drops a section when its count is zero', () => {
    // "0 of them carry a location" is a sentence that shouldn't be published.
    expect(fillTemplate('a {{#located}}{{located}} located{{/located}} b', { located: 0 })).toBe(
      'a  b',
    )
  })

  it('leaves a section alone when the key is unknown entirely', () => {
    // Same reasoning as the placeholder above: a typo in the section name should
    // surface, not silently delete the paragraph it wraps.
    const body = '{{#locatedd}}text{{/locatedd}}'
    expect(fillTemplate(body, { located: 5 })).toBe(body)
  })

  it('takes the placeholders inside a dropped section with it', () => {
    expect(fillTemplate('{{#located}}{{located}} of {{photos}}{{/located}}!', {
      located: 0,
      photos: 100,
    })).toBe('!')
  })
})
