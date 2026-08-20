import { useEffect, useState } from 'react'
import { Link, useLocation, useRouteError } from 'react-router-dom'
import {
  isStaleChunkError,
  readReloadMarker,
  shouldReload,
  writeReloadMarker,
} from '../lib/stale-build'

/**
 * What renders when a route fails instead of loading. Sits on each child route
 * (not the layout route) so header/nav/footer survive and you can navigate out.
 * Invisible for the common case, a stale build (lib/stale-build.ts) — it
 * reloads before anyone reads it; visible otherwise.
 */
export function RouteError() {
  const error = useRouteError()
  const location = useLocation()
  // Starts false so the first paint is blank, not a flash of the error on the way to a reload.
  const [showMessage, setShowMessage] = useState(false)

  const href = location.pathname + location.search + location.hash

  useEffect(() => {
    if (!isStaleChunkError(error)) {
      setShowMessage(true)
      return
    }

    const marker = { href, at: Date.now() }
    if (
      shouldReload(readReloadMarker(window.sessionStorage), href, marker.at) &&
      writeReloadMarker(window.sessionStorage, marker)
    ) {
      // assign() not reload(): Router already committed the nav, so this lands on the destination the user clicked.
      window.location.assign(href)
      return
    }

    // The reload didn't fix it. Stop, and let the person decide.
    setShowMessage(true)
  }, [error, href])

  if (!showMessage) return null

  return (
    <article className="route-error">
      <h1>This page didn&rsquo;t load</h1>
      <p>
        Something went wrong fetching it. Reloading usually sorts it out; if it doesn&rsquo;t, the
        page is probably broken and I&rsquo;d rather you knew that than kept trying.
      </p>
      <p>
        <button type="button" className="route-error-retry" onClick={() => window.location.reload()}>
          Reload
        </button>{' '}
        or <Link to="/">go home</Link>.
      </p>
    </article>
  )
}
