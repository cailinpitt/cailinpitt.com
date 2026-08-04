/// <reference types="vite/client" />

/**
 * Post metadata inlined at build time by the `cailinpitt:site-index` plugin in
 * vite.config.ts. Bodies are deliberately not included — see the comment there.
 */
declare module 'virtual:site-index' {
  export const posts: {
    path: string
    title: string
    /** ISO date, e.g. 2023-03-03. Empty for the handful of undated posts. */
    date: string
    tags: string[]
  }[]
  /**
   * Every photo's permalink slug, for the prerenderer's static paths. Empty in
   * the browser build — see the plugin.
   */
  export const photoIds: string[]
  /** Years the photo feed covers, newest first. */
  export const photoYears: string[]
}

/**
 * Per-post git history, read at build time by the `cailinpitt:post-history`
 * plugin in vite.config.ts. Empty outside a git repo.
 */
declare module 'virtual:post-history' {
  /** Browsable URL of the origin remote, e.g. https://github.com/user/repo. */
  export const repo: string | null
  /** Keyed by post path; `file` is the source path within the repo. */
  export const history: Record<
    string,
    import('./lib/history').PostHistory & { file: string }
  >
}
