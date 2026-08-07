-- One-time population of the Layer 1 summary tables from the existing archive.
--
-- Run once, after schema-v2.sql, and never again on a live database: these are
-- absolute writes (plays = COUNT(*)), so re-running is safe and idempotent, but
-- only because it recomputes rather than increments. The ingest tick increments
-- from here on, so this must not race a running cron — see RUNBOOK.md.
--
--   wrangler d1 execute cailinpitt-listening --remote --file=schema-v2.sql
--   wrangler d1 execute cailinpitt-listening --remote --file=backfill-summary.sql
--
-- Cost: four grouped scans of ~101k rows, ~400k row reads total, one time.
-- The TZ offset below must match TZ_OFFSET_SECONDS in wrangler.jsonc (-18000).

INSERT INTO artists (artist, first_uts, last_uts, plays)
SELECT artist, MIN(uts), MAX(uts), COUNT(*) FROM scrobbles GROUP BY artist
ON CONFLICT(artist) DO UPDATE SET
  first_uts = excluded.first_uts,
  last_uts  = excluded.last_uts,
  plays     = excluded.plays;

INSERT INTO albums (album, artist, first_uts, last_uts, plays)
SELECT album, artist, MIN(uts), MAX(uts), COUNT(*)
  FROM scrobbles WHERE album IS NOT NULL AND album <> ''
 GROUP BY album, artist
ON CONFLICT(album, artist) DO UPDATE SET
  first_uts = excluded.first_uts,
  last_uts  = excluded.last_uts,
  plays     = excluded.plays;

INSERT INTO tracks (track, artist, first_uts, last_uts, plays)
SELECT track, artist, MIN(uts), MAX(uts), COUNT(*) FROM scrobbles GROUP BY track, artist
ON CONFLICT(track, artist) DO UPDATE SET
  first_uts = excluded.first_uts,
  last_uts  = excluded.last_uts,
  plays     = excluded.plays;

INSERT INTO days (day, plays)
SELECT date(uts + -18000, 'unixepoch'), COUNT(*) FROM scrobbles GROUP BY 1
ON CONFLICT(day) DO UPDATE SET plays = excluded.plays;
