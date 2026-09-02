-- Plays-ordered indexes, matching idx_artists_plays. Used by allTimeTops() and
-- the enrichment anti-join; without them each is a full scan + sort.

CREATE INDEX IF NOT EXISTS idx_albums_plays ON albums (plays DESC);
CREATE INDEX IF NOT EXISTS idx_tracks_plays ON tracks (plays DESC);
