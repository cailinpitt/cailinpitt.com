-- One-time population of `returns` from the archive.
--
-- LAG() over (artist, uts) gives each play the artist's previous play in one
-- pass, which is the whole reason this is affordable — the correlated
-- alternative probes per row. One ~101k-row scan, run once.
--
--   wrangler d1 execute cailinpitt-listening --remote --file=schema-v5.sql
--   wrangler d1 execute cailinpitt-listening --remote --file=backfill-returns.sql
--
-- Safe to re-run: INSERT OR REPLACE keyed on (artist, uts).
--
-- The 365-day threshold matches RETURN_GAP in src/summary.ts. Changing it means
-- re-running this, or the historical rows and the live ones disagree.

INSERT OR REPLACE INTO returns (artist, uts, gap_days)
SELECT artist, uts, CAST((uts - prev_uts) / 86400 AS INTEGER)
  FROM (
    SELECT artist, uts, LAG(uts) OVER (PARTITION BY artist ORDER BY uts) AS prev_uts
      FROM scrobbles
  )
 WHERE prev_uts IS NOT NULL
   AND uts - prev_uts >= 365 * 86400;
