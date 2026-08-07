// Tier A aggregation: everything derivable from timestamps and text alone.
//
// This runs on the cron, never on a request — a year is ~18,700 rows and the
// free plan allows 10 ms of CPU per fetch invocation. One pass over the rows
// fills every counter; nothing here re-reads the input.

import type { Scrobble } from './lastfm'
import { dayKey, hourOf, weekdayOf, type Period } from './periods'

const DAY = 86_400

/** How many rows each leaderboard carries. Deep enough to scroll, small enough to ship. */
const TOP_N = 25

/** A gap longer than this ends a listening session. */
const SESSION_GAP = 30 * 60

/** A run of consecutive plays from one album this long reads as a deliberate album listen. */
const ALBUM_RUN_MIN = 6

/** A run of consecutive plays from one artist this long reads as a binge. */
const BINGE_MIN = 5

/** Milestones are celebrated every this many scrobbles. */
const MILESTONE_STEP = 5_000

/** Hours counted as "late night" for the night-owl index. */
const LATE_NIGHT = [0, 1, 2, 3, 4]

export interface RankedArtist {
  name: string
  count: number
  share: number
  image: string | null
  /** Rank in the previous period, or null if absent from it. */
  prevRank: number | null
}
export interface RankedAlbum extends Omit<RankedArtist, 'name'> {
  album: string
  artist: string
}
export interface RankedTrack extends Omit<RankedArtist, 'name'> {
  track: string
  artist: string
}

export interface SeriesPoint {
  key: string
  label: string
  count: number
}

export interface Session {
  start: number
  end: number
  tracks: number
  topArtist: string | null
}

export interface Run {
  artist: string
  album?: string
  start: number
  tracks: number
  distinct: number
}

export interface Milestone {
  n: number
  uts: number
  track: string
  artist: string
}

export interface Delta {
  scrobbles: number | null
  artists: number | null
  tracks: number | null
  perDay: number | null
}

export interface PeriodStats {
  kind: Period['kind']
  key: string
  label: string
  start: number
  end: number
  complete: boolean
  computedAt: number

  scrobbles: number
  artists: number
  albums: number
  tracks: number
  perDay: number
  activeDays: number
  silentDays: number

  top: { artists: RankedArtist[]; albums: RankedAlbum[]; tracks: RankedTrack[] }

  /** When the listening happened. */
  clock: number[] // 24
  weekdays: number[] // 7, Monday first
  grid: number[] // 168, weekday * 24 + hour
  peakHour: number | null
  quietestHour: number | null
  peakWeekday: number | null
  weekendShare: number
  lateNightShare: number

  series: SeriesPoint[]
  busiestDay: { date: string; count: number } | null
  busiestHour: { hour: number; count: number } | null

  streaks: { longest: number; longestSilence: number }
  sessions: { count: number; avgTracks: number; longest: Session | null }
  binges: Run[]
  albumListens: Run[]

  loyalty: {
    repeatRate: number
    top10Share: number
    /** Inverse-Simpson effective artist count: how many artists it "feels like". */
    effectiveArtists: number
    obsession: { track: string; artist: string; count: number; date: string } | null
  }

  curios: {
    remix: number
    live: number
    acoustic: number
    collab: number
    longestTitle: { track: string; artist: string } | null
  }

  /** Tier B. Empty until enrichment has run. */
  genres: { name: string; count: number; share: number }[]
  /** Genres whose first-ever play in the archive falls in this period. */
  newGenres: string[]
  /** Inverse-Simpson over genres: how many genres it "felt like". */
  genreDiversity: number
  /** Share by genre per series bucket, for the stacked trend. */
  genreSeries: { key: string; label: string; genres: Record<string, number> }[]
  /** Share of scrobbles whose artist has a known genre. */
  genreCoverage: number

  /** Tier D. Empty until MusicBrainz enrichment has run. */
  origins: {
    countries: { code: string; count: number; share: number }[]
    /** Plays by the decade the artist began, oldest first. */
    decades: { decade: number; count: number; share: number }[]
    groupShare: number
    soloShare: number
    /** Share of plays whose artist has a known country. */
    coverage: number
  }

  /** Tier C. Zeroed until durations have been enriched. */
  listening: {
    seconds: number
    /** Share of scrobbles with a known duration — the rest are extrapolated. */
    coverage: number
    avgTrackSeconds: number
    /** Artists ranked by time rather than play count; the two disagree usefully. */
    topByTime: { name: string; seconds: number }[]
    longest: { track: string; artist: string; seconds: number } | null
  }

  /**
   * Tier F: what was playing during a logged activity. Empty when the moving
   * Worker has nothing for the period, or couldn't be reached.
   */
  moving: {
    plays: number
    /** Share of the period's scrobbles that happened mid-activity. */
    share: number
    activities: number
    /** Plays by activity kind — ride, lift, run… */
    byKind: { kind: string; count: number }[]
    topArtists: { name: string; count: number }[]
    topTracks: { track: string; artist: string; count: number }[]
  }

  milestones: Milestone[]
  first: Scrobble | null
  last: Scrobble | null

  /** Filled in by the caller from the summary tables. */
  discovery: {
    artists: number
    albums: number
    tracks: number
    rate: number
    newArtists: { name: string; uts: number }[]
    /** Artists back after a year or more away. Filled by the caller. */
    returning: { name: string; gapDays: number }[]
  }
  /** Top artists of the previous period with no plays at all in this one. */
  abandoned: string[]
  delta: Delta
}

interface Counter<T> {
  count: number
  image: string | null
  label: string
  row: T
}

function bump<T>(
  map: Map<string, Counter<T>>,
  key: string,
  label: string,
  row: T,
  image: string | null,
): void {
  const hit = map.get(key)
  if (!hit) {
    map.set(key, { count: 1, image, label, row })
    return
  }
  hit.count++
  // Keep the largest art seen, so a play with no cover doesn't blank the entry.
  if (image && (!hit.image || image > hit.image)) hit.image = image
}

function rank<T>(map: Map<string, Counter<T>>, total: number): (T & {
  count: number
  share: number
  image: string | null
})[] {
  return [...map.values()]
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, TOP_N)
    .map((e) => ({
      ...e.row,
      count: e.count,
      share: total ? Math.round((e.count / total) * 1000) / 10 : 0,
      image: e.image,
    }))
}

const REMIX = /\b(remix|rmx|edit|bootleg)\b/i
const LIVE = /\b(live|unplugged)\b|\(live\b/i
const ACOUSTIC = /\bacoustic\b/i
const COLLAB = /\b(feat\.?|ft\.?|featuring|with)\b|\s&\s|\svs\.?\s|,\s/i

/** Key separator. Unit Separator can't appear in a track or artist name. */
const SEP = '\u001f'

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export { WEEKDAY_LABELS, MONTH_LABELS }

/** Every day key in [start, end), capped at the period's own end or now. */
function daySpan(period: Period, now: number, offset: number): string[] {
  const stop = Math.min(period.end, now)
  const out: string[] = []
  for (let t = period.start; t < stop && out.length < 400; t += DAY) out.push(dayKey(t, offset))
  return out
}

/**
 * Build the trend series. Weeks and months plot days; a year plots months;
 * all-time plots years — so the shape stays readable at every granularity.
 */
function buildSeries(
  period: Period,
  byDay: Map<string, number>,
  now: number,
  offset: number,
): SeriesPoint[] {
  if (period.kind === 'y' || period.kind === 'all') {
    const byBucket = new Map<string, number>()
    for (const [day, count] of byDay) {
      const bucket = period.kind === 'y' ? day.slice(0, 7) : day.slice(0, 4)
      byBucket.set(bucket, (byBucket.get(bucket) ?? 0) + count)
    }
    if (period.kind === 'all') {
      return [...byBucket.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([key, count]) => ({ key, label: key, count }))
    }
    // A year always shows twelve slots, so a silent month reads as silence.
    const year = period.key
    return MONTH_LABELS.map((label, i) => {
      const key = `${year}-${String(i + 1).padStart(2, '0')}`
      return { key, label, count: byBucket.get(key) ?? 0 }
    })
  }

  return daySpan(period, now, offset).map((day) => ({
    key: day,
    label: period.kind === 'w' ? WEEKDAY_LABELS[(new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7] : day.slice(8),
    count: byDay.get(day) ?? 0,
  }))
}

export interface AggregateInput {
  /** Rows inside the period, ascending by uts. */
  rows: Scrobble[]
  period: Period
  offset: number
  now: number
  /** Total scrobbles strictly before the period, for milestone numbering. */
  playsBefore: number
  previous?: PeriodStats | null
  /** artist → canonical genre. Absent before enrichment has run. */
  genreOf?: Record<string, string>
  /** `${track}${SEP}${artist}` → seconds. Absent before enrichment has run. */
  durationOf?: Record<string, number>
  /** artist → {c: country, k: kind, y: year formed}. Absent before enrichment. */
  originOf?: Record<string, { c: string | null; k: string | null; y: number | null }>
  /** Activity windows overlapping the period. */
  windows?: { id: string; kind: string; startedAt: number; elapsedTime: number }[]
}

/** How many genres a period reports. Beyond this the tail is all sub-1% slices. */
const GENRE_N = 12

/** Genres tracked per bucket in the stacked trend. */
const GENRE_SERIES_N = 6

export function aggregate(input: AggregateInput): PeriodStats {
  const { rows, period, offset, now, playsBefore, previous } = input
  const genreOf = input.genreOf ?? {}
  const durationOf = input.durationOf ?? {}

  const originOf = input.originOf ?? {}
  const countryCounts = new Map<string, number>()
  const decadeCounts = new Map<number, number>()
  let knownCountryPlays = 0
  let groupPlays = 0
  let soloPlays = 0

  const genreCounts = new Map<string, number>()
  const genreByBucket = new Map<string, Map<string, number>>()
  const secondsByArtist = new Map<string, number>()
  let knownGenrePlays = 0
  let knownDurationPlays = 0
  let knownSeconds = 0
  let longestTrack: { track: string; artist: string; seconds: number } | null = null

  const artists = new Map<string, Counter<{ name: string }>>()
  const albums = new Map<string, Counter<{ album: string; artist: string }>>()
  const tracks = new Map<string, Counter<{ track: string; artist: string }>>()
  const byDay = new Map<string, number>()
  const trackDay = new Map<string, number>()

  const clock = new Array(24).fill(0) as number[]
  const weekdays = new Array(7).fill(0) as number[]
  const grid = new Array(168).fill(0) as number[]

  const sessions: Session[] = []
  const binges: Run[] = []
  const albumListens: Run[] = []
  const milestones: Milestone[] = []
  const curios = { remix: 0, live: 0, acoustic: 0, collab: 0 }
  let longestTitle: { track: string; artist: string } | null = null

  let session: (Session & { artistCounts: Map<string, number> }) | null = null
  let runArtist: { artist: string; start: number; tracks: number; distinct: Set<string> } | null = null
  let runAlbum: { album: string; artist: string; start: number; tracks: number; distinct: Set<string> } | null =
    null

  const closeSession = () => {
    if (!session) return
    const top = [...session.artistCounts.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    )[0]
    sessions.push({
      start: session.start,
      end: session.end,
      tracks: session.tracks,
      topArtist: top?.[0] ?? null,
    })
    session = null
  }
  const closeArtistRun = () => {
    if (runArtist && runArtist.tracks >= BINGE_MIN) {
      binges.push({
        artist: runArtist.artist,
        start: runArtist.start,
        tracks: runArtist.tracks,
        distinct: runArtist.distinct.size,
      })
    }
    runArtist = null
  }
  const closeAlbumRun = () => {
    // Distinct tracks, not plays: looping one song off an album isn't an album listen.
    if (runAlbum && runAlbum.distinct.size >= ALBUM_RUN_MIN) {
      albumListens.push({
        artist: runAlbum.artist,
        album: runAlbum.album,
        start: runAlbum.start,
        tracks: runAlbum.tracks,
        distinct: runAlbum.distinct.size,
      })
    }
    runAlbum = null
  }

  // Both lists are ascending, so the overlap is a merge rather than a lookup per
  // row: `windowAt` only ever moves forward. O(rows + windows).
  const windows = (input.windows ?? []).slice().sort((a, b) => a.startedAt - b.startedAt)
  let windowAt = 0
  let movingPlays = 0
  const movingKinds = new Map<string, number>()
  const movingArtists = new Map<string, number>()
  const movingTracks = new Map<string, { track: string; artist: string; count: number }>()
  const movingIds = new Set<string>()

  let prevUts = 0
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    const day = dayKey(r.uts, offset)
    const hour = hourOf(r.uts, offset)
    const weekday = weekdayOf(r.uts, offset)

    bump(artists, r.artist, r.artist, { name: r.artist }, r.image)
    bump(tracks, `${r.track}${SEP}${r.artist}`, r.track, { track: r.track, artist: r.artist }, r.image)
    if (r.album) {
      bump(albums, `${r.album}${SEP}${r.artist}`, r.album, { album: r.album, artist: r.artist }, r.image)
    }

    byDay.set(day, (byDay.get(day) ?? 0) + 1)
    const tdKey = `${day}${SEP}${r.track}${SEP}${r.artist}`
    trackDay.set(tdKey, (trackDay.get(tdKey) ?? 0) + 1)

    clock[hour]++
    weekdays[weekday]++
    grid[weekday * 24 + hour]++

    if (REMIX.test(r.track)) curios.remix++
    if (LIVE.test(r.track)) curios.live++
    if (ACOUSTIC.test(r.track)) curios.acoustic++
    if (COLLAB.test(r.artist)) curios.collab++
    if (!longestTitle || r.track.length > longestTitle.track.length) {
      longestTitle = { track: r.track, artist: r.artist }
    }

    const genre = genreOf[r.artist]
    if (genre) {
      knownGenrePlays++
      genreCounts.set(genre, (genreCounts.get(genre) ?? 0) + 1)
      // Bucket the same way buildSeries does, so the stacked trend lines up with
      // the plain one above it.
      const bucket =
        period.kind === 'y' ? day.slice(0, 7) : period.kind === 'all' ? day.slice(0, 4) : day
      let inBucket = genreByBucket.get(bucket)
      if (!inBucket) genreByBucket.set(bucket, (inBucket = new Map()))
      inBucket.set(genre, (inBucket.get(genre) ?? 0) + 1)
    }

    const origin = originOf[r.artist]
    if (origin) {
      if (origin.c) {
        knownCountryPlays++
        countryCounts.set(origin.c, (countryCounts.get(origin.c) ?? 0) + 1)
      }
      // Groups only. MusicBrainz's life-span.begin is the formation year for a
      // band but the *birth* year for a person, so mixing them would file solo
      // artists into an era by when they were born — Charli xcx would land in
      // the 1990s. Different quantities; don't add them up.
      if (origin.y && origin.k === 'Group') {
        const decade = Math.floor(origin.y / 10) * 10
        decadeCounts.set(decade, (decadeCounts.get(decade) ?? 0) + 1)
      }
      if (origin.k === 'Group') groupPlays++
      else if (origin.k === 'Person') soloPlays++
    }

    const seconds = durationOf[`${r.track}${SEP}${r.artist}`]
    if (seconds) {
      knownDurationPlays++
      knownSeconds += seconds
      secondsByArtist.set(r.artist, (secondsByArtist.get(r.artist) ?? 0) + seconds)
      if (!longestTrack || seconds > longestTrack.seconds) {
        longestTrack = { track: r.track, artist: r.artist, seconds }
      }
    }

    // Advance past windows that ended before this play, then test the current
    // one. Activities don't overlap in practice, so the first hit is the answer.
    while (
      windowAt < windows.length &&
      windows[windowAt].startedAt + windows[windowAt].elapsedTime <= r.uts
    ) {
      windowAt++
    }
    const w = windows[windowAt]
    if (w && r.uts >= w.startedAt) {
      movingPlays++
      movingIds.add(w.id)
      movingKinds.set(w.kind, (movingKinds.get(w.kind) ?? 0) + 1)
      movingArtists.set(r.artist, (movingArtists.get(r.artist) ?? 0) + 1)
      const mk = `${r.track}${SEP}${r.artist}`
      const seen = movingTracks.get(mk)
      if (seen) seen.count++
      else movingTracks.set(mk, { track: r.track, artist: r.artist, count: 1 })
    }

    const n = playsBefore + i + 1
    if (n % MILESTONE_STEP === 0) {
      milestones.push({ n, uts: r.uts, track: r.track, artist: r.artist })
    }

    // Sessions and runs both break on a long gap.
    const gap = prevUts ? r.uts - prevUts : Infinity
    if (gap > SESSION_GAP) {
      closeSession()
      closeArtistRun()
      closeAlbumRun()
    }
    if (!session) {
      session = { start: r.uts, end: r.uts, tracks: 0, topArtist: null, artistCounts: new Map() }
    }
    session.end = r.uts
    session.tracks++
    session.artistCounts.set(r.artist, (session.artistCounts.get(r.artist) ?? 0) + 1)

    if (runArtist && runArtist.artist === r.artist) {
      runArtist.tracks++
      runArtist.distinct.add(r.track)
    } else {
      closeArtistRun()
      runArtist = { artist: r.artist, start: r.uts, tracks: 1, distinct: new Set([r.track]) }
    }

    if (r.album && runAlbum && runAlbum.album === r.album && runAlbum.artist === r.artist) {
      runAlbum.tracks++
      runAlbum.distinct.add(r.track)
    } else {
      closeAlbumRun()
      runAlbum = r.album
        ? { album: r.album, artist: r.artist, start: r.uts, tracks: 1, distinct: new Set([r.track]) }
        : null
    }

    prevUts = r.uts
  }
  closeSession()
  closeArtistRun()
  closeAlbumRun()

  const scrobbles = rows.length
  const days = daySpan(period, now, offset)
  const activeDays = byDay.size
  const elapsedDays = Math.max(1, days.length)

  // Longest run of consecutive active days, and the longest silence between them.
  let longest = 0
  let longestSilence = 0
  let run = 0
  let silence = 0
  for (const day of days) {
    if (byDay.has(day)) {
      run++
      if (run > longest) longest = run
      silence = 0
    } else {
      run = 0
      silence++
      if (silence > longestSilence) longestSilence = silence
    }
  }

  const total = scrobbles
  const topArtists = rank(artists, total).map((a) => ({ ...a, prevRank: null })) as RankedArtist[]
  const topAlbums = rank(albums, total).map((a) => ({ ...a, prevRank: null })) as RankedAlbum[]
  const topTracks = rank(tracks, total).map((t) => ({ ...t, prevRank: null })) as RankedTrack[]

  if (previous) {
    const artistRank = new Map(previous.top.artists.map((a, i) => [a.name, i + 1]))
    const albumRank = new Map(previous.top.albums.map((a, i) => [`${a.album}${SEP}${a.artist}`, i + 1]))
    const trackRank = new Map(previous.top.tracks.map((t, i) => [`${t.track}${SEP}${t.artist}`, i + 1]))
    for (const a of topArtists) a.prevRank = artistRank.get(a.name) ?? null
    for (const a of topAlbums) a.prevRank = albumRank.get(`${a.album}${SEP}${a.artist}`) ?? null
    for (const t of topTracks) t.prevRank = trackRank.get(`${t.track}${SEP}${t.artist}`) ?? null
  }

  const peakHour = total ? clock.indexOf(Math.max(...clock)) : null
  // "Quietest" only means something once there is listening to be quiet against.
  const quietestHour = total ? clock.indexOf(Math.min(...clock)) : null
  const peakWeekday = total ? weekdays.indexOf(Math.max(...weekdays)) : null
  const weekendPlays = weekdays[5] + weekdays[6]
  const lateNight = LATE_NIGHT.reduce((sum, h) => sum + clock[h], 0)

  let busiestDay: PeriodStats['busiestDay'] = null
  for (const [date, count] of byDay) {
    if (!busiestDay || count > busiestDay.count) busiestDay = { date, count }
  }

  let obsession: PeriodStats['loyalty']['obsession'] = null
  for (const [key, count] of trackDay) {
    if (!obsession || count > obsession.count) {
      const [date, track, artist] = key.split(SEP)
      obsession = { track, artist, count, date }
    }
  }

  // Inverse-Simpson: 1 / Σ(share²). Reads as "it felt like N artists".
  let simpson = 0
  for (const entry of artists.values()) simpson += (entry.count / (total || 1)) ** 2
  const top10Share = topArtists.slice(0, 10).reduce((sum, a) => sum + a.count, 0)

  const perDay = Math.round((scrobbles / elapsedDays) * 10) / 10
  const pct = (a: number, b: number) => (b ? Math.round(((a - b) / b) * 1000) / 10 : null)

  // Genre shares are of *classified* plays, not of all plays. Dividing by the
  // total would make every share shrink as coverage fell, so an unenriched
  // archive would read as "20% hardcore, 80% nothing" instead of "hardcore leads,
  // based on the 40% we can classify". `genreCoverage` reports the caveat.
  const genres = [...genreCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, GENRE_N)
    .map(([name, count]) => ({
      name,
      count,
      share: knownGenrePlays ? Math.round((count / knownGenrePlays) * 1000) / 10 : 0,
    }))

  let genreSimpson = 0
  for (const count of genreCounts.values()) {
    genreSimpson += (count / (knownGenrePlays || 1)) ** 2
  }

  const topGenreNames = new Set(genres.slice(0, GENRE_SERIES_N).map((g) => g.name))
  const genreSeries = buildSeries(period, byDay, now, offset).map((point) => {
    const inBucket = genreByBucket.get(point.key)
    const shares: Record<string, number> = {}
    if (inBucket) {
      let bucketTotal = 0
      for (const count of inBucket.values()) bucketTotal += count
      for (const [name, count] of inBucket) {
        if (!topGenreNames.has(name)) continue
        shares[name] = bucketTotal ? Math.round((count / bucketTotal) * 1000) / 10 : 0
      }
    }
    return { key: point.key, label: point.label, genres: shares }
  })

  // Country shares are of plays with a known country, matching how genre shares
  // work — so the leader board reads the same way regardless of coverage.
  const countries = [...countryCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 12)
    .map(([code, count]) => ({
      code,
      count,
      share: knownCountryPlays ? Math.round((count / knownCountryPlays) * 1000) / 10 : 0,
    }))

  let decadeTotal = 0
  for (const count of decadeCounts.values()) decadeTotal += count
  const decades = [...decadeCounts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([decade, count]) => ({
      decade,
      count,
      share: decadeTotal ? Math.round((count / decadeTotal) * 1000) / 10 : 0,
    }))

  const kindPlays = groupPlays + soloPlays

  // Extrapolate over unknown durations rather than under-reporting: with 80%
  // coverage, scaling by 1/0.8 is a far better estimate of hours listened than
  // silently dropping a fifth of the plays. `coverage` says how much is measured.
  const durationCoverage = scrobbles ? knownDurationPlays / scrobbles : 0
  const estimatedSeconds = durationCoverage > 0 ? Math.round(knownSeconds / durationCoverage) : 0
  const topByTime = [...secondsByArtist.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10)
    .map(([name, seconds]) => ({ name, seconds }))

  return {
    kind: period.kind,
    key: period.key,
    label: period.label,
    start: period.start,
    end: period.end === Infinity ? now : period.end,
    complete: period.end <= now,
    computedAt: now,

    scrobbles,
    artists: artists.size,
    albums: albums.size,
    tracks: tracks.size,
    perDay,
    activeDays,
    silentDays: Math.max(0, elapsedDays - activeDays),

    top: { artists: topArtists, albums: topAlbums, tracks: topTracks },

    clock,
    weekdays,
    grid,
    peakHour,
    quietestHour,
    peakWeekday,
    weekendShare: total ? Math.round((weekendPlays / total) * 1000) / 10 : 0,
    lateNightShare: total ? Math.round((lateNight / total) * 1000) / 10 : 0,

    series: buildSeries(period, byDay, now, offset),
    busiestDay,
    busiestHour: peakHour === null ? null : { hour: peakHour, count: clock[peakHour] },

    streaks: { longest, longestSilence },
    sessions: {
      count: sessions.length,
      avgTracks: sessions.length ? Math.round((scrobbles / sessions.length) * 10) / 10 : 0,
      longest: sessions.reduce<Session | null>(
        (best, s) => (!best || s.tracks > best.tracks ? s : best),
        null,
      ),
    },
    binges: binges.sort((a, b) => b.tracks - a.tracks).slice(0, 5),
    albumListens: albumListens.sort((a, b) => b.distinct - a.distinct).slice(0, 5),

    loyalty: {
      repeatRate: tracks.size ? Math.round((scrobbles / tracks.size) * 100) / 100 : 0,
      top10Share: total ? Math.round((top10Share / total) * 1000) / 10 : 0,
      effectiveArtists: simpson ? Math.round(1 / simpson) : 0,
      obsession,
    },

    curios: { ...curios, longestTitle },

    genres,
    // Genres present now but absent from the previous period. Not "first ever" —
    // that needs an archive-wide first-play per genre, which belongs with the
    // discovery rollups rather than here.
    newGenres: previous
      ? genres.map((g) => g.name).filter((name) => !previous.genres?.some((p) => p.name === name))
      : [],
    genreDiversity: genreSimpson ? Math.round(1 / genreSimpson) : 0,
    genreSeries,
    genreCoverage: scrobbles ? Math.round((knownGenrePlays / scrobbles) * 1000) / 10 : 0,

    origins: {
      countries,
      decades,
      groupShare: kindPlays ? Math.round((groupPlays / kindPlays) * 1000) / 10 : 0,
      soloShare: kindPlays ? Math.round((soloPlays / kindPlays) * 1000) / 10 : 0,
      coverage: scrobbles ? Math.round((knownCountryPlays / scrobbles) * 1000) / 10 : 0,
    },

    listening: {
      seconds: estimatedSeconds,
      coverage: Math.round(durationCoverage * 1000) / 10,
      avgTrackSeconds: knownDurationPlays ? Math.round(knownSeconds / knownDurationPlays) : 0,
      topByTime,
      longest: longestTrack,
    },

    moving: {
      plays: movingPlays,
      share: scrobbles ? Math.round((movingPlays / scrobbles) * 1000) / 10 : 0,
      activities: movingIds.size,
      byKind: [...movingKinds.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([kind, count]) => ({ kind, count })),
      topArtists: [...movingArtists.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 8)
        .map(([name, count]) => ({ name, count })),
      topTracks: [...movingTracks.values()]
        .sort((a, b) => b.count - a.count || a.track.localeCompare(b.track))
        .slice(0, 5),
    },

    milestones,
    first: rows[0] ?? null,
    last: rows[rows.length - 1] ?? null,

    // Overwritten by the caller, which has the summary tables to hand.
    discovery: { artists: 0, albums: 0, tracks: 0, rate: 0, newArtists: [], returning: [] },
    abandoned: previous
      ? previous.top.artists.slice(0, 10).map((a) => a.name).filter((name) => !artists.has(name))
      : [],
    delta: {
      scrobbles: previous ? pct(scrobbles, previous.scrobbles) : null,
      artists: previous ? pct(artists.size, previous.artists) : null,
      tracks: previous ? pct(tracks.size, previous.tracks) : null,
      perDay: previous ? pct(perDay, previous.perDay) : null,
    },
  }
}
