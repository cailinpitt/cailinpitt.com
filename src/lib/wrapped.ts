// Turn a period's stats into a narrative.
//
// Pure functions over a PeriodStats blob — no fetching, no new data. Everything
// here is a reading of numbers the Worker already computed, which is what makes
// it testable and what let it be built while the enrichment backfill ran.
//
// Two rules throughout:
//
//  - **Never assert something the data doesn't support.** Every card and trait
//    returns null when its inputs are missing or too thin, and the page renders
//    what survives. A half-enriched archive gets fewer cards, not wrong ones.
//  - **Thresholds are stated, not hidden.** They're arbitrary by nature, so they
//    live in one block with the reasoning attached.
//
// Voice: first person. This is Cailin's listening on Cailin's site, so the copy
// says "I played", never "you played" — addressing the reader would imply the
// numbers were theirs. Matches /listening ("What I have on").

import type { PeriodStats } from './listening'

/**
 * A period needs at least this many scrobbles before any of it means anything.
 * Below this, "my top artist" is noise and the traits are coin flips.
 */
export const MIN_SCROBBLES = 50

const T = {
  /** Share of distinct tracks that were first-ever plays. */
  explorerDiscovery: 45,
  loyalistDiscovery: 20,
  /** Share of plays from the top ten artists. */
  loyalistConcentration: 55,
  explorerConcentration: 30,
  /** Plays per distinct track. */
  repeaterRate: 3.5,
  /** Share of plays between midnight and 5am. */
  nightOwl: 12,
  /** Peak listening hour at or before this reads as a morning habit. */
  earlyPeak: 9,
  /** Peak hour at or after this reads as an evening habit. */
  latePeak: 21,
  /** Share of plays on Saturday and Sunday. Even split is ~28.6%. */
  weekendHeavy: 38,
  weekdayHeavy: 18,
  /** A streak this long is worth remarking on. */
  notableStreak: 14,
  /** Distinct genres before "eclectic" means anything. */
  eclecticGenres: 8,
}

export interface Trait {
  /** Short name, e.g. "Explorer". */
  label: string
  /** The evidence, in plain language. Always cites the number behind it. */
  detail: string
}

/**
 * Read the period's character off its indices.
 *
 * Traits are independent rather than one composite archetype: real listening
 * doesn't reduce to a single label, and a person can be both a loyalist and a
 * night owl. Each is emitted only when its evidence is actually strong.
 */
export function deriveTraits(stats: PeriodStats): Trait[] {
  const out: Trait[] = []
  if (stats.scrobbles < MIN_SCROBBLES) return out

  const discovery = stats.discovery?.rate ?? 0
  const concentration = stats.loyalty?.top10Share ?? 0

  if (discovery >= T.explorerDiscovery && concentration <= T.loyalistConcentration) {
    out.push({
      label: 'Explorer',
      detail: `${discovery}% of the tracks I played were ones I'd never heard before.`,
    })
  } else if (discovery <= T.loyalistDiscovery || concentration >= T.loyalistConcentration) {
    out.push({
      label: 'Loyalist',
      detail: `${concentration}% of my plays came from just ten artists.`,
    })
  }

  if (stats.loyalty?.repeatRate >= T.repeaterRate) {
    out.push({
      label: 'Repeater',
      detail: `I played the average track ${stats.loyalty.repeatRate} times.`,
    })
  }

  if (stats.lateNightShare >= T.nightOwl) {
    out.push({
      label: 'Night owl',
      detail: `${stats.lateNightShare}% of my listening happened after midnight.`,
    })
  } else if (stats.peakHour !== null && stats.peakHour <= T.earlyPeak) {
    out.push({
      label: 'Early riser',
      detail: `My busiest hour was ${formatHour(stats.peakHour)}.`,
    })
  } else if (stats.peakHour !== null && stats.peakHour >= T.latePeak) {
    out.push({
      label: 'Evening listener',
      detail: `My busiest hour was ${formatHour(stats.peakHour)}.`,
    })
  }

  if (stats.weekendShare >= T.weekendHeavy) {
    out.push({
      label: 'Weekend listener',
      detail: `${stats.weekendShare}% of my plays landed on Saturday or Sunday.`,
    })
  } else if (stats.weekendShare > 0 && stats.weekendShare <= T.weekdayHeavy) {
    out.push({
      label: 'Weekday listener',
      detail: `Only ${stats.weekendShare}% of my plays were at the weekend.`,
    })
  }

  // Genre traits only when enough of the period is actually classified.
  if (stats.genreCoverage >= 50 && stats.genres?.length) {
    if (stats.genreDiversity >= T.eclecticGenres) {
      out.push({
        label: 'Eclectic',
        detail: `My listening spread across the equivalent of ${stats.genreDiversity} genres.`,
      })
    } else if (stats.genres[0] && stats.genres[0].share >= 40) {
      out.push({
        label: `${titleCase(stats.genres[0].name)} devotee`,
        detail: `${stats.genres[0].share}% of my classified plays were ${stats.genres[0].name}.`,
      })
    }
  }

  if (stats.albumListens?.length >= 3) {
    out.push({
      label: 'Album listener',
      detail: `I played ${stats.albumListens.length} records front to back.`,
    })
  }

  if (stats.streaks?.longest >= T.notableStreak) {
    out.push({
      label: 'Consistent',
      detail: `I listened every day for ${stats.streaks.longest} days straight.`,
    })
  }

  return out
}

export interface Card {
  /** Small label above the number. */
  kicker: string
  /** The headline value — kept short; it renders very large. */
  value: string
  /** Optional supporting line. */
  detail?: string
}

/** 17 → "5pm". */
export function formatHour(hour: number): string {
  if (hour === 0) return 'midnight'
  if (hour === 12) return 'noon'
  return hour < 12 ? `${hour}am` : `${hour - 12}pm`
}

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

const num = (n: number) => n.toLocaleString('en-US')

/** Seconds → "756 hours" or "31 days", whichever reads better. */
export function formatSpan(seconds: number): string {
  const hours = seconds / 3600
  if (hours < 1) return `${Math.round(seconds / 60)} minutes`
  if (hours < 72) return `${Math.round(hours)} hours`
  return `${num(Math.round(hours))} hours`
}

/**
 * The narrative cards, in reading order.
 *
 * Each is skipped when its data is absent, so this returns a shorter deck rather
 * than one with holes — a period from before enrichment simply has no genre or
 * time card.
 */
export function buildCards(stats: PeriodStats): Card[] {
  const cards: Card[] = []
  if (stats.scrobbles < MIN_SCROBBLES) return cards

  cards.push({
    kicker: 'I played',
    value: `${num(stats.scrobbles)} tracks`,
    detail: `across ${num(stats.artists)} artists and ${num(stats.albums)} albums.`,
  })

  if (stats.listening?.seconds > 0) {
    const days = stats.listening.seconds / 86_400
    cards.push({
      kicker: 'That is',
      value: formatSpan(stats.listening.seconds),
      detail:
        days >= 1
          ? `${days.toFixed(1)} days of music, end to end.`
          : 'of music, end to end.',
    })
  }

  const topArtist = stats.top?.artists?.[0]
  if (topArtist) {
    cards.push({
      kicker: 'Most played artist',
      value: topArtist.name,
      detail: `${num(topArtist.count)} plays — ${topArtist.share}% of everything.`,
    })
  }

  const topTrack = stats.top?.tracks?.[0]
  if (topTrack) {
    cards.push({
      kicker: 'On repeat',
      value: topTrack.track,
      detail: `${topTrack.artist} · ${num(topTrack.count)} plays.`,
    })
  }

  const topAlbum = stats.top?.albums?.[0]
  if (topAlbum) {
    cards.push({
      kicker: 'Most played record',
      value: topAlbum.album,
      detail: `${topAlbum.artist} · ${num(topAlbum.count)} plays.`,
    })
  }

  // Only speak about genre when most of the period is classified — a leading
  // genre drawn from 12% coverage is not a fact about the year.
  if (stats.genreCoverage >= 50 && stats.genres?.[0]) {
    cards.push({
      kicker: 'My sound',
      value: titleCase(stats.genres[0].name),
      detail: `${stats.genres[0].share}% of my classified plays.`,
    })
  }

  if (stats.discovery?.artists > 0) {
    cards.push({
      kicker: 'New to me',
      value: `${num(stats.discovery.artists)} artists`,
      detail: `heard for the first time.`,
    })
  }

  if (stats.peakHour !== null && stats.peakWeekday !== null) {
    cards.push({
      kicker: 'My moment',
      value: `${WEEKDAYS[stats.peakWeekday]}s at ${formatHour(stats.peakHour)}`,
      detail: 'when I listened most.',
    })
  }

  if (stats.origins?.countries?.length >= 2 && stats.origins.coverage >= 50) {
    const top = stats.origins.countries[0]
    cards.push({
      kicker: 'From',
      value: `${stats.origins.countries.length}+ countries`,
      detail: `mostly ${countryLabel(top.code)} at ${top.share}%.`,
    })
  }

  if (stats.busiestDay) {
    cards.push({
      kicker: 'My biggest day',
      value: num(stats.busiestDay.count),
      detail: `tracks on ${stats.busiestDay.date}.`,
    })
  }

  const longest = stats.sessions?.longest
  if (longest && longest.tracks >= 20) {
    cards.push({
      kicker: 'Longest sitting',
      value: `${num(longest.tracks)} tracks`,
      detail: longest.topArtist ? `mostly ${longest.topArtist}.` : 'without a real break.',
    })
  }

  return cards
}

/** Minimal country labelling — the full table lives in the period view. */
const COUNTRIES: Record<string, string> = {
  US: 'the United States',
  GB: 'the United Kingdom',
  AU: 'Australia',
  CA: 'Canada',
  IE: 'Ireland',
  JP: 'Japan',
  SE: 'Sweden',
  DE: 'Germany',
  FR: 'France',
  NZ: 'New Zealand',
}

const countryLabel = (code: string) => COUNTRIES[code] ?? code
