// Article storage: canonicalize a url, enrich it with the page's social card,
// and add/annotate/remove the row. Reached from POST|PATCH|DELETE /ingest.
//
// Everything is keyed by a hash of the *canonical* url, so saving the same
// link twice is a no-op and you can annotate/remove by url alone, no id needed.

import { sha256Hex } from './hash'
import { mirrorImage } from './images'
import { fetchMetadata } from './metadata'

/** Article id length, in hex chars. Collisions at this width aren't a concern. */
const ID_LENGTH = 16

/** Cap on a note, so a stray paste can't become the whole card. */
const MAX_NOTE = 1000

/**
 * Query parameters that carry no meaning for the page itself. Stripping them
 * means the same article shared from two places dedupes to one row.
 *
 * Deliberately *not* included: `s` (WordPress search), `q`, `id`, `p` — those
 * change which page you land on.
 */
const TRACKING_PARAM =
  /^(utm_[a-z_]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|ref|ref_src|referrer|source|cmpid|ncid|spm|si|at_medium|at_campaign|__twitter_impression|_hsenc|_hsmi|vero_id|oly_enc_id|oly_anon_id)$/i

export interface ArticleInput {
  url: string
  note?: string | null
  /** Unix seconds. Defaults to now. */
  readAt?: number
}

export interface IngestResult {
  id: string
  url: string
  /** False when the article was already logged — the original date is kept. */
  stored: boolean
  /** True when a note was written, whether the article was new or not. */
  noted?: boolean
}

/**
 * Normalize a url so the same article always hashes to the same id: drop the
 * fragment and tracking parameters, sort what's left (share links vary the
 * order), and drop a trailing slash.
 */
export function canonicalizeUrl(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (!url.hostname.includes('.')) return null

  url.hash = ''
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAM.test(key)) url.searchParams.delete(key)
  }
  url.searchParams.sort()
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.replace(/\/+$/, '')
  }
  return url.toString()
}

/**
 * Resolve whatever the caller identified an article by. A url is canonicalized
 * and hashed; a raw id is taken as-is, for deleting something straight off the
 * D1 listing when you don't have the url to hand.
 */
export async function resolveId(input: {
  url?: string | null
  id?: string | null
}): Promise<string | null> {
  if (input.id) return input.id
  if (!input.url) return null
  const url = canonicalizeUrl(input.url)
  return url ? sha256Hex(url, ID_LENGTH) : null
}

const cleanNote = (note: string | null | undefined): string | null => {
  const text = note?.replace(/\s+/g, ' ').trim()
  if (!text) return null
  return text.length <= MAX_NOTE ? text : `${text.slice(0, MAX_NOTE - 1).trimEnd()}…`
}

/**
 * Store one article. Idempotent: the id is a hash of the canonical url, so
 * saving a link twice keeps the date it was *first* read rather than bumping it.
 */
export async function ingestArticle(env: Env, input: ArticleInput): Promise<IngestResult | null> {
  const url = canonicalizeUrl(input.url)
  if (!url) return null

  const id = await sha256Hex(url, ID_LENGTH)

  // Check before enriching: a duplicate shouldn't cost a page fetch and an
  // image mirror, and on the free plan subrequests are the scarce resource.
  const existing = await env.DB.prepare('SELECT id FROM articles WHERE id = ?1').bind(id).first()
  if (existing) {
    // Re-saving is a no-op except for the note — a deliberately typed note
    // shouldn't be dropped just because the link was already logged.
    const note = cleanNote(input.note)
    if (note) {
      await env.DB.prepare('UPDATE articles SET note = ?2 WHERE id = ?1').bind(id, note).run()
      return { id, url, stored: false, noted: true }
    }
    return { id, url, stored: false }
  }

  const meta = await fetchMetadata(url)
  const image = await mirrorImage(env, meta.image)

  // Increment rather than COUNT(*), which would grow with the archive; the
  // daily sync reconciles any drift.
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO articles (id, url, title, site, excerpt, image, note, read_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    ).bind(
      id,
      url,
      meta.title,
      meta.site,
      meta.excerpt,
      image,
      cleanNote(input.note),
      input.readAt ?? Math.floor(Date.now() / 1000),
    ),
    env.DB.prepare('UPDATE stats SET articles = articles + 1 WHERE id = 1'),
  ])

  return { id, url, stored: true }
}

/**
 * Set or extend an article's note after the fact — the "I saved this on my phone
 * and want to say why later" case. `append` adds to whatever is there rather
 * than replacing it, so a second thought doesn't wipe the first.
 */
export async function annotateArticle(
  env: Env,
  id: string,
  note: string | null,
  append = false,
): Promise<{ id: string; note: string | null } | null> {
  const text = cleanNote(note)

  // A null note with append:false is how you clear one.
  const statement =
    append && text
      ? env.DB.prepare(
          `UPDATE articles
           SET note = CASE WHEN note IS NULL OR note = '' THEN ?2 ELSE note || ' ' || ?2 END
           WHERE id = ?1`,
        ).bind(id, text)
      : env.DB.prepare('UPDATE articles SET note = ?2 WHERE id = ?1').bind(id, text)

  const { meta } = await statement.run()
  if (!meta.changes) return null

  const row = await env.DB.prepare('SELECT note FROM articles WHERE id = ?1')
    .bind(id)
    .first<{ note: string | null }>()
  return { id, note: row?.note ?? null }
}

// Count is recomputed (not decremented) since deletes are rare and manual, so
// a COUNT(*) here is cheap and self-correcting. The mirrored R2 image is left
// in place — content-addressed keys mean re-saving reuses it, and deleting
// risks orphaning an image another row still points at.
export async function deleteArticle(env: Env, id: string): Promise<boolean> {
  const [removed] = await env.DB.batch([
    env.DB.prepare('DELETE FROM articles WHERE id = ?1').bind(id),
    env.DB.prepare('UPDATE stats SET articles = (SELECT COUNT(*) FROM articles) WHERE id = 1'),
  ])
  return Boolean(removed.meta.changes)
}
