-- Scrobble archive. One row per play. The composite primary key makes ingest
-- idempotent: INSERT OR IGNORE silently drops a scrobble already stored, so the
-- cron pull and the backfill can overlap freely without creating duplicates.
CREATE TABLE IF NOT EXISTS scrobbles (
  uts    INTEGER NOT NULL,          -- scrobble time, unix seconds (UTC)
  track  TEXT    NOT NULL,
  artist TEXT    NOT NULL,
  album  TEXT,
  mbid   TEXT,                       -- MusicBrainz id, when Last.fm has one
  image  TEXT,                       -- album-art URL
  PRIMARY KEY (uts, track, artist)
);

CREATE INDEX IF NOT EXISTS idx_scrobbles_uts    ON scrobbles (uts);
CREATE INDEX IF NOT EXISTS idx_scrobbles_artist ON scrobbles (artist);
