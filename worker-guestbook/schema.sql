-- Guestbook entries. One row per signature, published the moment it passes
-- Turnstile and validation — there is no pending state and no approval step.
--
-- `id` is a random 16-byte hex string rather than an autoincrement integer so
-- that the ids in the moderation CLI's output don't leak how many entries have
-- ever existed (including the ones deleted for being spam).
CREATE TABLE IF NOT EXISTS entries (
  id         TEXT    PRIMARY KEY,
  name       TEXT    NOT NULL,
  message    TEXT    NOT NULL,
  website    TEXT,                    -- normalized http(s) url, or NULL
  location   TEXT,                    -- free text ("Columbus, Ohio"), or NULL
  country    TEXT,                    -- ISO-3166-1 alpha-2 from request.cf, or NULL
  created_at INTEGER NOT NULL,        -- unix seconds (UTC)
  -- SHA-256 of (connecting IP + IP_SALT). Rate limiting only: it is never
  -- returned by a public endpoint, and the salt is a Worker secret so the hash
  -- can't be reversed by walking the IPv4 space. See PRIVACY in the README.
  ip_hash    TEXT    NOT NULL
);

-- The read path: newest first, with `created_at` as the pagination cursor.
CREATE INDEX IF NOT EXISTS idx_entries_created ON entries (created_at);

-- The per-IP rate limit: COUNT(*) WHERE ip_hash = ? AND created_at > ?. Leading
-- with ip_hash makes that an index seek over a handful of rows rather than a
-- scan of the table.
CREATE INDEX IF NOT EXISTS idx_entries_rate ON entries (ip_hash, created_at);
