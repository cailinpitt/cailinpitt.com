import { Fragment } from 'react'
import { paragraphs, segments } from '../lib/notes'

/**
 * A note's text: paragraphs on blank lines, line breaks inside them, and bare
 * URLs turned into links.
 *
 * Everything here is React elements built from a parsed data structure — there
 * is no HTML string in the pipeline and no `dangerouslySetInnerHTML`, so a note
 * cannot contribute markup to the page no matter what was typed into it. That is
 * the reason notes are plain text rather than Markdown: the only formatting a
 * short thought needs is a working link, and this is what a working link costs.
 */
export function NoteText({ text }: { text: string }) {
  return (
    <>
      {paragraphs(text).map((para, i) => (
        <p key={i}>
          {para.split('\n').map((line, j) => (
            <Fragment key={j}>
              {j > 0 && <br />}
              {segments(line).map((segment, k) =>
                segment.kind === 'link' ? (
                  <a key={k} href={segment.href} rel="noopener noreferrer nofollow">
                    {segment.value}
                  </a>
                ) : (
                  <Fragment key={k}>{segment.value}</Fragment>
                ),
              )}
            </Fragment>
          ))}
        </p>
      ))}
    </>
  )
}
