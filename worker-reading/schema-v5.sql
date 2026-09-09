-- Migration: retune idx_articles_unenriched. The v4 column order (attempts,
-- last_attempt_at) served the WHERE but left a temp b-tree for the
-- `ORDER BY attempts, read_at DESC` in reenrichArticles(). (attempts, read_at
-- DESC) serves both. The backoff on last_attempt_at is a post-filter either way.
--
--   npx wrangler d1 execute cailinpitt-reading --remote --file=schema-v5.sql

DROP INDEX IF EXISTS idx_articles_unenriched;
CREATE INDEX IF NOT EXISTS idx_articles_unenriched
  ON articles (attempts, read_at DESC) WHERE enriched_at IS NULL;
