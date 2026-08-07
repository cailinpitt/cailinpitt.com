// Secrets aren't captured by `wrangler types` (they live outside wrangler.jsonc),
// so declare them here. TypeScript merges this into the generated Env interface.
interface Env {
  /** Last.fm API key. Set with: wrangler secret put LASTFM_API_KEY */
  LASTFM_API_KEY: string
  /**
   * Base URL of the moving Worker, for the activity crossover. Declared here
   * rather than relying on generated types so the optional-var case is explicit:
   * with it unset the crossover simply never runs.
   */
  MOVING_API?: string
}
