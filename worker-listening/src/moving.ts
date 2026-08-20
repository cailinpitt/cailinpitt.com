// Activity windows from the moving Worker, for the "what I listen to while
// moving" crossover. Only place this Worker depends on another service, so it's
// deliberately defensive — a period build must succeed whether or not moving
// answers. ~65 subrequests/day steady; moving caches its response for an hour.

export interface ActivityWindow {
  id: string
  kind: string
  /** Unix seconds, UTC. */
  startedAt: number
  // Usable window length (moving time + pause allowance, capped at recorded
  // span). Raw elapsed time runs ~3.6x longer than actual movement since
  // recordings get left running — see worker-moving's store.ts.
  seconds?: number
  /** Raw recorded span. Only used as a fallback for an older moving Worker. */
  elapsedTime?: number
}

/** Give up rather than let a slow neighbour stall the cron tick. */
const TIMEOUT_MS = 5_000

// Returns [] on any failure (unreachable, timeout, bad shape) — deliberately
// indistinguishable from "no activities", since both mean nothing to show.
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
