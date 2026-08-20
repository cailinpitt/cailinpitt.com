// RSS for the notes feed. Not in scripts/generate-rss.mjs like the site's own
// feed, since that lifts prerendered HTML at build time and notes have none —
// they live in D1. Serving it from the Worker means a note is in the feed the
// moment it's published. Deliberately a separate feed from /feed.xml: someone
// who subscribed for essays didn't sign up for every passing thought.

import type { Note, NotePage } from './store'

/** Items in the feed. Enough to be a feed, not enough to be the archive. */
export const FEED_ITEMS = 50

// This is the one place a note's text lands somewhere that parses markup — the
// site renders notes as React text nodes and curl writes plain bytes.
export const xml = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')

const rfc822 = (uts: number): string => new Date(uts * 1000).toUTCString()

// RSS wants a title and a note has none — first line, clipped, which for most
// notes is the whole note.
export function title(text: string): string {
  const firstLine = text.split('\n').find((line) => line.trim()) ?? text
  const clean = firstLine.trim()
  return clean.length <= 80 ? clean : `${clean.slice(0, 79)}…`
}

// Paragraphs on blank lines, <br> on single ones. Escaped first, so the text
// can't contribute markup of its own.
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
      // Own permalink, served by this Worker — see index.ts's permalink route.
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

  // Newest note's date, not render time — this regenerates on every cache miss,
  // and a moving timestamp would keep telling readers there's something new.
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
