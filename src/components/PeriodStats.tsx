// The sections of a period view. Each one renders nothing when its data is
// absent, so a blob computed by an older Worker — or all-time, which genuinely
// has no obsession or curios — degrades to fewer sections instead of blank space.

import { Link } from 'react-router-dom'
import { Art } from './ListeningBits'
import { ListenLinks } from './ListenLinks'
import {
  albumQuery,
  formatNumber,
  formatTime,
  trackQuery,
  type PeriodStats,
  type RankedAlbum,
  type RankedArtist,
  type RankedTrack,
  type SeriesPoint,
} from '../lib/listening'

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

/** 13:00 → "1pm". Hour labels are read at a glance, so keep them short. */
function hourLabel(hour: number): string {
  if (hour === 0) return '12am'
  if (hour === 12) return '12pm'
  return hour < 12 ? `${hour}am` : `${hour - 12}pm`
}

function Delta({ value }: { value: number | null }) {
  if (value === null || value === 0) return null
  const up = value > 0
  return (
    <span className={`delta ${up ? 'up' : 'down'}`}>
      {up ? '▲' : '▼'} {Math.abs(value)}%
    </span>
  )
}

export function Headline({ stats }: { stats: PeriodStats }) {
  const tiles: { label: string; value: string; delta: number | null }[] = [
    { label: 'Scrobbles', value: formatNumber(stats.scrobbles), delta: stats.delta.scrobbles },
    { label: 'Artists', value: formatNumber(stats.artists), delta: stats.delta.artists },
    { label: 'Albums', value: formatNumber(stats.albums), delta: null },
    { label: 'Tracks', value: formatNumber(stats.tracks), delta: stats.delta.tracks },
    { label: 'Per day', value: String(stats.perDay), delta: stats.delta.perDay },
    { label: 'Active days', value: `${stats.activeDays}`, delta: null },
  ]
  return (
    <dl className="period-tiles">
      {tiles.map((t) => (
        <div key={t.label}>
          <dt>{t.label}</dt>
          <dd>
            {t.value}
            <Delta value={t.delta} />
          </dd>
        </div>
      ))}
    </dl>
  )
}

/** Rank movement against the previous period. */
function Movement({ rank, prevRank }: { rank: number; prevRank: number | null }) {
  if (prevRank === null) return <span className="move new">new</span>
  const diff = prevRank - rank
  if (diff === 0) return <span className="move flat">–</span>
  return (
    <span className={`move ${diff > 0 ? 'up' : 'down'}`}>
      {diff > 0 ? '▲' : '▼'}
      {Math.abs(diff)}
    </span>
  )
}

function Bar({ share }: { share: number }) {
  return <span className="rank-bar" style={{ '--share': `${share}%` } as React.CSSProperties} />
}

export function Leaderboards({ stats }: { stats: PeriodStats }) {
  const { artists, albums, tracks } = stats.top
  if (!artists.length) return null
  return (
    <section className="period-tops" aria-labelledby="tops-heading">
      <h2 id="tops-heading" className="eyebrow">
        Most played
      </h2>
      <div className="tops-grid">
        <TopArtistList artists={artists} />
        <TopAlbumList albums={albums} />
        <TopTrackList tracks={tracks} />
      </div>
    </section>
  )
}

function TopArtistList({ artists }: { artists: RankedArtist[] }) {
  return (
    <div className="top-col">
      <h3>Artists</h3>
      <ol className="rank-list">
        {artists.map((a, i) => (
          <li key={a.name}>
            <span className="rank-n">{i + 1}</span>
            <Art src={a.image} alt="" className="rank-art" />
            <span className="rank-main">
              <span className="rank-name">{a.name}</span>
              <Bar share={a.share} />
            </span>
            <span className="rank-count">
              {formatNumber(a.count)}
              <Movement rank={i + 1} prevRank={a.prevRank} />
            </span>
          </li>
        ))}
      </ol>
    </div>
  )
}

function TopAlbumList({ albums }: { albums: RankedAlbum[] }) {
  return (
    <div className="top-col">
      <h3>Albums</h3>
      <ol className="rank-list">
        {albums.map((a, i) => (
          <li key={`${a.album}-${a.artist}`}>
            <span className="rank-n">{i + 1}</span>
            <Art src={a.image} alt="" className="rank-art" />
            <span className="rank-main">
              <span className="rank-name">{a.album}</span>
              <span className="rank-sub">{a.artist}</span>
              <Bar share={a.share} />
            </span>
            <span className="rank-count">
              {formatNumber(a.count)}
              <Movement rank={i + 1} prevRank={a.prevRank} />
            </span>
            <ListenLinks query={albumQuery(a.artist, a.album)} />
          </li>
        ))}
      </ol>
    </div>
  )
}

function TopTrackList({ tracks }: { tracks: RankedTrack[] }) {
  return (
    <div className="top-col">
      <h3>Tracks</h3>
      <ol className="rank-list">
        {tracks.map((t, i) => (
          <li key={`${t.track}-${t.artist}`}>
            <span className="rank-n">{i + 1}</span>
            <Art src={t.image} alt="" className="rank-art" />
            <span className="rank-main">
              <span className="rank-name">{t.track}</span>
              <span className="rank-sub">{t.artist}</span>
              <Bar share={t.share} />
            </span>
            <span className="rank-count">
              {formatNumber(t.count)}
              <Movement rank={i + 1} prevRank={t.prevRank} />
            </span>
            <ListenLinks query={trackQuery(t.artist, t.track)} />
          </li>
        ))}
      </ol>
    </div>
  )
}

// ---- when the listening happened -----------------------------------------

/**
 * The "when" section: hour of day, day of week, and the two crossed.
 *
 * All three come from the same 168-cell grid the Worker ships, so they can never
 * disagree with each other.
 */
export function WhenSection({ stats }: { stats: PeriodStats }) {
  if (!stats.scrobbles) return null
  const maxHour = Math.max(...stats.clock, 1)
  const maxDay = Math.max(...stats.weekdays, 1)
  const maxCell = Math.max(...stats.grid, 1)

  return (
    <section className="period-when" aria-labelledby="when-heading">
      <h2 id="when-heading" className="eyebrow">
        When I listen
      </h2>

      <div className="when-summary">
        {stats.peakHour !== null && (
          <p>
            Peak hour <strong>{hourLabel(stats.peakHour)}</strong>
          </p>
        )}
        {stats.peakWeekday !== null && (
          <p>
            Busiest day <strong>{WEEKDAYS[stats.peakWeekday]}</strong>
          </p>
        )}
        <p>
          Weekend <strong>{stats.weekendShare}%</strong>
        </p>
        <p>
          After midnight <strong>{stats.lateNightShare}%</strong>
        </p>
      </div>

      <div className="when-charts">
        <figure className="clock-chart">
          <figcaption>By hour</figcaption>
          <div className="clock-bars" role="img" aria-label="Scrobbles by hour of day">
            {stats.clock.map((count, hour) => (
              <div className="clock-col" key={hour} title={`${hourLabel(hour)}: ${count}`}>
                <span
                  className="clock-bar"
                  style={{ '--h': `${(count / maxHour) * 100}%` } as React.CSSProperties}
                />
                {hour % 6 === 0 && <span className="clock-tick">{hourLabel(hour)}</span>}
              </div>
            ))}
          </div>
        </figure>

        <figure className="weekday-chart">
          <figcaption>By day</figcaption>
          <div className="weekday-bars" role="img" aria-label="Scrobbles by day of week">
            {stats.weekdays.map((count, i) => (
              <div className="weekday-row" key={i}>
                <span className="weekday-label">{WEEKDAYS[i]}</span>
                <span
                  className="weekday-bar"
                  style={{ '--w': `${(count / maxDay) * 100}%` } as React.CSSProperties}
                />
                <span className="weekday-count">{formatNumber(count)}</span>
              </div>
            ))}
          </div>
        </figure>
      </div>

      <figure className="when-grid">
        <figcaption>Hour by day</figcaption>
        <div className="grid-plot" role="img" aria-label="Scrobbles by hour and day of week">
          {WEEKDAYS.map((day, d) => (
            <div className="grid-row" key={day}>
              <span className="grid-day">{day}</span>
              {Array.from({ length: 24 }, (_, h) => {
                const count = stats.grid[d * 24 + h] ?? 0
                return (
                  <span
                    key={h}
                    className="grid-cell"
                    style={{ '--v': count / maxCell } as React.CSSProperties}
                    title={`${day} ${hourLabel(h)}: ${count}`}
                  />
                )
              })}
            </div>
          ))}
          <div className="grid-row grid-axis" aria-hidden="true">
            <span className="grid-day" />
            {Array.from({ length: 24 }, (_, h) => (
              <span className="grid-tick" key={h}>
                {h % 6 === 0 ? hourLabel(h).replace(/[ap]m/, '') : ''}
              </span>
            ))}
          </div>
        </div>
      </figure>
    </section>
  )
}

// ---- trend ---------------------------------------------------------------

export function TrendSection({ series, label }: { series: SeriesPoint[]; label: string }) {
  if (!series.length) return null
  const max = Math.max(...series.map((p) => p.count), 1)
  return (
    <section className="period-trend" aria-labelledby="trend-heading">
      <h2 id="trend-heading" className="eyebrow">
        {label}
      </h2>
      <div className="trend-bars" role="img" aria-label={label}>
        {series.map((p) => (
          <div className="trend-col" key={p.key} title={`${p.label}: ${formatNumber(p.count)}`}>
            <span
              className="trend-bar"
              style={{ '--h': `${(p.count / max) * 100}%` } as React.CSSProperties}
            />
            <span className="trend-label">{p.label}</span>
          </div>
        ))}
      </div>
    </section>
  )
}

// ---- discovery -----------------------------------------------------------

export function DiscoverySection({ stats }: { stats: PeriodStats }) {
  const d = stats.discovery
  if (!d.artists && !d.tracks && !stats.abandoned.length) return null
  return (
    <section className="period-discovery" aria-labelledby="discovery-heading">
      <h2 id="discovery-heading" className="eyebrow">
        Discovery
      </h2>
      <dl className="period-tiles compact">
        <div>
          <dt>New artists</dt>
          <dd>{formatNumber(d.artists)}</dd>
        </div>
        <div>
          <dt>New albums</dt>
          <dd>{formatNumber(d.albums)}</dd>
        </div>
        <div>
          <dt>New tracks</dt>
          <dd>{formatNumber(d.tracks)}</dd>
        </div>
        <div>
          <dt>Fresh</dt>
          <dd>{d.rate}%</dd>
        </div>
      </dl>

      {d.newArtists.length > 0 && (
        <div className="discovery-list">
          <h3>First heard this {kindWord(stats.kind)}</h3>
          <ul className="chip-list">
            {d.newArtists.slice(0, 24).map((a) => (
              <li key={a.name}>{a.name}</li>
            ))}
          </ul>
        </div>
      )}

      {stats.abandoned.length > 0 && (
        <div className="discovery-list">
          <h3>Dropped off</h3>
          <p className="muted-note">Top artists last {kindWord(stats.kind)}, unplayed this one.</p>
          <ul className="chip-list muted">
            {stats.abandoned.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

const kindWord = (kind: PeriodStats['kind']) =>
  kind === 'w' ? 'week' : kind === 'm' ? 'month' : kind === 'y' ? 'year' : 'period'

// ---- habits --------------------------------------------------------------

export function HabitsSection({ stats }: { stats: PeriodStats }) {
  if (!stats.scrobbles) return null
  const { sessions, streaks, loyalty } = stats
  return (
    <section className="period-habits" aria-labelledby="habits-heading">
      <h2 id="habits-heading" className="eyebrow">
        Habits
      </h2>
      <dl className="period-tiles compact">
        <div>
          <dt>Sessions</dt>
          <dd>{formatNumber(sessions.count)}</dd>
        </div>
        <div>
          <dt>Tracks per session</dt>
          <dd>{sessions.avgTracks}</dd>
        </div>
        <div>
          <dt>Longest streak</dt>
          <dd>{streaks.longest}d</dd>
        </div>
        <div>
          <dt>Repeat rate</dt>
          <dd>{loyalty.repeatRate}×</dd>
        </div>
        <div>
          <dt>Top 10 share</dt>
          <dd>{loyalty.top10Share}%</dd>
        </div>
        {loyalty.effectiveArtists > 0 && (
          <div>
            <dt>Felt like</dt>
            <dd>{loyalty.effectiveArtists} artists</dd>
          </div>
        )}
      </dl>

      <ul className="habit-notes">
        {loyalty.obsession && loyalty.obsession.count > 2 && (
          <li>
            Most obsessive day: <strong>{loyalty.obsession.track}</strong> by{' '}
            {loyalty.obsession.artist}, {loyalty.obsession.count}× on {loyalty.obsession.date}.
          </li>
        )}
        {sessions.longest && (
          <li>
            Longest sitting: <strong>{sessions.longest.tracks} tracks</strong> starting{' '}
            {formatTime(sessions.longest.start)}
            {sessions.longest.topArtist && <> — mostly {sessions.longest.topArtist}</>}.
          </li>
        )}
        {stats.busiestDay && (
          <li>
            Busiest day: <strong>{formatNumber(stats.busiestDay.count)}</strong> on{' '}
            {stats.busiestDay.date}.
          </li>
        )}
        {stats.albumListens[0] && (
          <li>
            Played front to back: <strong>{stats.albumListens[0].album}</strong> by{' '}
            {stats.albumListens[0].artist} ({stats.albumListens[0].distinct} tracks in a row).
          </li>
        )}
        {stats.binges[0] && (
          <li>
            Longest run on one artist: <strong>{stats.binges[0].artist}</strong>,{' '}
            {stats.binges[0].tracks} plays back to back.
          </li>
        )}
        {stats.streaks.longestSilence > 1 && (
          <li>Longest silence: {stats.streaks.longestSilence} days with nothing played.</li>
        )}
      </ul>
    </section>
  )
}

// ---- milestones and curios -----------------------------------------------

export function MilestonesSection({ stats }: { stats: PeriodStats }) {
  const { milestones, curios } = stats
  const hasCurios = curios.remix + curios.live + curios.acoustic + curios.collab > 0
  if (!milestones.length && !hasCurios) return null

  return (
    <section className="period-extras" aria-labelledby="extras-heading">
      <h2 id="extras-heading" className="eyebrow">
        Odds and ends
      </h2>
      {milestones.length > 0 && (
        <ul className="habit-notes">
          {milestones.map((m) => (
            <li key={m.n}>
              Scrobble <strong>{formatNumber(m.n)}</strong> was {m.track} by {m.artist}.
            </li>
          ))}
        </ul>
      )}
      {hasCurios && (
        <ul className="chip-list">
          {curios.live > 0 && <li>{formatNumber(curios.live)} live</li>}
          {curios.remix > 0 && <li>{formatNumber(curios.remix)} remixes</li>}
          {curios.acoustic > 0 && <li>{formatNumber(curios.acoustic)} acoustic</li>}
          {curios.collab > 0 && <li>{formatNumber(curios.collab)} collaborations</li>}
        </ul>
      )}
    </section>
  )
}

/** Bookends: the first and last thing played in the period. */
export function BookendsSection({ stats }: { stats: PeriodStats }) {
  if (!stats.first || !stats.last) return null
  return (
    <section className="period-bookends" aria-labelledby="bookends-heading">
      <h2 id="bookends-heading" className="eyebrow">
        Bookends
      </h2>
      <div className="bookends">
        {[
          { tag: 'First', row: stats.first },
          { tag: 'Last', row: stats.last },
        ].map(({ tag, row }) => (
          <div className="bookend" key={tag}>
            <span className="bookend-tag">{tag}</span>
            <Art src={row.image} alt="" className="bookend-art" />
            <span className="bookend-meta">
              <span className="bookend-track">{row.track}</span>
              <span className="bookend-artist">{row.artist}</span>
            </span>
          </div>
        ))}
      </div>
    </section>
  )
}

/** Link out to the same period one granularity up. */
export function ZoomOut({ kind, keyName }: { kind: PeriodStats['kind']; keyName: string }) {
  if (kind === 'y' || kind === 'all') return null
  const year = keyName.slice(0, 4)
  return (
    <p className="zoom-out">
      <Link to={`/listening/${year}`}>See all of {year} →</Link>
    </p>
  )
}
