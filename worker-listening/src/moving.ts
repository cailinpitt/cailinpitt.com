// Activity windows from the moving Worker, for the "what I listen to while
// moving" crossover.
//
// This is the only place the listening Worker depends on another service, so it
// is deliberately defensive: a period build must succeed whether or not moving
// answers. A failure here costs the crossover section, never the period.
//
// Cost: one subrequest per period build (~65/day steady, plus the backfill
// walk). The moving side serves these from an indexed range behind a one-hour
// edge cache, so repeated builds in the same hour don't reach its D1 at all.

export interface ActivityWindow {
  id: string
  kind: string
  /** Unix seconds, UTC. */
  startedAt: number
  /**
   * Usable window length — moving time plus a pause allowance, capped at what
   * was recorded. See the note in worker-moving's store.ts: raw elapsed time
   * runs ~3.6x longer than actual movement because recordings get left running,
   * which would sweep a whole evening into "while moving".
   */
  seconds?: number
  /** Raw recorded span. Only used as a fallback for an older moving Worker. */
  elapsedTime?: number
}

/** Give up rather than let a slow neighbour stall the cron tick. */
const TIMEOUT_MS = 5_000

/**
 * Windows overlapping [from, to).
 *
 * Returns [] on any failure — an unreachable moving Worker, a timeout, a shape
 * that doesn't parse. The caller can't tell "no activities" from "couldn't ask",
 * and deliberately so: both mean the same thing for the section, which is that
 * there is nothing to show.
 */
export async function fetchWindows(
  env: Env,
  from: number,
  to: number,
): Promise<ActivityWindow[]> {
  const base = env.MOVING_API
  if (!base) return []

  try {
    const res = await fetch(`${base}/windows.json?from=${from}&to=${to}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) return []
    const data = (await res.json()) as { windows?: ActivityWindow[] }
    return Array.isArray(data.windows) ? data.windows : []
  } catch (err) {
    console.log(JSON.stringify({ level: 'warn', stage: 'moving-windows', error: String(err) }))
    return []
  }
}
