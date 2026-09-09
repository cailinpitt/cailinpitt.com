// Retry the social-card fetch for articles that came back without a title at
// ingest. Runs in parallel with syncBooks() on the hourly cron. enriched_at is
// the state: null until a fetch produces a title, then the row is left alone.
// No-title rows retry to MAX_ATTEMPTS with backoff.

import { mirrorImage } from './images'
import { fetchMetadata } from './metadata'

const MAX_ATTEMPTS = 5

/** Rows per pass. ~6 subrequests each; the sync shares the same ~50 budget. */
const BATCH = 6

/** Stop starting rows past this, so slow origins can't stall the invocation. */
const DEADLINE_MS = 25_000

export interface EnrichResult {
  considered: number
  updated: number
  titled: number
}

/** Backoff (s) before the next try, keyed by attempts already made. */
const READY_SQL = `?2 - last_attempt_at >= CASE attempts
  WHEN 0 THEN 0
  WHEN 1 THEN 3600
  WHEN 2 THEN 21600
  WHEN 3 THEN 86400
  ELSE 259200 END`

export async function reenrichArticles(env: Env): Promise<EnrichResult> {
  const now = Math.floor(Date.now() / 1000)
  const { results } = await env.DB.prepare(
    `SELECT id, url, image FROM articles
     WHERE enriched_at IS NULL AND attempts < ?1 AND ${READY_SQL}
     ORDER BY attempts ASC, read_at DESC
     LIMIT ?3`,
  )
    .bind(MAX_ATTEMPTS, now, BATCH)
    .all<{ id: string; url: string; image: string | null }>()

  const pending = results ?? []
  const started = Date.now()
  let considered = 0
  let updated = 0
  let titled = 0

  for (const row of pending) {
    if (Date.now() - started > DEADLINE_MS) break
    considered++

    const meta = await fetchMetadata(row.url)
    const gotTitle = Boolean(meta.title)
    if (gotTitle) titled++

    // Mirror only a newly-found image; take site only from a fetch that reached
    // the page (a fallback would clobber a real og:site_name with the hostname).
    const image = meta.image && !row.image ? await mirrorImage(env, meta.image) : null

    const { meta: m } = await env.DB.prepare(
      `UPDATE articles SET
         title = COALESCE(?2, title),
         site = COALESCE(?3, site),
         excerpt = COALESCE(?4, excerpt),
         image = COALESCE(?5, image),
         attempts = attempts + 1,
         last_attempt_at = ?6,
         enriched_at = CASE WHEN COALESCE(?2, title) IS NOT NULL THEN ?6 ELSE enriched_at END
       WHERE id = ?1`,
    )
      .bind(row.id, meta.title, gotTitle ? meta.site : null, meta.excerpt, image, now)
      .run()

    if (m.changes) updated++
  }

  return { considered, updated, titled }
}
