-- Films, mirrored from the Letterboxd diary RSS feed.
--
-- Unlike worker-reading, nothing here is a full replace. The feed is a
-- *window*, not a library — it carries only the last 50 diary entries — so a
-- DELETE + re-insert would throw away everything older than the window on every
-- run. Every write is an upsert, and the archive accumulates here.

-- One row per diary entry.
--
-- `id` is `<film slug>|<watched date>` rather than the feed's own guid, because
-- the guid is not stable: an entry logged without a review arrives as
-- `letterboxd-watch-N` and, if a review is added later, comes back as
-- `letterboxd-review-M`. Keying on the guid would file the same viewing twice.
-- The cost is that two viewings of one film on one day collapse into a single
-- row, which is a trade worth making.
CREATE TABLE IF NOT EXISTS films (
  id            TEXT    PRIMARY KEY,  -- <slug>|<watched_date>
  guid          TEXT,                 -- whatever the feed last called it
  title         TEXT    NOT NULL,
  year          INTEGER,
  slug          TEXT,                 -- letterboxd film slug; the page links to
                                      -- letterboxd.com/film/<slug>, the public
                                      -- page, never the diary entry under
                                      -- /<member>/
  watched_date  TEXT    NOT NULL,     -- YYYY-MM-DD, as logged (no timezone)
  rewatch       INTEGER NOT NULL DEFAULT 0,
  rating        REAL,                 -- out of 5, half stars; null when unrated
  liked         INTEGER NOT NULL DEFAULT 0,
  -- Review bodies are deliberately not stored. The feed carries them and the
  -- page shows ratings only, so there is nothing to keep.
  tmdb_id       INTEGER,
  poster        TEXT,                 -- /images/watching/… once mirrored to R2
  poster_source TEXT,                 -- the a.ltrbxd.com url it came from
  published_at  INTEGER               -- pubDate, unix seconds
);

-- Matches fetchFilms() exactly: both ordering columns, in the query's
-- direction, so paging is an index seek rather than a scan-and-sort of an
-- archive that only ever grows. Check EXPLAIN QUERY PLAN before changing it —
-- the same lesson as idx_articles_seq in worker-reading.
CREATE INDEX IF NOT EXISTS idx_films_seq ON films (watched_date DESC, id DESC);

-- Precomputed totals — a single row, read once per bundle.
--
-- Not COUNT(*) subqueries, for the reason spelled out on the same table in
-- worker-reading/schema.sql: the bundle is rebuilt per edge colo per TTL, so a
-- count that scans the archive gets more expensive with both traffic and time.
CREATE TABLE IF NOT EXISTS stats (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  films      INTEGER NOT NULL DEFAULT 0,
  rewatches  INTEGER NOT NULL DEFAULT 0,
  rated      INTEGER NOT NULL DEFAULT 0,  -- entries carrying a rating
  rating_sum REAL    NOT NULL DEFAULT 0,  -- their total, for the mean
  -- {"2026": {"films": 41, "rewatches": 6}, …}. Per-year rather than a single
  -- "this year" figure, so the tiles are correct the moment the year rolls over
  -- instead of showing last year's totals until the next sync runs.
  by_year    TEXT    NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO stats (id) VALUES (1);
