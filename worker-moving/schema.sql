-- Activities, mirrored from the Strava API.
--
-- Upsert-only, like worker-watching: the sync sees a window of recent
-- activities, so a DELETE + re-insert would drop the archive every run.

CREATE TABLE IF NOT EXISTS activities (
  id            TEXT    PRIMARY KEY,  -- Strava activity id, as a string
  name          TEXT    NOT NULL,
  -- Strava's sport_type: Ride, EBikeRide, VirtualRide, WeightTraining, Workout…
  sport_type    TEXT    NOT NULL,
  -- Coarse bucket the page groups on, derived from sport_type: ride | ebike |
  -- lift | walk | run | yoga | climb | dance | other. Re-derive with
  -- scripts/moving-recategorize.sql after changing the mapping.
  kind          TEXT    NOT NULL,
  start_date    TEXT    NOT NULL,     -- YYYY-MM-DD, athlete-local
  started_at    INTEGER NOT NULL,     -- unix seconds, UTC
  -- Stored in American units so the page never converts on read.
  distance_mi   REAL    NOT NULL DEFAULT 0,
  elevation_ft  REAL    NOT NULL DEFAULT 0,
  moving_time   INTEGER NOT NULL DEFAULT 0,  -- seconds
  elapsed_time  INTEGER NOT NULL DEFAULT 0,  -- seconds
  -- No polylines, coordinates, or per-activity streams: the page shows a date
  -- and a distance, and what isn't stored can't leak.
  trainer       INTEGER NOT NULL DEFAULT 0,
  commute       INTEGER NOT NULL DEFAULT 0,
  -- Heart rate, when the activity was recorded with a monitor. NULL — not 0 —
  -- when it wasn't: plenty of activities have none, and a zero would average
  -- into the numbers as if the heart had stopped. Whole bpm; Strava reports
  -- averages to one decimal, which is noise on a summary line.
  -- Two summary numbers only, never a stream, for the same reason as above.
  avg_hr        INTEGER,
  max_hr        INTEGER
);

-- Matches fetchActivities() exactly, both ordering columns in the query's
-- direction, so paging is an index seek rather than a sort of a growing archive.
CREATE INDEX IF NOT EXISTS idx_activities_seq ON activities (start_date DESC, id DESC);
-- Range scans for /windows.json (the listening crossover).
CREATE INDEX IF NOT EXISTS idx_activities_started ON activities (started_at);

-- Precomputed totals, read once per bundle. Not COUNT(*) subqueries, for the
-- reason given on the same table in worker-watching/schema.sql.
CREATE TABLE IF NOT EXISTS stats (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  activities  INTEGER NOT NULL DEFAULT 0,
  rides       INTEGER NOT NULL DEFAULT 0,
  lifts       INTEGER NOT NULL DEFAULT 0,
  distance_mi REAL    NOT NULL DEFAULT 0,
  moving_time INTEGER NOT NULL DEFAULT 0,
  -- {"2026": {"activities": 120, "rides": 80, "lifts": 40, "distanceMi": 412.3, "bikeMiles": 380.1}, …}
  by_year     TEXT    NOT NULL DEFAULT '{}',
  updated_at  INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO stats (id) VALUES (1);

-- Strava rotates the refresh token on every exchange, so it can't live in a
-- Worker secret — secrets are write-only from the Worker's side. The secret
-- seeds this table on first run; after that this row is the authority.
CREATE TABLE IF NOT EXISTS auth (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  refresh_token TEXT,
  access_token  TEXT,
  expires_at    INTEGER NOT NULL DEFAULT 0,  -- unix seconds
  updated_at    INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO auth (id) VALUES (1);
