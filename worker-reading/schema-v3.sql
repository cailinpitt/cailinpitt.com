-- Migration: gate the wholesale `books` rebuild on a fingerprint, and drop a
-- redundant index. Apply to the remote database *before* deploying the Worker
-- that expects `stats.library_hash` — an ingest tick that reads a missing
-- column fails the whole sync.
--
--   cd worker-reading
--   npx wrangler d1 execute cailinpitt-reading --remote --file=schema-v3.sql
--
-- SQLite has no "ADD COLUMN IF NOT EXISTS", so re-running this errors on the
-- second pass. That is harmless — the column is already there.

ALTER TABLE stats ADD COLUMN library_hash TEXT;

-- idx_books_read_seq (status_id, finished_at DESC, …) already covers every
-- status_id lookup, so this one only ever cost extra row-writes on the rebuild.
DROP INDEX IF EXISTS idx_books_status;
