import { describe, expect, it } from 'vitest'
import { fillTemplate } from '../src/lib/colophon'

// Fill-in-the-blanks substitution behind content/colophon.md, not a template language.

describe('fillTemplate', () => {
  it('substitutes values, thousands-separating numbers', () => {
    expect(fillTemplate('{{photos}} photographs in {{galleries}} galleries', {
      photos: 1234,
      galleries: 9,
    })).toBe('1,234 photographs in 9 galleries')
  })

  it('leaves an unknown placeholder in the text rather than blanking it', () => {
    // A typo should be visible on preview, not silently delete a sentence.
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
    // Same reasoning as the placeholder above, but for section names.
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
