// ISO 3166-1 alpha-2 → display name and flag.
//
// Only the countries that actually turn up in a music library, plus a fallback
// that returns the raw code. A full ISO table would be ~250 entries of dead
// weight in the Worker bundle to cover places no scrobble will ever come from.
// Adding a row here is a one-line change when an unknown code shows up.

const NAMES: Record<string, string> = {
  US: 'United States',
  GB: 'United Kingdom',
  CA: 'Canada',
  AU: 'Australia',
  NZ: 'New Zealand',
  IE: 'Ireland',
  JP: 'Japan',
  KR: 'South Korea',
  CN: 'China',
  TW: 'Taiwan',
  DE: 'Germany',
  FR: 'France',
  SE: 'Sweden',
  NO: 'Norway',
  DK: 'Denmark',
  FI: 'Finland',
  IS: 'Iceland',
  NL: 'Netherlands',
  BE: 'Belgium',
  ES: 'Spain',
  PT: 'Portugal',
  IT: 'Italy',
  CH: 'Switzerland',
  AT: 'Austria',
  PL: 'Poland',
  CZ: 'Czechia',
  HU: 'Hungary',
  RO: 'Romania',
  RU: 'Russia',
  UA: 'Ukraine',
  GR: 'Greece',
  TR: 'Turkey',
  IL: 'Israel',
  BR: 'Brazil',
  AR: 'Argentina',
  CL: 'Chile',
  CO: 'Colombia',
  MX: 'Mexico',
  PE: 'Peru',
  ZA: 'South Africa',
  NG: 'Nigeria',
  GH: 'Ghana',
  KE: 'Kenya',
  EG: 'Egypt',
  MA: 'Morocco',
  IN: 'India',
  PK: 'Pakistan',
  ID: 'Indonesia',
  PH: 'Philippines',
  TH: 'Thailand',
  VN: 'Vietnam',
  MY: 'Malaysia',
  SG: 'Singapore',
  JM: 'Jamaica',
  CU: 'Cuba',
  PR: 'Puerto Rico',
  DO: 'Dominican Republic',
  // MusicBrainz uses XW for "worldwide" on acts with no single home.
  XW: 'International',
  XE: 'Europe',
}

export const countryName = (code: string): string => NAMES[code] ?? code

// Built arithmetically rather than stored: 'US' → 🇺🇸. Non-letter codes
// (MusicBrainz's XW/XE) get a globe instead.
export function countryFlag(code: string): string {
  if (!/^[A-Za-z]{2}$/.test(code) || code === 'XW' || code === 'XE') return '🌐'
  const base = 0x1f1e6 - 'A'.charCodeAt(0)
  return String.fromCodePoint(
    ...[...code.toUpperCase()].map((c) => base + c.charCodeAt(0)),
  )
}
