-- Migration: reading time, link-rot checks, and a `host` column for site
-- filtering and the top-sites stat. Apply before deploying the Worker that
-- reads these columns.
--
--   npx wrangler d1 execute cailinpitt-reading --remote --file=schema-v7.sql
--
-- Re-running errors on the ALTERs (no ADD COLUMN IF NOT EXISTS); harmless.

-- Prose words on the page, counted from <p> text at ingest (src/metadata.ts).
-- Existing rows are filled in by the rot check as it works through the archive.
ALTER TABLE articles ADD COLUMN words INTEGER;

-- Link-rot bookkeeping (src/rot.ts). `failures` counts consecutive checks that
-- came back 404/410/unreachable; DEAD_AFTER of them marks the row dead, and
-- archive_url is the Wayback snapshot shown in its place.
ALTER TABLE articles ADD COLUMN checked_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE articles ADD COLUMN failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE articles ADD COLUMN archive_url TEXT;
ALTER TABLE links ADD COLUMN checked_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE links ADD COLUMN failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE links ADD COLUMN archive_url TEXT;

-- Hostname minus a leading "www.", derived from the canonical url (which always
-- has a "/" after the host). VIRTUAL, so ingest and moveRow() never write it.
ALTER TABLE articles ADD COLUMN host TEXT GENERATED ALWAYS AS (
  CASE WHEN substr(url, instr(url, '://') + 3, 4) = 'www.'
    THEN substr(url, instr(url, '://') + 7, instr(substr(url, instr(url, '://') + 3), '/') - 5)
    ELSE substr(url, instr(url, '://') + 3, instr(substr(url, instr(url, '://') + 3), '/') - 1)
  END
) VIRTUAL;
ALTER TABLE links ADD COLUMN host TEXT GENERATED ALWAYS AS (
  CASE WHEN substr(url, instr(url, '://') + 3, 4) = 'www.'
    THEN substr(url, instr(url, '://') + 7, instr(substr(url, instr(url, '://') + 3), '/') - 5)
    ELSE substr(url, instr(url, '://') + 3, instr(substr(url, instr(url, '://') + 3), '/') - 1)
  END
) VIRTUAL;

-- Serves `WHERE host = ?` paged in the usual order, and the GROUP BY host in
-- the stats endpoint.
CREATE INDEX IF NOT EXISTS idx_articles_host ON articles (host, read_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_links_host ON links (host, saved_at DESC, id DESC);

-- The rot check walks rows oldest-checked first.
CREATE INDEX IF NOT EXISTS idx_articles_checked ON articles (checked_at);
CREATE INDEX IF NOT EXISTS idx_links_checked ON links (checked_at);
