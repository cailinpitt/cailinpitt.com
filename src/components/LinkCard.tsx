import { linkCardImageUrl, type Note } from '../lib/notes'

/**
 * A note's attached link, shown as a Twitter/Bluesky-style card: image,
 * title, subtitle, hostname. Modeled on resolveContext/.note-context in
 * notesContext.ts — a pure function of the note, rendering nothing until
 * there's something to show.
 *
 * Renders nothing until linkTitle or linkImageReady is set — a note can have
 * `linkUrl` set the instant it's published, before the background scrape
 * (buildLinkCard in worker-notes/src/index.ts) has finished. There's no
 * loading state here for that gap: the note itself is already visible, and
 * the card just appears within the next poll once it's ready.
 */
export function LinkCard({ note }: { note: Note }) {
  if (!note.linkUrl || (!note.linkTitle && !note.linkImageReady)) return null

  const href = note.linkUrl.startsWith('www.') ? `https://${note.linkUrl}` : note.linkUrl
  const host = new URL(href).hostname.replace(/^www\./, '')

  return (
    <a className="link-card" href={href} rel="noopener noreferrer nofollow">
      {note.linkImageReady && (
        <img className="link-card-image" src={linkCardImageUrl(note.id)} alt="" loading="lazy" decoding="async" />
      )}
      <span className="link-card-body">
        {note.linkTitle && <span className="link-card-title">{note.linkTitle}</span>}
        {note.linkDescription && <span className="link-card-subtitle">{note.linkDescription}</span>}
        <span className="link-card-host">{host}</span>
      </span>
    </a>
  )
}
