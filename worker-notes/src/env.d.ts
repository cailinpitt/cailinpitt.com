// Secrets aren't captured by `wrangler types` (they live outside wrangler.jsonc),
// so declare them here. TypeScript merges this into the generated Env interface.
interface Env {
  /**
   * Bearer token for every write route — `POST /notes`, `PATCH /notes/:id`,
   * `DELETE /notes/:id`.
   *
   * This is the entire security boundary of the microblog: there is no Turnstile
   * and no origin check, because the primary client is an iOS Shortcut rather
   * than a page. Any long random string; `openssl rand -hex 32`.
   *
   * Set with: wrangler secret put PUBLISH_TOKEN
   *
   * The same value goes into the iOS Shortcut's Authorization header, and is
   * pasted once into /notes/compose on each device you publish from. Rotating it
   * signs those devices out, which is the intended way to revoke a lost phone.
   */
  PUBLISH_TOKEN: string

  /**
   * Fine-grained PAT with Contents: read+write on this repo — fires the
   * repository_dispatch that renders a note's OG card. Optional: a missing
   * token just means notes go out without a card.
   *
   * Set with: wrangler secret put GITHUB_TOKEN
   */
  GITHUB_TOKEN?: string
}
