-- Adds scooter ride energy and the scooter's battery size.
--
-- Run once on an existing database, before deploying the Worker that writes them:
--
--   npx wrangler d1 execute cailinpitt-moving --remote --file=schema-v4.sql
--
-- Re-running fails with "duplicate column name", which means it was already applied.

-- Watt-hours a scooter ride used, across both batteries. NULL for everything else.
ALTER TABLE activities ADD COLUMN energy_wh INTEGER;
-- Usable watt-hours across both batteries when full, for the range estimate.
ALTER TABLE scooter ADD COLUMN full_wh INTEGER;
