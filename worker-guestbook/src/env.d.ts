// Secrets aren't captured by `wrangler types` (they live outside wrangler.jsonc),
// so declare them here. TypeScript merges this into the generated Env interface.
interface Env {
  /**
   * Turnstile secret key — server half of the widget whose site key is in
   * wrangler.jsonc. `.dev.vars` carries Cloudflare's always-passes test secret
   * for local dev. Set the real one with: wrangler secret put TURNSTILE_SECRET
   */
  TURNSTILE_SECRET: string
  /**
   * Bearer token for the moderation routes (`GET /admin/entries`,
   * `DELETE /entries/:id`) — i.e. for `npm run guestbook:list` and
   * `guestbook:rm`. Any long random string; `openssl rand -hex 24`.
   * Set with: wrangler secret put ADMIN_TOKEN
   */
  ADMIN_TOKEN: string
  /**
   * Salt mixed into the stored IP hashes. Must be secret and must be *stable*:
   * rotating it silently resets everyone's rate-limit window, because the old
   * rows no longer hash to anything a new request can match.
   * Set with: wrangler secret put IP_SALT
   */
  IP_SALT: string
}
