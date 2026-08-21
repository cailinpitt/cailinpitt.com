-- Re-derive `kind` from the stored sport_type.
--
-- Run after changing the kind taxonomy in worker-moving/src/strava.ts. Rows
-- written before a new bucket existed keep their old value, because the sync
-- only rewrites activities it actually fetched. Safe to re-run.
--
--   cd worker-moving && npx wrangler d1 execute cailinpitt-moving \
--     --remote --file=../scripts/moving-recategorize.sql
--
-- Then `npm run moving:sync` from the repo root to rebuild `stats`.

UPDATE activities SET kind = CASE sport_type
  WHEN 'Ride'                 THEN 'ride'
  WHEN 'GravelRide'           THEN 'ride'
  WHEN 'MountainBikeRide'     THEN 'ride'
  WHEN 'VirtualRide'          THEN 'ride'
  WHEN 'EBikeRide'            THEN 'ebike'
  WHEN 'EMountainBikeRide'    THEN 'ebike'
  WHEN 'WeightTraining'       THEN 'lift'
  WHEN 'Crossfit'             THEN 'lift'
  WHEN 'Walk'                 THEN 'walk'
  WHEN 'Hike'                 THEN 'walk'
  WHEN 'Run'                  THEN 'run'
  WHEN 'TrailRun'             THEN 'run'
  WHEN 'VirtualRun'           THEN 'run'
  WHEN 'Yoga'                 THEN 'yoga'
  WHEN 'RockClimbing'         THEN 'climb'
  WHEN 'RockClimb'            THEN 'climb'
  WHEN 'Dance'                THEN 'dance'
  ELSE 'other'
END;
