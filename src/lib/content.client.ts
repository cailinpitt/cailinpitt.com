// Dev-only content loading for `vite` CSR mode; production uses content.server.ts instead,
// so these eager Markdown imports are stripped from the production client build.
//
// Blog post loading lives in blogPosts.client.ts, not here: pages that only need photos or
// concerts import this module and must not also pay the cost of loading every post body.

import atprotoData from '../../content/atproto.json'
import photoManifest from './photos.json'
import concertManifest from './concerts.json'
import { byNewest, type Photo } from './photos'
import { datedPhotos } from './timeline'
import type { AtprotoData } from './posts'
import type { Concert } from './concerts'

const atproto = atprotoData as AtprotoData

export function loadPhotos(): Photo[] {
  return [...(photoManifest as Photo[])].sort(byNewest)
}

export function loadDatedPhotos(): Photo[] {
  return datedPhotos(loadPhotos())
}

export function loadConcerts(): Concert[] {
  return concertManifest as Concert[]
}

export function loadPublicationUri(): string | null {
  return atproto.publication
}
