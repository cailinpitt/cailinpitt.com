import { Link } from 'react-router-dom'
import { formatDayLabel, keyForOffset } from '../lib/datetime'
import { timelineDayPath, type TimelinePhoto, type TimelinePost } from '../lib/timeline'
import { dayEvents, useHomeTimeline } from '../lib/homeTimeline'
import type { Concert } from '../lib/concerts'

// The homepage's focal block: the last few days of the /timeline, each a link
// into that day, plus an "N years ago today" line. All client-fetched, so it
// renders a heading + skeleton on first paint and fills in.

/** Events shown per day before a "+N more" line. */
const MAX_EVENTS = 5

// Year only earns its place next to an actual date — "Today 2026" reads oddly.
function dayLabel(date: string): string {
  const relative = date === keyForOffset(0) || date === keyForOffset(-1)
  return relative ? formatDayLabel(date) : `${formatDayLabel(date)} ${date.slice(0, 4)}`
}

export function HomeTimeline({
  posts,
  photos,
  concerts,
}: {
  posts: readonly TimelinePost[]
  photos: readonly TimelinePhoto[]
  concerts: Concert[]
}) {
  const { days, onThisDay, ready } = useHomeTimeline(posts, photos, concerts)

  // A total outage leaves nothing to preview — drop the section rather than
  // sit it empty, the same call the homepage activity bars make.
  if (ready && days.length === 0 && !onThisDay) return null

  return (
    <section className="home-section home-timeline" aria-labelledby="home-timeline-heading">
      <h2 id="home-timeline-heading" className="section-title">
        Timeline
      </h2>
      <p className="home-timeline-lead">
        One row per day — music, reading, film, rides, writing, notes, and photos, woven together.
      </p>

      {onThisDay && (
        <Link className="home-timeline-otd" to={timelineDayPath(onThisDay.date)}>
          <span className="home-timeline-otd-ico" aria-hidden="true">
            📅
          </span>
          <span>
            <span className="home-timeline-otd-when">
              {onThisDay.yearsAgo === 1
                ? 'A year ago today'
                : `${onThisDay.yearsAgo} years ago today`}
            </span>
            <span className="home-timeline-otd-summary">{onThisDay.summary}</span>
          </span>
        </Link>
      )}

      {!ready ? (
        <div className="home-timeline-skeleton" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      ) : (
        <ol className="home-timeline-days">
          {days.map((day) => {
            const events = dayEvents(day)
            const shown = events.slice(0, MAX_EVENTS)
            const rest = events.length - shown.length
            return (
              <li key={day.date} className="home-timeline-day">
                <Link to={timelineDayPath(day.date)}>
                  <span className="home-timeline-date">{dayLabel(day.date)}</span>
                  <ul className="home-timeline-events">
                    {shown.map((event, i) => (
                      <li key={i} data-stream={event.stream}>
                        <span className="home-timeline-ico" aria-hidden="true">
                          {event.icon}
                        </span>
                        <span>{event.label}</span>
                      </li>
                    ))}
                  </ul>
                  {rest > 0 && <span className="home-timeline-more">+{rest} more</span>}
                </Link>
              </li>
            )
          })}
        </ol>
      )}

      <p className="more">
        <Link to="/timeline">Explore the full timeline →</Link>
      </p>
    </section>
  )
}
