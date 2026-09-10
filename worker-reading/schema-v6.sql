-- Migration: split saved links out of `articles` into their own `links` table.
-- Apply to the remote database *before* deploying the Worker that reads `links`
-- and `stats.links` — an ingest tick or a bundle build that hits a missing
-- table/column fails.
--
--   cd worker-reading
--   npx wrangler d1 execute cailinpitt-reading --remote --file=schema-v6.sql
--
-- Re-running is safe: the table/index creates are IF NOT EXISTS, and the
-- ALTER TABLE errors on the second pass (no ADD COLUMN IF NOT EXISTS) — harmless,
-- the column is already there.
--
-- No `image` column, unlike `articles`: /links renders a compact favicon list
-- with no card art, so links never mirror an image to R2. Re-adding it later is
-- one more migration.

CREATE TABLE IF NOT EXISTS links (
  id       TEXT    PRIMARY KEY,        -- sha-256 of the canonical url, first 16 hex chars
  url      TEXT    NOT NULL,           -- canonical url (tracking params stripped)
  title    TEXT,
  site     TEXT,                       -- og:site_name, else the hostname
  excerpt  TEXT,                       -- og:description; kept for the terminal view
  note     TEXT,                       -- why I saved it
  saved_at INTEGER NOT NULL,           -- unix seconds
  -- Re-enrichment (src/enrich.ts): enriched_at null until a fetch found a title.
  enriched_at     INTEGER,
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_attempt_at INTEGER NOT NULL DEFAULT 0
);

-- Both ordering columns in the query's direction, so paging is an index seek —
-- same reasoning as idx_articles_seq.
CREATE INDEX IF NOT EXISTS idx_links_seq ON links (saved_at DESC, id DESC);

-- Partial, holding only rows reenrich() can return; column order serves its
-- `attempts <` filter and `ORDER BY attempts, saved_at DESC` with no temp b-tree.
CREATE INDEX IF NOT EXISTS idx_links_unenriched
  ON links (attempts, saved_at DESC) WHERE enriched_at IS NULL;

-- Precomputed count, mirroring stats.articles. Incremented on ingest and
-- reconciled by syncBooks() (src/sync.ts) on every rebuild and at least daily.
ALTER TABLE stats ADD COLUMN links INTEGER NOT NULL DEFAULT 0;
