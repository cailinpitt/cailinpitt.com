-- Migration: re-enrichment bookkeeping on `articles`. Apply before deploying —
-- the ingest and reenrichArticles() (src/enrich.ts) read these columns.
--
--   npx wrangler d1 execute cailinpitt-reading --remote --file=schema-v4.sql
--
-- Re-running errors on the second pass (no ADD COLUMN IF NOT EXISTS); harmless.

ALTER TABLE articles ADD COLUMN enriched_at INTEGER;
ALTER TABLE articles ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE articles ADD COLUMN last_attempt_at INTEGER NOT NULL DEFAULT 0;

-- Rows with a complete card: mark enriched so the cron skips them. The rest
-- keep attempts = 0 and the next several hourly runs work through the backlog.
UPDATE articles SET enriched_at = read_at, attempts = 1, last_attempt_at = read_at
WHERE title IS NOT NULL AND title <> ''
  AND excerpt IS NOT NULL AND excerpt <> ''
  AND image IS NOT NULL AND image <> '';

CREATE INDEX IF NOT EXISTS idx_articles_unenriched
  ON articles (attempts, last_attempt_at) WHERE enriched_at IS NULL;
