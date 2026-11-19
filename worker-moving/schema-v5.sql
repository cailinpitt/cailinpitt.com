-- Weekly gas prices, for pricing each scooter ride's miles at what gas cost that week.
--
-- Run once on an existing database, before deploying the Worker that reads it:
--
--   npx wrangler d1 execute cailinpitt-moving --remote --file=schema-v5.sql

CREATE TABLE IF NOT EXISTS gas_prices (
  week        TEXT    PRIMARY KEY,  -- YYYY-MM-DD, the EIA's week
  price       REAL    NOT NULL,     -- dollars per gallon, regular
  fetched_at  INTEGER NOT NULL      -- unix seconds
);
