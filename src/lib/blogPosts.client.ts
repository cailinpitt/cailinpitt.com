// Dev-only blog post loading for `vite` CSR mode; production uses content.server.ts instead,
// so this eager Markdown import is stripped from the production client build.
//
// Kept out of content.client.ts on purpose: the glob below is eager, so merely importing
// this module loads every post's raw body. Pages that only need photos/concerts must not
// pay that cost just because they share a "content" module with the blog.

import atprotoData from '../../content/atproto.json'
import { toPost, type AtprotoData, type Post, type PostSummary } from './posts'

const rawPosts = import.meta.glob('/content/blog/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const atproto = atprotoData as AtprotoData

export function loadPosts(): Post[] {
  return Object.entries(rawPosts)
    .map(([file, raw]) => toPost(file, raw, atproto))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
}

export function loadPostSummaries(): PostSummary[] {
  return loadPosts().map(({ body: _body, ...post }) => post)
}
