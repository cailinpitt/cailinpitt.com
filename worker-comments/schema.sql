-- Mirrors worker-guestbook/schema.sql, scoped by post_path, no location/country.
CREATE TABLE IF NOT EXISTS comments (
  id         TEXT    PRIMARY KEY,
  post_path  TEXT    NOT NULL,        -- e.g. "/blog/2026/8/21/some-slug" (not zero-padded)
  name       TEXT    NOT NULL,
  message    TEXT    NOT NULL,
  website    TEXT,                    -- normalized http(s) url, or NULL
  created_at INTEGER NOT NULL,        -- unix seconds (UTC)
  ip_hash    TEXT    NOT NULL         -- SHA-256(ip + IP_SALT); rate limiting only
);

CREATE INDEX IF NOT EXISTS idx_comments_post ON comments (post_path, created_at);
CREATE INDEX IF NOT EXISTS idx_comments_rate ON comments (ip_hash, created_at);
