-- "Returning artists": someone dormant for a long stretch who turned up again.
--
-- This was deferred out of Tier A because every cheap way to ask it at read time
-- was wrong. `artists.last_uts` is the artist's *global* last play, so it can't
-- answer "when did they last play before this period", and a targeted
-- `MAX(uts) ... WHERE artist IN (...)` walks every prior play of a heavy artist
-- — worst case ~40k rows per period, ~2.6M/day across the period builds.
--
-- Materializing the returns instead makes it an index range: one row per event,
-- not per play, and there are only a few hundred in the whole archive.

CREATE TABLE IF NOT EXISTS returns (
  artist   TEXT    NOT NULL,
  -- The play that ended the gap.
  uts      INTEGER NOT NULL,
  -- Days since that artist's previous play.
  gap_days INTEGER NOT NULL,
  PRIMARY KEY (artist, uts)
);

CREATE INDEX IF NOT EXISTS idx_returns_uts ON returns (uts);
