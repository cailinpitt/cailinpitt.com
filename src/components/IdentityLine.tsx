import { useCallback, useEffect, useRef, useState } from 'react'
import { identities as IDENTITIES, descriptions as DESCRIPTIONS } from '../../content/identity'

// Rotating homepage headline, in the spirit of dame.is: identity and
// description shuffle independently, so any pairing reads true as long as each
// half is individually true. Auto-rotates every 10s (suppressed under
// reduced-motion); edit phrasing in content/identity.ts, not here.

const ROTATE_MS = 10_000

// Pick a random index in [0, length) that differs from `avoid`, so a reroll
// always visibly changes the text.
function pickDifferent(length: number, avoid: number): number {
  if (length < 2) return 0
  let next = Math.floor(Math.random() * (length - 1))
  if (next >= avoid) next += 1
  return next
}

export function IdentityLine() {
  // Deterministic first render so the prerendered HTML and the first client
  // render agree (no hydration mismatch); randomization begins after mount.
  const [pair, setPair] = useState({ i: 0, d: 0 })
  // Bumped on every change to replay the fade-in animation.
  const [tick, setTick] = useState(0)

  const timerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined)

  const reroll = useCallback(() => {
    setPair((prev) => ({
      i: pickDifferent(IDENTITIES.length, prev.i),
      d: pickDifferent(DESCRIPTIONS.length, prev.d),
    }))
    setTick((t) => t + 1)
  }, [])

  // Called on mount and after every manual shuffle, so a click gives a fresh
  // 10s before the next automatic reroll.
  const restartTimer = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current)
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (reduced) return
    timerRef.current = setInterval(reroll, ROTATE_MS)
  }, [reroll])

  useEffect(() => {
    // Reroll once on mount so the page doesn't always open on the same line.
    reroll()
    restartTimer()
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [reroll, restartTimer])

  const shuffle = useCallback(() => {
    reroll()
    restartTimer()
  }, [reroll, restartTimer])

  return (
    <div className="identity">
      <h1 className="identity-line">
        Cailin is{' '}
        <span key={tick} className="identity-swap">
          <span className="identity-role">{IDENTITIES[pair.i]}</span> who{' '}
          <span className="identity-deed">{DESCRIPTIONS[pair.d]}</span>.
        </span>
      </h1>
      <button type="button" className="identity-shuffle" onClick={shuffle} aria-label="Shuffle">
        <span aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5" />
          </svg>
        </span>
        Shuffle
      </button>
    </div>
  )
}
