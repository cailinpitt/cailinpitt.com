import { describe, expect, it } from 'vitest'
import { LIMITS, validate } from '../worker-guestbook/src/validate'

// Decides what a stranger may store; lives in worker-guestbook/ which has no test setup of its own.

const ok = (over: Record<string, unknown> = {}) => ({ name: 'Ada', message: 'Hello!', ...over })

describe('validate', () => {
  it('accepts an ordinary entry', () => {
    const result = validate(ok({ location: 'Chicago, IL' }))
    expect(result).toEqual({
      ok: true,
      value: { name: 'Ada', message: 'Hello!', website: null, location: 'Chicago, IL' },
    })
  })

  it('requires a name and a message', () => {
    expect(validate({ message: 'Hi' })).toMatchObject({ ok: false, field: 'name' })
    expect(validate({ name: 'Ada' })).toMatchObject({ ok: false, field: 'message' })
    // Whitespace is not a name.
    expect(validate(ok({ name: '   ' }))).toMatchObject({ ok: false, field: 'name' })
  })

  it('survives a payload that is not an object at all', () => {
    expect(validate(null)).toMatchObject({ ok: false, field: 'name' })
    expect(validate('nope')).toMatchObject({ ok: false, field: 'name' })
    expect(validate(ok({ name: 42 }))).toMatchObject({ ok: false, field: 'name' })
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

  it('strips invisible characters but keeps newlines in a message', () => {
    const result = validate(ok({ name: 'A​da', message: 'One\n\nTwo‮' }))
    expect(result).toMatchObject({ ok: true, value: { name: 'Ada', message: 'One\n\nTwo' } })
  })

  it('collapses a run of blank lines, so one entry cannot push out the rest', () => {
    const result = validate(ok({ message: 'One\n\n\n\n\n\nTwo' }))
    expect(result).toMatchObject({ ok: true, value: { message: 'One\n\nTwo' } })
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
    for (const website of [
      'javascript:alert(1)',
      'data:text/html,<script>',
      'https://paypal.com@evil.example',
      'https://localhost',
      'https://example.',
    ]) {
      expect(validate(ok({ website })), website).toMatchObject({ ok: false, field: 'website' })
    }
  })

  it('treats an empty website and location as absent', () => {
    expect(validate(ok({ website: '  ', location: '  ' }))).toMatchObject({
      ok: true,
      value: { website: null, location: null },
    })
  })
})
