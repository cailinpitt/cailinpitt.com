-- Adds an optional link card to a note, and the fields its async render fills
-- in once it's done.
--
-- Same one-time migration story as schema-v2.sql:
--
--   npx wrangler d1 execute cailinpitt-notes --remote --file=schema-v3.sql
--
-- link_url/link_hidden are set synchronously, on publish/edit: link_url is
-- the one link (of possibly several in the text) a card should be built for,
-- and link_hidden means that link's own text was deleted from `text` when it
-- was set — see validate.ts for the rule that ties the two together, and
-- index.ts for where the deletion happens.
--
-- link_title/link_description/link_image_ready start empty and are filled in
-- moments later by buildLinkCard() in index.ts, which scrapes the link and
-- writes straight to R2/D1 from inside the Worker — a note with a link_url
-- and nothing else yet is one whose card hasn't finished, not a note without
-- a card at all. link_image_ready is an integer rather than trusting that
-- the R2 object exists, for the same reason the per-note card image is
-- referenced unconditionally in noteHtml(): cheaper than checking.

ALTER TABLE notes ADD COLUMN link_url TEXT;
ALTER TABLE notes ADD COLUMN link_hidden INTEGER NOT NULL DEFAULT 0;
ALTER TABLE notes ADD COLUMN link_title TEXT;
ALTER TABLE notes ADD COLUMN link_description TEXT;
ALTER TABLE notes ADD COLUMN link_image_ready INTEGER NOT NULL DEFAULT 0;
