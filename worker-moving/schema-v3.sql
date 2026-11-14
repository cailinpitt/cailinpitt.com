-- Adds scooter battery levels and the scooter's odometer.
--
-- Run once on an existing database, before deploying the Worker that writes them:
--
--   npx wrangler d1 execute cailinpitt-moving --remote --file=schema-v3.sql
--
-- Re-running fails with "duplicate column name", which means it was already applied.

-- Percent at the start and end of a scooter ride. NULL for everything else.
ALTER TABLE activities ADD COLUMN battery_start INTEGER;
ALTER TABLE activities ADD COLUMN battery_end INTEGER;

-- The scooter's own lifetime odometer, which counts miles from before the logger ran.
CREATE TABLE IF NOT EXISTS scooter (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  odometer_mi  REAL    NOT NULL,
  riding_time  INTEGER NOT NULL DEFAULT 0,  -- seconds, lifetime
  updated_at   INTEGER NOT NULL             -- unix seconds
);
