-- Tier D: artist origin and era, from MusicBrainz.
--
-- Columns on artist_meta rather than a new table: it is already one row per
-- artist and already the thing the genre lookup reads. `mb_fetched_at` is
-- separate from `fetched_at` so the MusicBrainz queue advances independently of
-- the Last.fm tag queue — they run at very different rates (MusicBrainz caps at
-- one request per second).
--
-- SQLite has no "ADD COLUMN IF NOT EXISTS", so re-running this errors on the
-- second pass. That is harmless: the columns are already there.

ALTER TABLE artist_meta ADD COLUMN mbid TEXT;
ALTER TABLE artist_meta ADD COLUMN country TEXT;          -- ISO 3166-1 alpha-2
ALTER TABLE artist_meta ADD COLUMN kind TEXT;             -- 'Group' | 'Person' | other
ALTER TABLE artist_meta ADD COLUMN formed_year INTEGER;
ALTER TABLE artist_meta ADD COLUMN mb_fetched_at INTEGER;
-- 1 when MusicBrainz genuinely had no match, so it isn't retried forever.
ALTER TABLE artist_meta ADD COLUMN mb_missing INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_artist_meta_mb ON artist_meta (mb_fetched_at);
