import { linkedUrls } from './postLinks'
import type { Post } from './posts'

// Which blog posts link to a saved article or link. Built from the markdown at
// build time and matched against the Worker's urls in the browser, so both
// sides go through mentionKey().

export interface Mention {
  path: string
  title: string
}

/** Blog-post mentions keyed by mentionKey(url). */
export type Mentions = Record<string, Mention[]>

// Mirrors TRACKING_PARAM in worker-reading/src/articles.ts.
const TRACKING_PARAM =
  /^(utm_[a-z_]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|ref|ref_src|referrer|source|cmpid|ncid|spm|si|at_medium|at_campaign|__twitter_impression|_hsenc|_hsmi|vero_id|oly_enc_id|oly_anon_id)$/i

/**
 * A url with the differences that don't change the page dropped: scheme, "www.",
 * fragment, tracking params, param order, trailing slash. Null for anything
 * that isn't an absolute http(s) url.
 */
export function mentionKey(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAM.test(key)) url.searchParams.delete(key)
  }
  url.searchParams.sort()
  const path = url.pathname.replace(/\/+$/, '')
  const query = url.searchParams.toString()
  return `${url.host.replace(/^www\./, '')}${path}${query ? `?${query}` : ''}`
}

const OWN_SITE = /^(www\.)?cailinpitt\.com$/i

/** Every external url the posts link to, mapped to the posts (newest first) that link it. */
export function postMentions(posts: Pick<Post, 'path' | 'title' | 'date' | 'body'>[]): Mentions {
  const out: Mentions = {}
  const newestFirst = [...posts].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
  for (const post of newestFirst) {
    const keys = new Set(
      linkedUrls(post.body)
        .map(mentionKey)
        .filter((key): key is string => key !== null && !OWN_SITE.test(key.split('/')[0])),
    )
    for (const key of keys) (out[key] ??= []).push({ path: post.path, title: post.title })
  }
  return out
}

/** Loader for /links and /reading/articles: the mention index, baked in at build time. */
export async function loadMentions(): Promise<Mentions | null> {
  if (!import.meta.env.SSR && !import.meta.env.DEV) return null
  if (import.meta.env.SSR) {
    const { loadPosts } = await import('./content.server')
    return postMentions(await loadPosts())
  }
  const { loadPosts } = await import('./blogPosts.client')
  return postMentions(loadPosts())
}
