// Moving a saved url between the two tables — `articles` (things I read, shown
// with card art) and `links` (bare interesting links, a compact favicon list).
// Both are keyed by the same hash of the canonical url, so a move is a straight
// row copy with the timestamp column renamed (read_at ⇄ saved_at).
//
// Raw SQL only, no imports from articles.ts / links.ts, so those two can both
// import this without a cycle.

export type Kind = 'article' | 'link'

export interface MoveResult {
  id: string
  url?: string
  kind: Kind
  /** False when the row was already in the target table (nothing to do). */
  moved: boolean
}

interface Row {
  id: string
  url: string
  title: string | null
  site: string | null
  excerpt: string | null
  note: string | null
  ts: number
  enriched_at: number | null
  attempts: number
  last_attempt_at: number
}

/** Which table holds this id, or null if neither does. */
export async function findKind(env: Env, id: string): Promise<Kind | null> {
  const [asArticle, asLink] = await env.DB.batch([
    env.DB.prepare('SELECT 1 FROM articles WHERE id = ?1').bind(id),
    env.DB.prepare('SELECT 1 FROM links WHERE id = ?1').bind(id),
  ])
  if ((asArticle.results ?? []).length) return 'article'
  if ((asLink.results ?? []).length) return 'link'
  return null
}

/**
 * Move the row for `id` into the `to` table. Idempotent: returns
 * `{ moved: false }` if it's already there, null if the id is in neither table.
 * Counters are nudged by one and the daily reconcile in syncBooks() corrects any
 * drift.
 */
export async function moveRow(env: Env, id: string, to: Kind): Promise<MoveResult | null> {
  const from: Kind = to === 'link' ? 'article' : 'link'
  const tsCol = from === 'article' ? 'read_at' : 'saved_at'

  const src = await env.DB.prepare(
    `SELECT id, url, title, site, excerpt, note, ${tsCol} AS ts, enriched_at, attempts, last_attempt_at
     FROM ${from === 'article' ? 'articles' : 'links'} WHERE id = ?1`,
  )
    .bind(id)
    .first<Row>()

  if (!src) {
    const already = await findKind(env, id)
    return already === to ? { id, kind: to, moved: false } : null
  }

  const insert =
    to === 'link'
      ? env.DB.prepare(
          `INSERT OR IGNORE INTO links
             (id, url, title, site, excerpt, note, saved_at, enriched_at, attempts, last_attempt_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
        )
      : // image is null: a link never had card art. The enrich cron won't refetch
        // it (enriched_at carries over), which is fine — re-saving it as an
        // article is the way to get a card image.
        env.DB.prepare(
          `INSERT OR IGNORE INTO articles
             (id, url, title, site, excerpt, image, note, read_at, enriched_at, attempts, last_attempt_at)
           VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?7, ?8, ?9, ?10)`,
        )

  await env.DB.batch([
    insert.bind(
      src.id,
      src.url,
      src.title,
      src.site,
      src.excerpt,
      src.note,
      src.ts,
      src.enriched_at,
      src.attempts,
      src.last_attempt_at,
    ),
    env.DB.prepare(`DELETE FROM ${from === 'article' ? 'articles' : 'links'} WHERE id = ?1`).bind(id),
    to === 'link'
      ? env.DB.prepare(
          'UPDATE stats SET articles = MAX(0, articles - 1), links = links + 1 WHERE id = 1',
        )
      : env.DB.prepare(
          'UPDATE stats SET links = MAX(0, links - 1), articles = articles + 1 WHERE id = 1',
        ),
  ])

  return { id, url: src.url, kind: to, moved: true }
}
