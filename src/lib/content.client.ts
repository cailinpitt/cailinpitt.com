// Dev-only content loading for `vite` CSR mode; production uses content.server.ts instead,
// so these eager Markdown imports are stripped from the production client build.

import atprotoData from '../../content/atproto.json'
import photoManifest from './photos.json'
import concertManifest from './concerts.json'
import { byNewest, type Photo } from './photos'
import { datedPhotos } from './timeline'
import { toPost, type AtprotoData, type Post, type PostSummary } from './posts'
import type { Concert } from './concerts'

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

export function loadConcerts(): Concert[] {
  return concertManifest as Concert[]
}
