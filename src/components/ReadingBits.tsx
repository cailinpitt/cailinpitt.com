// Presentational pieces for /reading. Kept out of the page file so the two card
// shapes — a book and an article — stay easy to read side by side.

import { Art } from './ListeningBits'
import { formatTime } from '../lib/datetime'
import {
  faviconUrl,
  formatBookDate,
  hardcoverUrl,
  readingImage,
  stars,
  titleFromUrl,
  type Article,
  type Book,
  type Link,
} from '../lib/reading'

function BookCoverArt({ src }: { src: string | null }) {
  if (!src) {
    return (
      <span className="book-cover book-cover-placeholder" aria-hidden="true">
        📖
      </span>
    )
  }
  return <img src={src} alt="" className="book-cover" loading="lazy" decoding="async" />
}

export function BookCard({ book, dateLabel }: { book: Book; dateLabel: 'started' | 'finished' }) {
  const href = hardcoverUrl(book)
  const rating = stars(book.rating)
  const date = formatBookDate(dateLabel === 'started' ? book.startedAt : book.finishedAt)

  const inner = (
    <>
      {/* alt="": title is right beside it, no need to announce the book twice. */}
      <BookCoverArt src={readingImage(book.cover)} />
      <span className="book-meta">
        <span className="book-title">{book.title}</span>
        {book.authors && <span className="book-author">{book.authors}</span>}
        {rating && (
          <span className="book-rating" aria-label={`Rated ${book.rating} out of 5`}>
            {rating}
          </span>
        )}
        {date && (
          <span className="book-date">
            {dateLabel === 'started' ? 'Started' : 'Finished'} {date}
          </span>
        )}
      </span>
    </>
  )

  return (
    <li className="book-card">
      {href ? (
        <a className="book-link" href={href} target="_blank" rel="noopener noreferrer">
          {inner}
        </a>
      ) : (
        <span className="book-link">{inner}</span>
      )}
    </li>
  )
}

export function ArticleCard({ article }: { article: Article }) {
  return (
    <li className="article-card">
      <a
        className="article-link"
        href={article.url}
        target="_blank"
        rel="noopener noreferrer"
      >
        <span className="article-shot">
          <Art src={readingImage(article.image)} alt="" className="article-image" />
        </span>
        <span className="article-meta">
          <span className="article-title">{article.title || titleFromUrl(article.url)}</span>
          <span className="article-source">
            {article.site && <span className="article-site">{article.site}</span>}
            <time dateTime={new Date(article.readAt * 1000).toISOString()}>
              {formatTime(article.readAt)}
            </time>
          </span>
          {article.excerpt && <span className="article-excerpt">{article.excerpt}</span>}
        </span>
      </a>
      {article.note && <p className="article-note">{article.note}</p>}
    </li>
  )
}

// A saved link — deliberately lighter than ArticleCard: favicon, title, host,
// and your note. No card image; /links is a list, not a gallery.
export function LinkRow({ link }: { link: Link }) {
  const favicon = faviconUrl(link.url)
  let host = link.site
  if (!host) {
    try {
      host = new URL(link.url).hostname.replace(/^www\./, '')
    } catch {
      host = link.url
    }
  }

  return (
    <li className="link-row">
      <a className="link-row-link" href={link.url} target="_blank" rel="noopener noreferrer">
        {favicon ? (
          <img
            className="link-row-favicon"
            src={favicon}
            alt=""
            width={16}
            height={16}
            loading="lazy"
            decoding="async"
            onError={(e) => {
              e.currentTarget.style.visibility = 'hidden'
            }}
          />
        ) : (
          <span className="link-row-favicon" aria-hidden="true" />
        )}
        <span className="link-row-title">{link.title || titleFromUrl(link.url)}</span>
        <span className="link-row-meta">
          {host && <span className="link-row-host">{host}</span>}
          <time dateTime={new Date(link.savedAt * 1000).toISOString()}>
            {formatTime(link.savedAt)}
          </time>
        </span>
      </a>
      {link.note && <p className="link-row-note">{link.note}</p>}
    </li>
  )
}
