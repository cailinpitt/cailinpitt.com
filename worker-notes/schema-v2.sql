-- Adds an optional reference from a note to something else on the site.
--
-- schema.sql is CREATE TABLE IF NOT EXISTS, so it cannot add a column to a
-- table that already exists — an existing database needs this once:
--
--   npx wrangler d1 execute cailinpitt-notes --remote --file=schema-v2.sql
--
-- SQLite has no ADD COLUMN IF NOT EXISTS, so re-running this fails with
-- "duplicate column name". That is the whole safety mechanism: it means the
-- migration has already been applied, and nothing was changed.
--
-- Both columns are nullable and stay NULL for every existing row and for any
-- note published without a reference — this is optional context, not a
-- required relationship. context_type names which kind of thing is being
-- referenced ('photo' | 'activity' | 'post'); context_ref is that thing's own
-- id in its own space (a photo id, a Strava-backed activity id, or a post's
-- path) — see validate.ts for the exact rules and src/lib/notesContext.ts for
-- how a reference turns into a label and a link.

ALTER TABLE notes ADD COLUMN context_type TEXT;
ALTER TABLE notes ADD COLUMN context_ref TEXT;
