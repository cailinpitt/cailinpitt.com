import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseFrontmatter } from '../src/lib/frontmatter'

// Integrity of the posts actually on disk.
//
// Nothing here checks prose — it checks the handful of frontmatter facts the
// build trusts without verifying. Two posts sharing a `path` would silently
// prerender over each other; a `path` whose date disagrees with `date:` puts a
// post at a URL that contradicts itself; a mistyped tags array arrives as a
// string and renders as one long nonsense tag. All of that is invisible in a
// green build, and all of it is caught here in milliseconds with no images, no
// network, and no dist/ — which is what makes it safe to run in CI.

const BLOG = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'content', 'blog')

const posts = readdirSync(BLOG)
  .filter((file) => file.endsWith('.md'))
  .map((file) => ({ file, ...parseFrontmatter(readFileSync(path.join(BLOG, file), 'utf8')) }))

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** The y/m/d out of a post path, ignoring whether they're zero-padded. */
const pathDate = (postPath: string) => {
  const match = postPath.match(/^\/blog\/(\d{4})\/(\d{1,2})\/(\d{1,2})\//)
  return match ? match.slice(1, 4).map(Number) : null
}

it('finds the posts', () => {
  // A glob that quietly matched nothing would make every test below vacuous.
  expect(posts.length).toBeGreaterThan(0)
})

describe.each(posts)('$file', ({ file, data }) => {
  it('has the fields every listing reads', () => {
    expect(data.title, 'title').toBeTruthy()
    expect(data.slug, 'slug').toBeTruthy()
    expect(typeof data.path, 'path').toBe('string')
  })

  it('has a real ISO date', () => {
    const date = data.date as string
    expect(date).toMatch(ISO_DATE)
    expect(new Date(`${date}T00:00:00Z`).getTime()).not.toBeNaN()
  })

  it('is at a url that agrees with its date', () => {
    const parts = pathDate(data.path as string)
    expect(parts, `${data.path} is not /blog/<year>/<month>/<day>/<slug>`).not.toBeNull()
    const [y, m, d] = parts!
    expect([y, m, d]).toEqual((data.date as string).split('-').map(Number))
  })

  it('is at a url ending in its own slug', () => {
    expect((data.path as string).split('/').pop()).toBe(data.slug)
  })

  it('is named after its slug', () => {
    // toPost() falls back to the filename for a missing path or slug, so the two
    // agreeing is what keeps that fallback from landing somewhere surprising.
    expect(file.replace(/\.md$/, '')).toBe(data.slug)
  })

  it('has tags that parsed as a list', () => {
    // A bracket typo makes `tags` a string, and every character of it becomes a
    // tag page. Absent is fine; a string is not.
    if (data.tags !== undefined) expect(Array.isArray(data.tags)).toBe(true)
  })

  it('was not revised before it was written', () => {
    if (data.updated === undefined) return
    const updated = data.updated as string
    expect(updated).toMatch(ISO_DATE)
    expect(updated >= (data.date as string)).toBe(true)
  })
})

it('gives every post its own url', () => {
  const paths = posts.map((post) => post.data.path as string)
  expect(new Set(paths).size, 'two posts share a path and would overwrite each other').toBe(
    paths.length,
  )
})
