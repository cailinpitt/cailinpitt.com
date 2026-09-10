// Retry the social-card fetch for saved rows that came back without a title at
// ingest. Runs in parallel with syncBooks() on the hourly cron. enriched_at is
// the state: null until a fetch produces a title, then the row is left alone.
// No-title rows retry to MAX_ATTEMPTS with backoff.
//
// Covers both `articles` (has an `image` column, mirrored to R2) and `links`
// (no image). One pass over both, sharing a single BATCH and deadline, so the
// cron's ~50-subrequest budget doesn't grow with the second table.

import { mirrorImage } from './images'
import { fetchMetadata } from './metadata'

const MAX_ATTEMPTS = 5

/** Rows per pass, across both tables. ~6 subrequests each; the sync shares the ~50 budget. */
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

interface TableConfig {
  table: 'articles' | 'links'
  tsCol: 'read_at' | 'saved_at'
  hasImage: boolean
}

const TABLES: TableConfig[] = [
  // Links first: usually empty, and a cheap check keeps articles' backlog moving.
  { table: 'links', tsCol: 'saved_at', hasImage: false },
  { table: 'articles', tsCol: 'read_at', hasImage: true },
]

interface Pending {
  id: string
  url: string
  image: string | null
}

async function pendingFor(env: Env, cfg: TableConfig, now: number, limit: number): Promise<Pending[]> {
  if (limit <= 0) return []
  const cols = cfg.hasImage ? 'id, url, image' : 'id, url'
  const { results } = await env.DB.prepare(
    `SELECT ${cols} FROM ${cfg.table}
     WHERE enriched_at IS NULL AND attempts < ?1 AND ${READY_SQL}
     ORDER BY attempts ASC, ${cfg.tsCol} DESC
     LIMIT ?3`,
  )
    .bind(MAX_ATTEMPTS, now, limit)
    .all<{ id: string; url: string; image?: string | null }>()
  return (results ?? []).map((r) => ({ id: r.id, url: r.url, image: r.image ?? null }))
}

export async function reenrich(env: Env): Promise<EnrichResult> {
  const now = Math.floor(Date.now() / 1000)
  const started = Date.now()
  let considered = 0
  let updated = 0
  let titled = 0

  for (const cfg of TABLES) {
    const rows = await pendingFor(env, cfg, now, BATCH - considered)
    for (const row of rows) {
      if (Date.now() - started > DEADLINE_MS) return { considered, updated, titled }
      considered++

      const meta = await fetchMetadata(row.url)
      const gotTitle = Boolean(meta.title)
      if (gotTitle) titled++

      // Mirror only a newly-found image (articles only); take site only from a
      // fetch that reached the page (a fallback would clobber a real og:site_name).
      const image =
        cfg.hasImage && meta.image && !row.image ? await mirrorImage(env, meta.image) : null

      // Bind image (?5) only when the table has the column, so the parameter
      // count always matches the SQL.
      const stmt = cfg.hasImage
        ? env.DB.prepare(
            `UPDATE ${cfg.table} SET
               title = COALESCE(?2, title),
               site = COALESCE(?3, site),
               excerpt = COALESCE(?4, excerpt),
               image = COALESCE(?5, image),
               attempts = attempts + 1,
               last_attempt_at = ?6,
               enriched_at = CASE WHEN COALESCE(?2, title) IS NOT NULL THEN ?6 ELSE enriched_at END
             WHERE id = ?1`,
          ).bind(row.id, meta.title, gotTitle ? meta.site : null, meta.excerpt, image, now)
        : env.DB.prepare(
            `UPDATE ${cfg.table} SET
               title = COALESCE(?2, title),
               site = COALESCE(?3, site),
               excerpt = COALESCE(?4, excerpt),
               attempts = attempts + 1,
               last_attempt_at = ?5,
               enriched_at = CASE WHEN COALESCE(?2, title) IS NOT NULL THEN ?5 ELSE enriched_at END
             WHERE id = ?1`,
          ).bind(row.id, meta.title, gotTitle ? meta.site : null, meta.excerpt, now)

      const { meta: m } = await stmt.run()

      if (m.changes) updated++
    }
  }

  return { considered, updated, titled }
}
