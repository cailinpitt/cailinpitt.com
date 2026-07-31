// Secrets aren't captured by `wrangler types` (they live outside wrangler.jsonc),
// so declare them here. TypeScript merges this into the generated Env interface.
interface Env {
  /** Hardcover API token. Set with: wrangler secret put HARDCOVER_TOKEN */
  HARDCOVER_TOKEN: string
  /**
   * Bearer token for `POST /ingest` — the share-sheet Shortcut and the
   * bookmarklet. Deliberately separate from ADMIN_TOKEN: this one lives on a
   * phone and inside a bookmarklet, and all it can do is add an article.
   * Set with: wrangler secret put INGEST_TOKEN
   */
  INGEST_TOKEN: string
  /**
   * Bearer token for `POST /sync`, which runs the Hardcover sync on demand
   * (used for the initial cover backfill, and to pick up a book without waiting
   * for the daily cron). Any random string; generate with `openssl rand -hex 24`.
   * Set with: wrangler secret put ADMIN_TOKEN
   */
  ADMIN_TOKEN: string
}
