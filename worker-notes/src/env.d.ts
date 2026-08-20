// Secrets aren't captured by `wrangler types` (they live outside wrangler.jsonc),
// so declare them here. TypeScript merges this into the generated Env interface.
interface Env {
  /**
   * Bearer token for every write route. The entire security boundary — no
   * Turnstile, no origin check, since the primary client is an iOS Shortcut.
   * Same value goes into the Shortcut's Authorization header and is pasted
   * into /notes/compose per device; rotating it is how you revoke a lost phone.
   * Set with: wrangler secret put PUBLISH_TOKEN
   */
  PUBLISH_TOKEN: string

  /**
   * Fine-grained PAT (Contents: read+write) that fires the repository_dispatch
   * rendering a note's OG card. Optional — missing just means no card.
   * Set with: wrangler secret put GITHUB_TOKEN
   */
  GITHUB_TOKEN?: string
}
