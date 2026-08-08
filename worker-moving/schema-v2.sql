-- Adds heart rate to the activity archive.
--
-- schema.sql is CREATE TABLE IF NOT EXISTS, so it cannot add a column to a
-- table that already exists — an existing database needs this once:
--
--   npx wrangler d1 execute cailinpitt-moving --remote --file=schema-v2.sql
--
-- SQLite has no ADD COLUMN IF NOT EXISTS, so re-running this fails with
-- "duplicate column name". That is the whole safety mechanism: it means the
-- migration has already been applied, and nothing was changed.
--
-- Both columns are nullable and stay NULL for every existing row. Strava sends
-- heart rate on the activity summary, so no extra requests are needed to fill
-- them in — but the incremental sync only rewrites the last week. To backfill
-- the archive, re-pull it once the Worker is deployed:
--
--   npm run moving:sync -- --refresh
--
-- The upsert compares every column, so rows that gain a heart rate are detected
-- as changed and the totals recompute; rows recorded without a monitor stay
-- NULL and are skipped.

ALTER TABLE activities ADD COLUMN avg_hr INTEGER;
ALTER TABLE activities ADD COLUMN max_hr INTEGER;
