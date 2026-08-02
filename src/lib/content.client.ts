// Development-only content loading for `vite` CSR mode. Production uses the
// server-only loaders in content.server.ts plus generated static loader data, so
// these eager Markdown imports are removed from the production client build.

import atprotoData from '../../content/atproto.json'
import photoManifest from './photos.json'
import { byNewest, type Photo } from './photos'
import { datedPhotos } from './timeline'
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

export function loadPublicationUri(): string | null {
  return atproto.publication
}

export function loadPhotos(): Photo[] {
  return [...(photoManifest as Photo[])].sort(byNewest)
}

export function loadDatedPhotos(): Photo[] {
  return datedPhotos(loadPhotos())
}
