// Saved links: bare "interesting page" saves, kept apart from `articles` (things
// I actually read). Same ingest path — POST /ingest with `{"kind":"link"}` — and
// the same url canonicalization and idempotency, but no image mirror: /links is
// a compact favicon list, so a link never costs an R2 subrequest.

import {
  canonicalizeUrl,
  cleanNote,
  ID_LENGTH,
  type ArticleInput,
  type IngestResult,
} from './articles'
import { sha256Hex } from './hash'
import { fetchMetadata } from './metadata'
import { moveRow } from './saved'

/**
 * Store one link. Idempotent on the canonical url, exactly like ingestArticle:
 * re-saving keeps the original date and only ever writes a fresh note.
 */
export async function ingestLink(env: Env, input: ArticleInput): Promise<IngestResult | null> {
  const url = canonicalizeUrl(input.url)
  if (!url) return null

  const id = await sha256Hex(url, ID_LENGTH)

  const existing = await env.DB.prepare('SELECT id FROM links WHERE id = ?1').bind(id).first()
  if (existing) {
    const note = cleanNote(input.note)
    if (note) {
      await env.DB.prepare('UPDATE links SET note = ?2 WHERE id = ?1').bind(id, note).run()
      return { id, url, stored: false, noted: true }
    }
    return { id, url, stored: false }
  }

  // Already saved as an article? Moving it here is the whole point of the split.
  if ((await env.DB.prepare('SELECT id FROM articles WHERE id = ?1').bind(id).first())) {
    await moveRow(env, id, 'link')
    const note = cleanNote(input.note)
    if (note) await env.DB.prepare('UPDATE links SET note = ?2 WHERE id = ?1').bind(id, note).run()
    return { id, url, stored: true, moved: true, noted: note ? true : undefined }
  }

  const meta = await fetchMetadata(url)
  const now = Math.floor(Date.now() / 1000)

  // No mirrorImage(), unlike ingestArticle — the /links card has no art.
  // enriched_at null when no title was found; the hourly cron retries (enrich.ts).
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO links
         (id, url, title, site, excerpt, note, saved_at, enriched_at, attempts, last_attempt_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, ?9)`,
    ).bind(
      id,
      url,
      meta.title,
      meta.site,
      meta.excerpt,
      cleanNote(input.note),
      input.readAt ?? now,
      meta.title ? now : null,
      now,
    ),
    env.DB.prepare('UPDATE stats SET links = links + 1 WHERE id = 1'),
  ])

  return { id, url, stored: true }
}

/** Set or extend a link's note. Copy of annotateArticle, on the `links` table. */
export async function annotateLink(
  env: Env,
  id: string,
  note: string | null,
  append = false,
): Promise<{ id: string; note: string | null } | null> {
  const text = cleanNote(note)

  const statement =
    append && text
      ? env.DB.prepare(
          `UPDATE links
           SET note = CASE WHEN note IS NULL OR note = '' THEN ?2 ELSE note || ' ' || ?2 END
           WHERE id = ?1`,
        ).bind(id, text)
      : env.DB.prepare('UPDATE links SET note = ?2 WHERE id = ?1').bind(id, text)

  const { meta } = await statement.run()
  if (!meta.changes) return null

  const row = await env.DB.prepare('SELECT note FROM links WHERE id = ?1')
    .bind(id)
    .first<{ note: string | null }>()
  return { id, note: row?.note ?? null }
}

/** Remove a link. Count is recomputed, not decremented — deletes are rare and manual. */
export async function deleteLink(env: Env, id: string): Promise<boolean> {
  const [removed] = await env.DB.batch([
    env.DB.prepare('DELETE FROM links WHERE id = ?1').bind(id),
    env.DB.prepare('UPDATE stats SET links = (SELECT COUNT(*) FROM links) WHERE id = 1'),
  ])
  return Boolean(removed.meta.changes)
}
