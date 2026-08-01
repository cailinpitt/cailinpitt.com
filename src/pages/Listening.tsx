import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Seo } from '../components/Seo'
import { CurlHint } from '../components/CurlHint'
import { ListenLinks } from '../components/ListenLinks'
import { Art, StatTile, TopAlbums, TopArtists, TopTracks } from '../components/ListeningBits'
import { listeningYears } from '../lib/listeningYears'
import {
  fetchBundle,
  fetchNow,
  fetchOlderDays,
  fetchOnThisDay,
  formatDayLabel,
  formatNumber,
  formatRelative,
  formatTime,
  trackQuery,
  type Bundle,
  type DayLog,
  type Heatmap,
  type NowPlaying,
  type NowState,
  type OnThisDay,
  type OnThisDayYear,
  type Scrobble,
  type StatWindow,
  type WindowKey,
} from '../lib/listening'

const POLL_MS = 60_000

/**
 * Now-playing on its own clock.
 *
 * The bundle is edge-cached for 60s and is ~116 KB of aggregates that change
 * every 15 minutes at best; now-playing changes every few minutes and is 521
 * bytes. Polling /now.json separately keeps this card as fresh as the homepage
 * bar — and because both read the same endpoint, the two cannot disagree.
 *
 * Falls back to the bundle's copy until the first response lands, so the card
 * never flashes empty, and keeps the last good value if a poll fails.
 */
function useNowPlaying(fallback: NowState | null): NowState | null {
  const [now, setNow] = useState<NowState | null>(null)

  useEffect(() => {
    let active = true
    const controller = new AbortController()
    const load = async () => {
      try {
        const data = await fetchNow(controller.signal)
        if (active) setNow(data)
      } catch {
        /* keep the last good value; the bundle still backs this up */
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

  return now ?? fallback
}

export function Component() {
  const [bundle, setBundle] = useState<Bundle | null>(null)
  const [error, setError] = useState(false)
  const [win, setWin] = useState<WindowKey>('7d')

  const nowState = useNowPlaying(
    bundle
      ? { nowPlaying: bundle.nowPlaying, lastPlayed: bundle.lastPlayed, updatedAt: bundle.updatedAt }
      : null,
  )

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
          <CurlHint command="curl listening.cailinpitt.com" />
        </header>

        {error && !bundle ? (
          <p className="listening-error">Could not load listening data right now. Try again later.</p>
        ) : !bundle ? (
          <ListeningSkeleton />
        ) : (
          <>
            <NowPlayingCard
              nowPlaying={nowState?.nowPlaying ?? null}
              lastPlayed={nowState?.lastPlayed ?? null}
            />

            <WindowStats
              windows={bundle.windows}
              active={win}
              onChange={setWin}
            />

            <HeatmapSection heatmap={bundle.heatmap} />

            <YearLinks />

            <OnThisDaySection />

            <DailyLog initialDays={bundle.recentDays} initialCursor={bundle.nextBefore} />
          </>
        )}
      </section>
    </>
  )
}

// ---- on this day ---------------------------------------------------------

/**
 * The same calendar day in previous years. Fetched separately from the bundle:
 * it changes once a day, so it rides a 1-hour edge cache rather than the
 * bundle's 60s, and a failure here must not take the rest of the page with it.
 */
function OnThisDaySection() {
  const [data, setData] = useState<OnThisDay | null>(null)

  useEffect(() => {
    let active = true
    const controller = new AbortController()
    fetchOnThisDay(controller.signal)
      .then((d) => {
        if (active) setData(d)
      })
      .catch(() => {
        /* silently absent — this is a bonus section, not load-bearing */
      })
    return () => {
      active = false
      controller.abort()
    }
  }, [])

  if (!data?.years.length) return null

  return (
    <section className="on-this-day" aria-labelledby="otd-heading">
      <h2 id="otd-heading" className="eyebrow">
        On this day
      </h2>
      <ol className="otd-list">
        {data.years.map((y) => (
          <OnThisDayYearBlock key={y.year} year={y} />
        ))}
      </ol>
    </section>
  )
}

/**
 * One past year. The API sends the day's *last* few plays, not all of them, so
 * the subset is labelled explicitly — showing 5 rows under a "91 scrobbles"
 * heading otherwise reads as though 5 were all there was.
 *
 * Expanding reuses /days: passing the newest track's uts + 1 as the cursor
 * returns that whole day, so this needs no new endpoint.
 */
function OnThisDayYearBlock({ year: y }: { year: OnThisDayYear }) {
  const [full, setFull] = useState<Scrobble[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)

  const shown = full ?? y.tracks
  const hidden = y.count - y.tracks.length

  const expand = async () => {
    if (full) {
      setFull(null)
      return
    }
    const newest = y.tracks[0]
    if (!newest) return
    setLoading(true)
    setFailed(false)
    try {
      const { days } = await fetchOlderDays(newest.uts + 1, 1)
      setFull(days[0]?.tracks ?? null)
    } catch {
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }

  return (
    <li>
      <div className="otd-head">
        <Link className="otd-year" to={`/listening/${y.year}`}>
          {y.year}
        </Link>
        <span className="otd-count">
          {formatNumber(y.count)} scrobble{y.count === 1 ? '' : 's'}
          {y.topArtist && <> · mostly {y.topArtist}</>}
        </span>
      </div>

      {hidden > 0 && (
        <p className="otd-subset">
          {full
            ? `All ${formatNumber(y.count)}, newest first`
            : `Last ${y.tracks.length} of ${formatNumber(y.count)} that day`}
        </p>
      )}

      <ul className="otd-tracks">
        {shown.map((t) => (
          <li key={`${t.uts}-${t.track}`}>
            <time dateTime={new Date(t.uts * 1000).toISOString()}>{formatTime(t.uts)}</time>
            <Art src={t.image} alt="" className="otd-art" />
            <span className="otd-meta">
              <span className="otd-track">{t.track}</span>
              <span className="otd-artist">{t.artist}</span>
            </span>
            <ListenLinks query={trackQuery(t.artist, t.track)} />
          </li>
        ))}
      </ul>

      {hidden > 0 && (
        <p className="otd-more">
          <button type="button" onClick={expand} disabled={loading}>
            {loading
              ? 'Loading…'
              : full
                ? 'Show fewer'
                : `Show all ${formatNumber(y.count)} from ${y.year} →`}
          </button>
          {failed && <span className="otd-failed">Could not load the rest.</span>}
        </p>
      )}
    </li>
  )
}

// ---- year links ----------------------------------------------------------

function YearLinks() {
  return (
    <section className="year-links" aria-labelledby="years-heading">
      <h2 id="years-heading" className="eyebrow">
        By year
      </h2>
      <nav className="year-nav">
        {listeningYears().map((y) => (
          <Link key={y} to={`/listening/${y}`}>
            {y}
          </Link>
        ))}
      </nav>
    </section>
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

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// Rows run Sunday→Saturday (buildWeeks backs the start up to a Sunday).
const DAY_NAMES = ['', 'Mon', '', 'Wed', '', 'Fri', '']

/**
 * Which week column each month label sits above. A column is a month's first
 * *full* week when its Sunday falls on the 1st–7th, so labels line up with where
 * the month visibly begins and the partial leading month stays unlabeled.
 */
function monthLabels(weeks: (HeatCell | null)[][]): { index: number; label: string }[] {
  const out: { index: number; label: string }[] = []
  let lastMonth = ''
  weeks.forEach((wk, i) => {
    const first = wk.find(Boolean)
    if (!first) return
    const d = new Date(`${first.key}T00:00:00Z`)
    const month = `${d.getUTCFullYear()}-${d.getUTCMonth()}`
    if (month !== lastMonth && d.getUTCDate() <= 7) {
      out.push({ index: i, label: MONTH_NAMES[d.getUTCMonth()] })
      lastMonth = month
    }
  })
  return out
}

function HeatmapSection({ heatmap }: { heatmap: Heatmap }) {
  const weeks = useMemo(() => buildWeeks(heatmap), [heatmap])
  const months = useMemo(() => monthLabels(weeks), [weeks])
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
        {/* Axis labels are decorative: the grid itself carries the description. */}
        <div className="heatmap-grid">
          <div className="heat-daynames" aria-hidden="true">
            {DAY_NAMES.map((name, i) => (
              <span key={i}>{name}</span>
            ))}
          </div>
          <div className="heat-plot">
            <div className="heat-months" aria-hidden="true">
              {months.map((m) => (
                <span key={m.index} style={{ '--i': m.index } as React.CSSProperties}>
                  {m.label}
                </span>
              ))}
            </div>
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
