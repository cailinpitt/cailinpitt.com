// Which /listening/<year> pages get prerendered. Derived from a constant, not the API, so a
// Worker outage can't fail the build — the range extends itself each January.

/** First year with scrobbles in the archive. */
export const FIRST_LISTENING_YEAR = 2021

export function listeningYears(now = new Date()): number[] {
  const years: number[] = []
  for (let y = now.getFullYear(); y >= FIRST_LISTENING_YEAR; y--) years.push(y)
  return years
}
