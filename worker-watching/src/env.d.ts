// Secrets aren't captured by `wrangler types` (they live outside wrangler.jsonc),
// so declare them here. TypeScript merges this into the generated Env interface.
interface Env {
  /**
   * Bearer token for `POST /sync`, which runs the Letterboxd pull on demand —
   * used for the initial poster backfill, and to pick up a film without waiting
   * for the cron. Any random string; generate with `openssl rand -hex 24`.
   * Set with: wrangler secret put ADMIN_TOKEN
   */
  ADMIN_TOKEN: string
}
