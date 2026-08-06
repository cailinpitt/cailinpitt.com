// Secrets aren't captured by `wrangler types`, so declare them here.
// TypeScript merges this into the generated Env interface.
interface Env {
  /**
   * Bearer token for `POST /sync`. Any random string;
   * generate with `openssl rand -hex 24`.
   * Set with: wrangler secret put ADMIN_TOKEN
   */
  ADMIN_TOKEN: string

  /** Strava API application credentials, from strava.com/settings/api. */
  STRAVA_CLIENT_ID: string
  STRAVA_CLIENT_SECRET: string

  /**
   * Seeds the `auth` table on the very first run only. Strava rotates the
   * refresh token on every exchange, so after that D1 holds the current one and
   * this secret is stale by design.
   */
  STRAVA_REFRESH_TOKEN: string
}
