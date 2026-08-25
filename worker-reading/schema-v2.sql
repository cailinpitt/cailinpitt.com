-- Indexes for /timeline's single-day lookup (fetchBooksOnDate in src/store.ts).
-- idx_books_read_seq doesn't cover a bare finished_at/started_at equality (it
-- leads with status_id), so add both columns separately — SQLite's OR
-- optimization can then use each index for its half of the WHERE clause.
--
--   npx wrangler d1 execute cailinpitt-reading --remote --file=schema-v2.sql

CREATE INDEX IF NOT EXISTS idx_books_finished_at ON books (finished_at);
CREATE INDEX IF NOT EXISTS idx_books_started_at ON books (started_at);
