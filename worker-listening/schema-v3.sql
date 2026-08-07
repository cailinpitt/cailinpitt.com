-- Layer 2: enrichment tables for genres (Tier B) and durations (Tier C).
--
-- Filled by scripts/enrich-listening.mjs one time, then kept current by the cron
-- a few entities per tick. Nothing here is on the request path.
--
-- Raw tags are stored, NOT canonical genres. The taxonomy in src/genres.ts is
-- taste and will be revised; normalizing at write time would mean re-fetching
-- 4,340 artists after every edit to it. Normalizing at aggregation time means a
-- map change is just a version bump and a rebuild.

CREATE TABLE IF NOT EXISTS artist_meta (
  artist     TEXT PRIMARY KEY,
  -- JSON array of {name, count}, straight from artist.getTopTags.
  tags       TEXT,
  listeners  INTEGER,
  fetched_at INTEGER NOT NULL,
  -- Set when a lookup legitimately found nothing, so it isn't retried forever.
  missing    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS album_meta (
  album      TEXT NOT NULL,
  artist     TEXT NOT NULL,
  tags       TEXT,
  fetched_at INTEGER NOT NULL,
  missing    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (album, artist)
);

-- Durations come from album.getInfo, which returns every track on the record in
-- one call: 8,854 album lookups cover all 18,114 tracks.
CREATE TABLE IF NOT EXISTS track_meta (
  track      TEXT NOT NULL,
  artist     TEXT NOT NULL,
  duration   INTEGER,          -- seconds; NULL when Last.fm doesn't know
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (track, artist)
);

-- The enrichment queue is "rows in `artists`/`albums` with no meta row yet",
-- so these support the anti-join the cron runs each tick.
CREATE INDEX IF NOT EXISTS idx_artist_meta_fetched ON artist_meta (fetched_at);
CREATE INDEX IF NOT EXISTS idx_album_meta_fetched  ON album_meta  (fetched_at);
