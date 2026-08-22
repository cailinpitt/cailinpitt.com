// Secrets aren't captured by `wrangler types`, so declared here.
interface Env {
  /** Same widget as worker-guestbook — can share its secret value. */
  TURNSTILE_SECRET: string
  /** Bearer token for /admin/comments and DELETE /comments/:id. */
  ADMIN_TOKEN: string
  /** Salt for the stored IP hash. Must stay stable — rotating resets rate limits. */
  IP_SALT: string
}
