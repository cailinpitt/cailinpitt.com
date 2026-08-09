-- Notes: the microblog behind cailinpitt.com/notes.
--
-- One row per note, published the instant it passes the token check and the
-- length cap. There is no draft state, no pending state, and no approval step —
-- the write is the publish.
--
-- `id` is 6 random bytes as hex rather than an autoincrement integer for two
-- reasons: it is a public permalink (`/notes#a3f91c2b40d1`), and a sequential id
-- would publish how many notes have ever been written, including the ones
-- deleted a minute after posting.
CREATE TABLE IF NOT EXISTS notes (
  id         TEXT    PRIMARY KEY,
  text       TEXT    NOT NULL,     -- plain text, <= 480 code points (validate.ts)
  created_at INTEGER NOT NULL,     -- unix seconds (UTC)
  -- Unix seconds of the last edit, NULL if never edited. Not a bookkeeping
  -- column: the site renders an "edited" marker from it, because a permalink
  -- that silently changes what it says is the thing worth avoiding.
  edited_at  INTEGER
);

-- The whole read path: newest first, with (created_at, id) as the pagination
-- cursor. The id is in the index because it is in the ORDER BY — two notes in
-- the same second (a Shortcut firing twice on a flaky connection) would
-- otherwise page unstably. See encodeCursor() in src/store.ts.
CREATE INDEX IF NOT EXISTS idx_notes_created ON notes (created_at DESC, id DESC);
