// Presentational pieces for /reading. Kept out of the page file so the two card
// shapes — a book and an article — stay easy to read side by side.

import { Art } from './ListeningBits'
import { formatTime } from '../lib/datetime'
import {
  formatBookDate,
  hardcoverUrl,
  readingImage,
  stars,
  type Article,
  type Book,
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
          {/* Falls back to the url: a page that blocked the metadata fetch is
              still worth having in the log. */}
          <span className="article-title">{article.title ?? article.url}</span>
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
