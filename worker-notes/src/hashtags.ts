// Hashtag extraction, mirrored by hand from segments()'s HASHTAG_RE in
// src/lib/notes.ts — see that file's header comment for why the two sides
// aren't a shared package. Used only by listNotesByTag() in store.ts, to
// re-check a D1 LIKE prefilter's results against the same rule the site's
// own renderer uses, so "notes tagged #run" can't disagree with "hashtags
// that render as links."

/** Same shape as the client's URL_RE, just enough to blank out URLs before scanning for tags. */
const URL_RE = /(https?:\/\/[^\s<>]+|www\.[^\s<>]+)/gi

/** Same shape as the client's: must start right after a non-word/non-`#' boundary. */
const HASHTAG_RE = /(?<![\w#])#(\w[\w-]{0,49})/g

/**
 * Every hashtag in `text`, lowercased, deduplicated. URLs are blanked out
 * first — a `#fragment` in a link is part of the link, not a hashtag, same
 * as segments() on the client never turns one into a tag link.
 */
export function hashtagsIn(text: string): Set<string> {
  const withoutUrls = text.replace(URL_RE, (url) => ' '.repeat(url.length))
  const out = new Set<string>()
  for (const match of withoutUrls.matchAll(HASHTAG_RE)) out.add(match[1].toLowerCase())
  return out
}
