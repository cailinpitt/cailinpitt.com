// Resolves a note's optional context reference into an icon/label/link, reading only from
// data the *caller* already has loaded rather than fetching anything itself — an unresolved
// reference still renders, with a generic label and (for a photo or post, whose ids are
// their own permalink) a correct link regardless.

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

// Null for an ordinary note. contextType/contextRef always travel together (see validate.ts
// on the Worker side), so either both are present or the result is null.
export function resolveContext(
  contextType: ContextType | null,
  contextRef: string | null,
  sources: ContextSources = {},
): ContextInfo | null {
  if (!contextType || !contextRef) return null

  switch (contextType) {
    case 'photo': {
      const photo = sources.photos?.find((p) => p.id === contextRef)
      // /photos/<id> is a stable permalink, so the id alone is a correct link even unloaded.
      return { icon: '📷', text: photo ? formatPhotoDateShort(photo) : 'a photo', href: `/photos/${contextRef}` }
    }
    case 'activity': {
      const activity = sources.activities?.find((a) => a.id === contextRef)
      // No per-activity permalink yet, so this points at the log rather than something that could 404.
      return { icon: '🏃', text: activity ? activitySummary(activity) : 'a workout', href: '/moving' }
    }
    case 'post': {
      const post = sources.posts?.find((p) => p.path === contextRef)
      // contextRef *is* the path a post was published under, so this is a real link either way.
      return { icon: '✍️', text: post ? post.title : 'a post', href: contextRef }
    }
  }
}
