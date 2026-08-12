// RSS for the notes feed.
//
// ## Why this is here rather than in scripts/generate-rss.mjs
//
// The site's own feed is written at build time by lifting the prerendered HTML
// of each post. Notes have no prerendered HTML — they live in D1 and reach the
// page over fetch — so a build-time generator would have nothing to read, and
// wiring one up would mean the feed only refreshed when something unrelated
// happened to trigger a deploy. Serving it from the Worker means a note is in
// the feed the moment it is published, which is the whole point of publishing
// from a phone.
//
// It is a *separate* feed from /feed.xml on purpose: someone who subscribed for
// essays did not sign up for every passing thought, and the reverse is just as
// true.

import type { Note, NotePage } from './store'

/** Items in the feed. Enough to be a feed, not enough to be the archive. */
export const FEED_ITEMS = 50

/**
 * XML text escaping. This is the one place a note's text lands somewhere that
 * parses markup, so it is the one place escaping matters — the site renders
 * notes as React text nodes and the curl view writes plain bytes.
 */
export const xml = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')

const rfc822 = (uts: number): string => new Date(uts * 1000).toUTCString()

/**
 * A note's title, since RSS wants one and a note has none.
 *
 * The first line, clipped — which for most notes is the whole note. Readers that
 * show a title list get something meaningful, and readers that show the body get
 * the note itself either way.
 */
export function title(text: string): string {
  const firstLine = text.split('\n').find((line) => line.trim()) ?? text
  const clean = firstLine.trim()
  return clean.length <= 80 ? clean : `${clean.slice(0, 79)}…`
}

/**
 * A note as HTML for the feed body: paragraphs on blank lines, `<br>` on single
 * ones, and nothing else. Escaped first, so the text cannot contribute markup —
 * the tags here are the only ones in the output.
 */
function body(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((para) => `<p>${xml(para).replace(/\n/g, '<br />')}</p>`)
    .join('')
}

/**
 * @param site    The site's origin, e.g. `https://cailinpitt.com` — what the
 *                links point at, since the feed describes pages on the site.
 * @param feedUrl This document's own address on the Worker, for `atom:link`.
 */
export function renderFeed(page: NotePage, site: string, feedUrl: string): string {
  const notes = page.notes.slice(0, FEED_ITEMS)
  const self = `${site}/notes`

  const items = notes
    .map((note: Note) => {
      // Every note's link is its own permalink, served by this Worker at
      // cailinpitt.com/notes/<id> — see the permalink route in index.ts.
      const link = `${site}/notes/${note.id}`
      return [
        '    <item>',
        `      <title>${xml(title(note.text))}</title>`,
        `      <link>${xml(link)}</link>`,
        `      <guid isPermaLink="false">cailinpitt-note-${note.id}</guid>`,
        `      <pubDate>${rfc822(note.createdAt)}</pubDate>`,
        `      <description>${xml(body(note.text))}</description>`,
        '    </item>',
      ].join('\n')
    })
    .join('\n')

  // lastBuildDate is the newest note's date, not the time this was rendered —
  // the response is regenerated on every cache miss, and a moving timestamp
  // would keep telling readers there is something new. Same rule as
  // scripts/generate-rss.mjs.
  const newest = notes[0]?.createdAt

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    '  <channel>',
    '    <title>Cailin Pitt — Notes</title>',
    `    <link>${self}</link>`,
    '    <description>Short thoughts, posted as they happen.</description>',
    '    <language>en-us</language>',
    `    <atom:link href="${xml(feedUrl)}" rel="self" type="application/rss+xml" />`,
    ...(newest ? [`    <lastBuildDate>${rfc822(newest)}</lastBuildDate>`] : []),
    items,
    '  </channel>',
    '</rss>',
    '',
  ].join('\n')
}
