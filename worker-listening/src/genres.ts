// Genre taxonomy.
//
// Last.fm tags are user-generated and only loosely about genre: a typical artist
// carries a mix of real genres, scene shorthand, cities, decades, and personal
// filing labels ("seen live", "albums i own", "female vocalists"). Left raw, a
// genre chart is mostly junk and its biggest slices are the least informative.
//
// So this is an allowlist, not a denylist: a tag counts only if it maps to a
// canonical genre below, and everything else is dropped. Subgenres fold into a
// parent, which is what makes shares comparable across periods.
//
// **This file is meant to be edited.** It encodes taste, not fact. Adding an
// alias or splitting a genre out of its parent is a normal change. After any
// edit, bump PREFIX in period.ts — completed period blobs are frozen forever, so
// that is the only thing that makes them pick up the new mapping.

/**
 * Canonical genre → every tag that should fold into it.
 *
 * Order matters only for readability. Matching is exact on the lowercased tag,
 * so entries here should be written the way Last.fm actually spells them.
 */
const ALIASES: Record<string, string[]> = {
  // --- guitars, loud ---
  hardcore: [
    'hardcore', 'hardcore punk', 'melodic hardcore', 'nyhc', 'post-hardcore',
    'metalcore', 'beatdown', 'straight edge', 'youth crew', 'powerviolence',
  ],
  punk: ['punk', 'punk rock', 'pop punk', 'skate punk', 'anarcho-punk', 'garage punk'],
  'post-punk': ['post-punk', 'post punk', 'new wave', 'coldwave', 'darkwave', 'dance-punk', 'crank wave'],
  emo: ['emo', 'emocore', 'midwest emo', 'screamo', 'skramz', 'emo revival'],
  metal: [
    'metal', 'heavy metal', 'death metal', 'black metal', 'doom metal', 'thrash metal',
    'sludge', 'grindcore', 'nu metal', 'alternative metal', 'progressive metal',
  ],
  'indie rock': ['indie rock', 'indie', 'indie music'],
  'alternative rock': ['alternative rock', 'alternative', 'alt-rock', 'grunge', '90s alternative'],
  rock: [
    'rock', 'classic rock', 'hard rock', 'garage rock', 'psychedelic rock', 'prog rock',
    'progressive rock', 'stoner rock', 'surf rock', 'surf', 'guitar',
  ],
  shoegaze: ['shoegaze', 'shoegazing', 'nu gaze', 'blackgaze'],
  'dream pop': ['dream pop', 'dreampop', 'ethereal'],
  'math rock': ['math rock', 'midwest math', 'post-math'],
  'post-rock': ['post-rock', 'post rock', 'instrumental rock'],
  slowcore: ['slowcore', 'sadcore'],
  noise: ['noise', 'noise rock', 'no wave'],
  industrial: ['industrial', 'ebm', 'industrial rock'],

  // --- pop ---
  pop: ['pop', 'dance pop', 'pop music'],
  'indie pop': ['indie pop', 'twee', 'jangle pop'],
  hyperpop: ['hyperpop', 'glitch pop', 'pc music', 'bubblegum bass', 'digicore'],
  synthpop: ['synthpop', 'synth pop', 'electropop', 'synthwave'],
  'art pop': ['art pop', 'experimental pop', 'avant-pop'],
  'bedroom pop': ['bedroom pop', 'lo-fi pop'],
  'k-pop': ['k-pop', 'kpop', 'korean'],
  'j-pop': ['j-pop', 'jpop', 'japanese', 'city pop'],

  // --- electronic ---
  electronic: ['electronic', 'electronica', 'edm', 'idm', 'electro'],
  house: ['house', 'deep house', 'tech house', 'disco house', 'french house'],
  techno: ['techno', 'minimal techno', 'acid techno'],
  'drum and bass': ['drum and bass', 'dnb', 'drum n bass', 'jungle', 'liquid dnb'],
  ambient: ['ambient', 'drone', 'new age', 'field recordings'],
  breakcore: ['breakcore', 'breakbeat', 'jungle techno', 'digital hardcore'],
  dubstep: ['dubstep', 'brostep', 'riddim', 'bass music'],
  trance: ['trance', 'psytrance', 'progressive trance'],
  'lo-fi': ['lo-fi', 'lofi', 'lo-fi hip hop', 'chillhop'],

  // --- rap and soul ---
  'hip hop': ['hip hop', 'hip-hop', 'rap', 'underground hip hop', 'boom bap', 'conscious hip hop'],
  trap: ['trap', 'drill', 'plugg', 'rage'],
  'r&b': ['r&b', 'rnb', 'contemporary r&b', 'alternative r&b', 'neo-soul'],
  soul: ['soul', 'northern soul', 'motown'],
  funk: ['funk', 'p-funk', 'funk rock'],
  disco: ['disco', 'nu-disco', 'italo disco'],

  // --- roots ---
  folk: ['folk', 'indie folk', 'folk rock', 'freak folk', 'contemporary folk'],
  country: ['country', 'alt-country', 'outlaw country', 'bluegrass'],
  americana: ['americana', 'roots'],
  'singer-songwriter': ['singer-songwriter', 'singer songwriter'],
  blues: ['blues', 'blues rock', 'delta blues'],
  jazz: ['jazz', 'free jazz', 'jazz fusion', 'bebop', 'nu jazz'],

  // --- elsewhere ---
  reggae: ['reggae', 'dub', 'dancehall', 'roots reggae'],
  ska: ['ska', 'ska punk', 'two tone', '2 tone'],
  latin: ['latin', 'reggaeton', 'salsa', 'cumbia', 'bossa nova', 'latin pop'],
  afrobeat: ['afrobeat', 'afrobeats', 'highlife', 'amapiano'],
  classical: ['classical', 'baroque', 'romantic', 'contemporary classical', 'modern classical'],
  soundtrack: ['soundtrack', 'score', 'film score', 'video game music', 'ost'],
  experimental: ['experimental', 'avant-garde', 'sound collage', 'musique concrete', 'neo-psychedelia', 'art rock'],
  gospel: ['gospel', 'christian', 'worship'],
  'emo rap': ['emo rap', 'cloud rap', 'sadboy'],
}

/** Lowercased tag → canonical genre. Built once at module load. */
const TAG_TO_GENRE = new Map<string, string>()
for (const [genre, tags] of Object.entries(ALIASES)) {
  for (const tag of tags) TAG_TO_GENRE.set(tag.toLowerCase(), genre)
  // A canonical name is always an alias of itself, even if not listed above.
  TAG_TO_GENRE.set(genre.toLowerCase(), genre)
}

/** Every canonical genre, for reference and tests. */
export const CANONICAL_GENRES = [...new Set(TAG_TO_GENRE.values())].sort()

/**
 * Map one raw Last.fm tag to a canonical genre, or null to drop it.
 *
 * Deliberately exact rather than fuzzy. Substring matching sounds appealing but
 * misfires badly here — "post-hardcore" contains "hardcore", "emo" appears
 * inside "emocore" *and* "demo", and "pop" inside "pop punk". An explicit alias
 * list is longer but never surprises.
 */
export function normalizeTag(tag: string): string | null {
  return TAG_TO_GENRE.get(tag.trim().toLowerCase()) ?? null
}

/** A raw tag as Last.fm returns it: name plus a 0–100 weight. */
export interface RawTag {
  name: string
  count: number
}

/**
 * Collapse an artist's raw tags into canonical genres, strongest first.
 *
 * Weights are kept because Last.fm's top tag is usually the real answer and the
 * tail is noise: Turnstile comes back hardcore 100, hardcore punk 61, punk 17,
 * then a scatter of 1s. Folding sums the weights of every alias that maps to the
 * same parent, so an artist tagged across three hardcore subgenres reads as
 * decisively hardcore rather than being split three ways.
 */
export function tagsToGenres(tags: RawTag[], limit = 3): string[] {
  const scores = new Map<string, number>()
  for (const tag of tags) {
    const genre = normalizeTag(tag.name)
    if (!genre) continue
    // Guard against a missing or nonsense weight rather than trusting the feed.
    const weight = Number.isFinite(tag.count) && tag.count > 0 ? tag.count : 1
    scores.set(genre, (scores.get(genre) ?? 0) + weight)
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([genre]) => genre)
}

/**
 * The single genre an artist counts as.
 *
 * One genre per artist, not several: if an artist counted toward three genres,
 * period shares would sum past 100% and "31% hardcore" would stop meaning
 * anything. The secondary genres are still stored, so a future view can use them.
 */
export function primaryGenre(tags: RawTag[]): string | null {
  return tagsToGenres(tags, 1)[0] ?? null
}
