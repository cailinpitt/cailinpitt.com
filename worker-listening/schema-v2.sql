-- Layer 1: incremental summary tables.
--
-- These hold one row per artist/album/track/day instead of one per play, and are
-- maintained by the ingest tick. They exist so that "when did I first hear this"
-- and "how many days in a row" stop being full-archive scans: 4.3k/8.9k/18.1k/2k
-- rows against 101k scrobbles, and every discovery question becomes an index
-- range over first_uts.

CREATE TABLE IF NOT EXISTS artists (
  artist    TEXT PRIMARY KEY,
  first_uts INTEGER NOT NULL,
  last_uts  INTEGER NOT NULL,
  plays     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS albums (
  album     TEXT NOT NULL,
  artist    TEXT NOT NULL,
  first_uts INTEGER NOT NULL,
  last_uts  INTEGER NOT NULL,
  plays     INTEGER NOT NULL,
  PRIMARY KEY (album, artist)
);

CREATE TABLE IF NOT EXISTS tracks (
  track     TEXT NOT NULL,
  artist    TEXT NOT NULL,
  first_uts INTEGER NOT NULL,
  last_uts  INTEGER NOT NULL,
  plays     INTEGER NOT NULL,
  PRIMARY KEY (track, artist)
);

-- One row per local calendar day with at least one play. Streaks, silent days
-- and any arbitrary daily series read ~365 rows here instead of ~18,700 raw.
CREATE TABLE IF NOT EXISTS days (
  day   TEXT PRIMARY KEY,   -- YYYY-MM-DD, local
  plays INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_artists_first ON artists (first_uts);
CREATE INDEX IF NOT EXISTS idx_albums_first  ON albums  (first_uts);
CREATE INDEX IF NOT EXISTS idx_tracks_first  ON tracks  (first_uts);
CREATE INDEX IF NOT EXISTS idx_artists_plays ON artists (plays DESC);
