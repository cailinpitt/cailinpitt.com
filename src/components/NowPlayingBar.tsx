import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { fetchNow, formatRelative, trackQuery, type NowState } from '../lib/listening'
import { ListenLinks } from './ListenLinks'

const POLL_MS = 60_000

// Now-playing strip, client-fetched from /now.json (renders nothing until it
// has data). Polling pauses while the tab is hidden — /now.json is a KV read
// per request by design, so a background tab was wasting 1,440 reads/day;
// refreshing on visibility-return keeps it current the moment it's seen again.
export function NowPlayingBar() {
  const [now, setNow] = useState<NowState | null>(null)

  useEffect(() => {
    let active = true
    let id: ReturnType<typeof setInterval> | undefined
    const controller = new AbortController()

    const load = async () => {
      try {
        const data = await fetchNow(controller.signal)
        if (active) setNow(data)
      } catch {
        /* leave the bar hidden on error */
      }
    }

    const stop = () => {
      if (id) clearInterval(id)
      id = undefined
    }
    const start = () => {
      stop()
      id = setInterval(load, POLL_MS)
    }

    const onVisibility = () => {
      if (document.hidden) {
        stop()
      } else {
        void load()
        start()
      }
    }

    void load()
    if (!document.hidden) start()
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      active = false
      controller.abort()
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
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
