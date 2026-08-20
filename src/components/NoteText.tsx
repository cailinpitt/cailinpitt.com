import { Fragment } from 'react'
import { Link } from 'react-router-dom'
import { paragraphs, segments } from '../lib/notes'

/**
 * Renders a note's text: paragraphs, line breaks, bare URLs, and `#hashtag`s
 * as links. Built entirely from React elements, no HTML string or
 * `dangerouslySetInnerHTML` — a note can't inject markup no matter what was typed.
 */
export function NoteText({ text }: { text: string }) {
  return (
    <>
      {paragraphs(text).map((para, i) => (
        <p key={i}>
          {para.split('\n').map((line, j) => (
            <Fragment key={j}>
              {j > 0 && <br />}
              {segments(line).map((segment, k) => {
                if (segment.kind === 'link') {
                  return (
                    <a key={k} href={segment.href} rel="noopener noreferrer nofollow">
                      {segment.value}
                    </a>
                  )
                }
                if (segment.kind === 'hashtag') {
                  return (
                    <Link key={k} to={`/notes/tag/${segment.tag}`}>
                      {segment.value}
                    </Link>
                  )
                }
                return <Fragment key={k}>{segment.value}</Fragment>
              })}
            </Fragment>
          ))}
        </p>
      ))}
    </>
  )
}
