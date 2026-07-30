import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { fetchNow, formatRelative, trackQuery, type NowState } from '../lib/listening'
import { ListenLinks } from './ListenLinks'

const POLL_MS = 60_000

/**
 * Compact now-playing / last-played strip for the homepage. Client-fetched from
 * the lightweight /now.json endpoint; renders nothing until it has data (so the
 * prerendered shell and any API hiccup just leave the homepage clean).
 */
export function NowPlayingBar() {
  const [now, setNow] = useState<NowState | null>(null)

  useEffect(() => {
    let active = true
    const controller = new AbortController()
    const load = async () => {
      try {
        const data = await fetchNow(controller.signal)
        if (active) setNow(data)
      } catch {
        /* leave the bar hidden on error */
      }
    }
    void load()
    const id = setInterval(load, POLL_MS)
    return () => {
      active = false
      controller.abort()
      clearInterval(id)
    }
  }, [])

  const track = now?.nowPlaying ?? now?.lastPlayed
  if (!track) return null
  const live = Boolean(now?.nowPlaying)

  return (
    <div className="now-bar">
      <Link className="now-bar-main" to="/listening" aria-label="Listening">
        {track.image ? (
          <img className="now-bar-art" src={track.image} alt="" loading="lazy" decoding="async" />
        ) : (
          <span className="now-bar-art art-placeholder" aria-hidden="true" />
        )}
        <span className="now-bar-text">
          <span className="now-bar-label">
            {live ? (
              <>
                <span className="now-dot" aria-hidden="true" /> Now playing
              </>
            ) : (
              <>Last played · {formatRelative(now!.lastPlayed!.uts)}</>
            )}
          </span>
          <span className="now-bar-track">
            <span className="now-bar-title">{track.track}</span>
            <span className="now-bar-artist">{track.artist}</span>
          </span>
        </span>
      </Link>
      <ListenLinks query={trackQuery(track.artist, track.track)} className="now-bar-links" />
    </div>
  )
}
