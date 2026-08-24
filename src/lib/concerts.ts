// Static data — src/lib/concerts.json, written by scripts/concerts-import.mjs.
// No Worker, no fetch; loaded like photos.json (see content.server.ts/content.client.ts).

export interface Concert {
  id: string
  /** YYYY-MM-DD */
  date: string
  name: string | null
  /** Headliner first. */
  artists: string[]
  venue: string
  location: string
  url: string | null
}

export function concertTitle(concert: Concert): string {
  return concert.name || concert.artists.join(' / ')
}

export function concertLineup(concert: Concert): string | null {
  const lineup = concert.artists.join(' / ')
  return concert.name && lineup !== concert.name ? lineup : null
}

export function concertPlace(concert: Concert): string | null {
  return [concert.venue, concert.location].filter(Boolean).join(', ') || null
}

export function concertsByYear(concerts: Concert[]): { year: string; concerts: Concert[] }[] {
  const years: { year: string; concerts: Concert[] }[] = []
  for (const concert of concerts) {
    const year = concert.date.slice(0, 4)
    const last = years[years.length - 1]
    if (last?.year === year) last.concerts.push(concert)
    else years.push({ year, concerts: [concert] })
  }
  return years
}

const dateFmt = new Intl.DateTimeFormat('en-US', {
  month: 'long',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
})

export function formatConcertDate(date: string): string | null {
  const parsed = new Date(`${date.slice(0, 10)}T12:00:00Z`)
  return Number.isNaN(parsed.getTime()) ? null : dateFmt.format(parsed)
}

export interface ConcertCounts {
  concerts: number
  concertsThisYear: number
  venues: number
  artists: number
}

export function concertCounts(concerts: Concert[], year: number): ConcertCounts {
  const venues = new Set(concerts.map((c) => c.venue).filter(Boolean))
  const artists = new Set(concerts.flatMap((c) => c.artists))
  return {
    concerts: concerts.length,
    concertsThisYear: concerts.filter((c) => c.date.startsWith(String(year))).length,
    venues: venues.size,
    artists: artists.size,
  }
}
