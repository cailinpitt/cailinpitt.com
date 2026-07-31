-- Book library, mirrored from hardcover.app.
--
-- One row per *read session* rather than per book, so a re-read shows up as its
-- own entry with its own dates. `read_id` is 0 for a user_book that has no read
-- rows at all (e.g. want-to-read), which keeps the primary key total.
--
-- This table is rebuilt wholesale on every sync (DELETE + batch insert in one
-- atomic D1 batch) because Hardcover is the source of truth and rows there can
-- be edited or deleted. At a few hundred books that is cheaper than diffing, and
-- it is also why there is no separate backfill script — the first cron run
-- imports the entire history.
CREATE TABLE IF NOT EXISTS books (
  user_book_id INTEGER NOT NULL,      -- hardcover user_books.id
  read_id      INTEGER NOT NULL,      -- user_book_reads.id; 0 when there is no read row
  book_id      INTEGER NOT NULL,
  title        TEXT    NOT NULL,
  authors      TEXT,                  -- comma-joined
  slug         TEXT,                  -- for the hardcover.app permalink
  cover        TEXT,                  -- /images/reading/… once mirrored to R2
  cover_source TEXT,                  -- the hardcover CDN url it was mirrored from
  pages        INTEGER,
  rating       REAL,                  -- out of 5, half-stars; null when unrated
  status_id    INTEGER NOT NULL,      -- 1 want, 2 reading, 3 read, 4 paused, 5 dnf
  started_at   TEXT,                  -- YYYY-MM-DD (hardcover stores dates, not times)
  finished_at  TEXT,
  PRIMARY KEY (user_book_id, read_id)
);

-- Matches the paged read in fetchFinishedBooks() exactly: the `status_id = 3`
-- equality first, then the three ordering columns in the same direction the
-- query asks for. That lets one index serve both the filter and the ORDER BY.
--
-- Leading with the date instead does NOT work: `status_id = 3` is an equality
-- match, so the planner prefers a status-only index and then sorts the result —
-- `EXPLAIN QUERY PLAN` shows `USE TEMP B-TREE FOR ORDER BY`, meaning every
-- finished book is read and sorted on every page request. Check the plan before
-- changing this; see the same lesson in worker/README.md.
CREATE INDEX IF NOT EXISTS idx_books_read_seq
  ON books (status_id, finished_at DESC, user_book_id DESC, read_id DESC);

-- Superseded by the above; kept as an explicit drop so existing databases
-- converge on re-running this file.
DROP INDEX IF EXISTS idx_books_finished_seq;
DROP INDEX IF EXISTS idx_books_finished;

-- Serves the currently-reading query, which has no date ordering.
CREATE INDEX IF NOT EXISTS idx_books_status ON books (status_id);

-- Articles, ingested from mail sent to the secret address (see src/email.ts).
--
-- `id` is a hash of the *canonical* url, so re-sending the same link is a no-op:
-- INSERT OR IGNORE keeps the date it was first read rather than bumping it.
CREATE TABLE IF NOT EXISTS articles (
  id      TEXT    PRIMARY KEY,        -- sha-256 of the canonical url, first 16 hex chars
  url     TEXT    NOT NULL,           -- canonical url (tracking params stripped)
  title   TEXT,
  site    TEXT,                       -- og:site_name, else the hostname
  excerpt TEXT,                       -- og:description
  image   TEXT,                       -- /images/reading/<hash>.<ext>, mirrored to R2
  note    TEXT,                       -- whatever else was in the email body
  read_at INTEGER NOT NULL            -- unix seconds, from the email Date header
);

-- Both ordering columns, in the query's direction, so paging is an index seek.
-- A read_at-only index leaves `USE TEMP B-TREE FOR LAST TERM OF ORDER BY` and a
-- full `SCAN articles` — which is the one table here that grows without bound,
-- so that would get slower and more expensive every day. Check EXPLAIN QUERY
-- PLAN before changing this.
CREATE INDEX IF NOT EXISTS idx_articles_seq ON articles (read_at DESC, id DESC);
DROP INDEX IF EXISTS idx_articles_read_at;

-- Precomputed totals — a single row, read once per bundle.
--
-- These used to be COUNT(*)/SUM() subqueries in the bundle query, which read
-- every finished book and every article on *every* build. Since the bundle is
-- rebuilt per edge colo per TTL, that cost scales with traffic and with the
-- archive at the same time: ~750 D1 row reads per build today against a 5M/day
-- free-tier budget, and rising forever. The same mistake, and the same fix, as
-- the all-time total in the listening worker — see worker/README.md.
--
-- Written by syncBooks() (which already has every row in memory, so computing
-- them costs no reads at all) and incremented by the email ingest. The daily
-- sync also reconciles the article count, so a missed increment self-heals.
CREATE TABLE IF NOT EXISTS stats (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  books_read INTEGER NOT NULL DEFAULT 0,
  articles   INTEGER NOT NULL DEFAULT 0,
  -- {"2026": {"books": 36, "pages": 12043}, …}. Per-year rather than a single
  -- "this year" figure so the counter is correct the moment the year rolls over,
  -- instead of showing last year's total until the next sync.
  by_year    TEXT    NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO stats (id) VALUES (1);
