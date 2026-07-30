import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Seo } from '../components/Seo'
import { ListenLinks } from '../components/ListenLinks'
import {
  albumQuery,
  fetchBundle,
  fetchOlderDays,
  formatDayLabel,
  formatNumber,
  formatRelative,
  formatTime,
  trackQuery,
  type AlbumStat,
  type ArtistStat,
  type Bundle,
  type DayLog,
  type Heatmap,
  type NowPlaying,
  type Scrobble,
  type StatWindow,
  type TrackStat,
  type WindowKey,
} from '../lib/listening'

const POLL_MS = 60_000

export function Component() {
  const [bundle, setBundle] = useState<Bundle | null>(null)
  const [error, setError] = useState(false)
  const [win, setWin] = useState<WindowKey>('7d')

  // Fetch on mount, then poll so "now playing" stays live.
  useEffect(() => {
    let active = true
    const controller = new AbortController()
    const load = async () => {
      try {
        const data = await fetchBundle(controller.signal)
        if (active) {
          setBundle(data)
          setError(false)
        }
      } catch (err) {
        if (active && (err as Error).name !== 'AbortError') setError(true)
      }
    }
    void load()
    const id = setInterval(load, POLL_MS)
    return () => {
      active = false
      controller.abort()
      clearInterval(id)
    }
  }, [])

  return (
    <>
      <Seo
        title="Listening"
        description="What Cailin Pitt is listening to right now, plus recent scrobbles and stats from Last.fm."
        path="/listening"
      />
      <section className="listening">
        <header className="listening-header">
          <h1>Listening</h1>
          <p className="lead">
            {bundle
              ? `${formatNumber(bundle.totalScrobbles)} scrobbles and counting, tracked via Last.fm.`
              : 'What I have on, tracked via Last.fm.'}
          </p>
        </header>

        {error && !bundle ? (
          <p className="listening-error">Could not load listening data right now. Try again later.</p>
        ) : !bundle ? (
          <ListeningSkeleton />
        ) : (
          <>
            <NowPlayingCard nowPlaying={bundle.nowPlaying} lastPlayed={bundle.lastPlayed} />

            <WindowStats
              windows={bundle.windows}
              active={win}
              onChange={setWin}
            />

            <HeatmapSection heatmap={bundle.heatmap} />

            <DailyLog initialDays={bundle.recentDays} initialCursor={bundle.nextBefore} />
          </>
        )}
      </section>
    </>
  )
}

// ---- now playing ---------------------------------------------------------

function NowPlayingCard({
  nowPlaying,
  lastPlayed,
}: {
  nowPlaying: NowPlaying | null
  lastPlayed: Scrobble | null
}) {
  const live = Boolean(nowPlaying)
  const track = nowPlaying ?? lastPlayed
  if (!track) return null

  return (
    <section className="now-playing" aria-labelledby="now-heading">
      <h2 id="now-heading" className="eyebrow">
        {live ? (
          <>
            <span className="now-dot" aria-hidden="true" /> Now playing
          </>
        ) : (
          'Last played'
        )}
      </h2>
      <div className="now-card">
        <Art src={track.image} alt="" className="now-art" />
        <div className="now-meta">
          <p className="now-track">{track.track}</p>
          <p className="now-artist">{track.artist}</p>
          {track.album && <p className="now-album">{track.album}</p>}
          {!live && lastPlayed && (
            <p className="now-when">{formatRelative(lastPlayed.uts)}</p>
          )}
          <ListenLinks query={trackQuery(track.artist, track.track)} className="now-listen" />
        </div>
      </div>
    </section>
  )
}

// ---- windowed stats (7d / 30d) -------------------------------------------

function WindowStats({
  windows,
  active,
  onChange,
}: {
  windows: Record<WindowKey, StatWindow>
  active: WindowKey
  onChange: (w: WindowKey) => void
}) {
  const stats = windows[active]
  return (
    <section className="stats" aria-labelledby="stats-heading">
      <div className="stats-head">
        <h2 id="stats-heading" className="eyebrow">
          Stats
        </h2>
        <div className="segmented" role="tablist" aria-label="Stats window">
          {(['7d', '30d'] as WindowKey[]).map((key) => (
            <button
              key={key}
              role="tab"
              aria-selected={active === key}
              className={active === key ? 'active' : undefined}
              onClick={() => onChange(key)}
            >
              {key === '7d' ? '7 days' : '30 days'}
            </button>
          ))}
        </div>
      </div>

      <dl className="stat-tiles">
        <StatTile label="Scrobbles" value={stats.scrobbles} />
        <StatTile label="Artists" value={stats.artists} />
        <StatTile label="Albums" value={stats.albums} />
        <StatTile label="Tracks" value={stats.tracks} />
        <StatTile label="Per day" value={stats.perDay} />
      </dl>

      <div className="top-grid">
        <TopArtists artists={stats.topArtists} />
        <TopAlbums albums={stats.topAlbums} />
        <TopTracks tracks={stats.topTracks} />
      </div>
    </section>
  )
}

function StatTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="stat-tile">
      <dt>{label}</dt>
      <dd>{formatNumber(value)}</dd>
    </div>
  )
}

// Single-series magnitude → horizontal bars in the accent hue, baseline-anchored,
// counts direct-labeled (no legend needed for one series).
function TopArtists({ artists }: { artists: ArtistStat[] }) {
  const max = artists[0]?.count ?? 1
  return (
    <div className="top-block">
      <h3 className="top-title">Top artists</h3>
      <ol className="bar-list">
        {artists.map((a) => (
          <li key={a.name}>
            <span className="bar-label">{a.name}</span>
            <span className="bar-track" aria-hidden="true">
              <span className="bar-fill" style={{ width: `${(a.count / max) * 100}%` }} />
            </span>
            <span className="bar-value">{formatNumber(a.count)}</span>
          </li>
        ))}
      </ol>
    </div>
  )
}

function TopAlbums({ albums }: { albums: AlbumStat[] }) {
  return (
    <div className="top-block">
      <h3 className="top-title">Top albums</h3>
      <ol className="rank-list">
        {albums.map((a) => (
          <li key={`${a.album}—${a.artist}`}>
            <Art src={a.image} alt="" className="rank-art" />
            <span className="rank-meta">
              <span className="rank-primary">{a.album}</span>
              <span className="rank-secondary">{a.artist}</span>
            </span>
            <span className="rank-count">{formatNumber(a.count)}</span>
            <ListenLinks query={albumQuery(a.artist, a.album)} />
          </li>
        ))}
      </ol>
    </div>
  )
}

function TopTracks({ tracks }: { tracks: TrackStat[] }) {
  return (
    <div className="top-block">
      <h3 className="top-title">Top tracks</h3>
      <ol className="rank-list">
        {tracks.map((t) => (
          <li key={`${t.track}—${t.artist}`}>
            <Art src={t.image} alt="" className="rank-art" />
            <span className="rank-meta">
              <span className="rank-primary">{t.track}</span>
              <span className="rank-secondary">{t.artist}</span>
            </span>
            <span className="rank-count">{formatNumber(t.count)}</span>
            <ListenLinks query={trackQuery(t.artist, t.track)} />
          </li>
        ))}
      </ol>
    </div>
  )
}

// ---- heatmap -------------------------------------------------------------

interface HeatCell {
  key: string
  count: number
  level: 0 | 1 | 2 | 3 | 4
}

function level(count: number, max: number): HeatCell['level'] {
  if (count <= 0 || max <= 0) return 0
  const r = count / max
  if (r > 0.75) return 4
  if (r > 0.5) return 3
  if (r > 0.25) return 2
  return 1
}

function buildWeeks(hm: Heatmap): (HeatCell | null)[][] {
  const max = Object.values(hm.days).reduce((m, v) => (v > m ? v : m), 0)
  const start = new Date(`${hm.from}T00:00:00Z`)
  start.setUTCDate(start.getUTCDate() - start.getUTCDay()) // back up to Sunday
  const end = new Date(`${hm.to}T00:00:00Z`)

  const weeks: (HeatCell | null)[][] = []
  let week: (HeatCell | null)[] = []
  for (const d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const key = d.toISOString().slice(0, 10)
    const count = hm.days[key] ?? 0
    week.push({ key, count, level: level(count, max) })
    if (week.length === 7) {
      weeks.push(week)
      week = []
    }
  }
  if (week.length) {
    while (week.length < 7) week.push(null)
    weeks.push(week)
  }
  return weeks
}

function HeatmapSection({ heatmap }: { heatmap: Heatmap }) {
  const weeks = useMemo(() => buildWeeks(heatmap), [heatmap])
  const total = useMemo(
    () => Object.values(heatmap.days).reduce((s, v) => s + v, 0),
    [heatmap],
  )
  return (
    <section className="heatmap-section" aria-labelledby="heatmap-heading">
      <h2 id="heatmap-heading" className="eyebrow">
        Past year · {formatNumber(total)} scrobbles
      </h2>
      <div className="heatmap-scroll">
        <div className="heatmap" role="img" aria-label={`Daily listening over the past year, ${formatNumber(total)} scrobbles`}>
          {weeks.map((wk, i) => (
            <div className="heat-col" key={i}>
              {wk.map((cell, j) =>
                cell ? (
                  <div
                    key={cell.key}
                    className={`heat-cell l${cell.level}`}
                    title={`${cell.key}: ${cell.count} play${cell.count === 1 ? '' : 's'}`}
                  />
                ) : (
                  <div key={j} className="heat-cell empty" />
                ),
              )}
            </div>
          ))}
        </div>
      </div>
      <div className="heat-legend" aria-hidden="true">
        <span>Less</span>
        <span className="heat-cell l0" />
        <span className="heat-cell l1" />
        <span className="heat-cell l2" />
        <span className="heat-cell l3" />
        <span className="heat-cell l4" />
        <span>More</span>
      </div>
    </section>
  )
}

// ---- daily log -----------------------------------------------------------

function DailyLog({
  initialDays,
  initialCursor,
}: {
  initialDays: DayLog[]
  initialCursor: number | null
}) {
  const [days, setDays] = useState<DayLog[]>(initialDays)
  const [cursor, setCursor] = useState<number | null>(initialCursor)
  const [loading, setLoading] = useState(false)
  const controllerRef = useRef<AbortController | null>(null)

  useEffect(() => {
    setDays(initialDays)
    setCursor(initialCursor)
  }, [initialDays, initialCursor])

  const loadMore = useCallback(async () => {
    if (cursor == null || loading) return
    setLoading(true)
    controllerRef.current = new AbortController()
    try {
      const { days: older, nextBefore } = await fetchOlderDays(cursor, 5, controllerRef.current.signal)
      setDays((prev) => mergeDays(prev, older))
      setCursor(nextBefore)
    } catch (err) {
      if ((err as Error).name !== 'AbortError') setCursor(null)
    } finally {
      setLoading(false)
    }
  }, [cursor, loading])

  useEffect(() => () => controllerRef.current?.abort(), [])

  return (
    <section className="log" aria-labelledby="log-heading">
      <h2 id="log-heading" className="eyebrow">
        Log
      </h2>
      {days.map((day) => (
        <div className="log-day" key={day.date}>
          <div className="log-day-head">
            <h3>{formatDayLabel(day.date)}</h3>
            <span className="log-day-count">{formatNumber(day.count)} scrobbles</span>
          </div>
          <ol className="log-tracks">
            {day.tracks.map((t) => (
              <li key={`${t.uts}-${t.track}`}>
                <time dateTime={new Date(t.uts * 1000).toISOString()}>{formatTime(t.uts)}</time>
                <Art src={t.image} alt="" className="log-art" />
                <span className="log-main">
                  <span className="log-track">{t.track}</span>
                  <span className="log-artist">{t.artist}</span>
                </span>
                <ListenLinks query={trackQuery(t.artist, t.track)} />
              </li>
            ))}
          </ol>
        </div>
      ))}
      {cursor != null && (
        <button className="load-more" onClick={loadMore} disabled={loading}>
          {loading ? 'Loading…' : 'Load older days'}
        </button>
      )}
    </section>
  )
}

// Append older days, merging into a same-dated tail day if the page split it.
function mergeDays(existing: DayLog[], older: DayLog[]): DayLog[] {
  if (!older.length) return existing
  const merged = [...existing]
  const last = merged[merged.length - 1]
  if (last && older[0] && last.date === older[0].date) {
    merged[merged.length - 1] = {
      ...last,
      count: last.count + older[0].count,
      tracks: [...last.tracks, ...older[0].tracks],
    }
    return [...merged, ...older.slice(1)]
  }
  return [...merged, ...older]
}

// ---- shared bits ---------------------------------------------------------

function Art({ src, alt, className }: { src: string | null; alt: string; className: string }) {
  if (!src) return <span className={`${className} art-placeholder`} aria-hidden="true" />
  return <img src={src} alt={alt} className={className} loading="lazy" decoding="async" />
}

function ListeningSkeleton() {
  return (
    <div className="listening-skeleton" aria-hidden="true">
      <div className="sk-card" />
      <div className="sk-tiles">
        {Array.from({ length: 5 }).map((_, i) => (
          <div className="sk-tile" key={i} />
        ))}
      </div>
      <div className="sk-block" />
    </div>
  )
}
