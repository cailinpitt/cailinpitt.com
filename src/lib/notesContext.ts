// Resolving a note's optional context reference (contextType/contextRef) into
// something renderable: an icon, a short label, and — where one exists — a
// link.
//
// Deliberately reads only from data the *caller* already has loaded, rather
// than fetching anything itself. Every page that shows a note loads different
// things: /timeline already has photos and posts in hand, /notes has neither,
// nowhere loads moving activities just to look one up. Rather than one page
// paying for a fetch to label a reference nobody may have written, an
// unresolved reference still renders — a generic label plus, for a photo or a
// post, a link that's correct without needing the object it points to, since
// both of those ids are their own permalink slug/path.

import { summary as activitySummary, type Activity } from './moving'
import type { ContextType } from './notes'
import type { Photo } from './photos'
import { formatPhotoDateShort } from './photos'
import type { PostSummary } from './posts'

/** Whatever the caller already has loaded, to enrich a reference's label. None of these are fetched here. */
export interface ContextSources {
  photos?: Photo[]
  activities?: Activity[]
  posts?: PostSummary[]
}

export interface ContextInfo {
  icon: string
  /** What follows "re:" — never includes the prefix itself, so a caller can style it separately. */
  text: string
  /** Null only for an activity, which has no page of its own to link to yet. */
  href: string | null
}

/**
 * Turn a note's context fields into something to render, or null for an
 * ordinary note. `contextType`/`contextRef` always travel together — see
 * validate.ts on the Worker side — so either both are present or the result
 * is null.
 */
export function resolveContext(
  contextType: ContextType | null,
  contextRef: string | null,
  sources: ContextSources = {},
): ContextInfo | null {
  if (!contextType || !contextRef) return null

  switch (contextType) {
    case 'photo': {
      const photo = sources.photos?.find((p) => p.id === contextRef)
      // The id alone is a correct link even when the photo object isn't
      // loaded here — /photos/<id> is a stable permalink, not a lookup.
      return { icon: '📷', text: photo ? formatPhotoDateShort(photo) : 'a photo', href: `/photos/${contextRef}` }
    }
    case 'activity': {
      const activity = sources.activities?.find((a) => a.id === contextRef)
      // No permalink exists per activity yet, so this points at the log in
      // general rather than somewhere that could 404.
      return { icon: '🏃', text: activity ? activitySummary(activity) : 'a workout', href: '/moving' }
    }
    case 'post': {
      const post = sources.posts?.find((p) => p.path === contextRef)
      // contextRef *is* the path a post was published under, so this is a
      // real link whether or not the post list happens to be loaded.
      return { icon: '✍️', text: post ? post.title : 'a post', href: contextRef }
    }
  }
}
