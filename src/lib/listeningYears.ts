// Which /listening/<year> pages get prerendered.
//
// Derived from a constant rather than the API on purpose: the SSG needs these
// paths at build time, and making the build depend on the Worker being reachable
// would let an unrelated outage fail a deploy. The range extends by itself each
// January, since the build runs on every push.

/** First year with scrobbles in the archive. */
export const FIRST_LISTENING_YEAR = 2021

export function listeningYears(now = new Date()): number[] {
  const years: number[] = []
  for (let y = now.getFullYear(); y >= FIRST_LISTENING_YEAR; y--) years.push(y)
  return years
}
