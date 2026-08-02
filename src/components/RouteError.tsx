import { useEffect, useState } from 'react'
import { Link, useLocation, useRouteError } from 'react-router-dom'
import {
  isStaleChunkError,
  readReloadMarker,
  shouldReload,
  writeReloadMarker,
} from '../lib/stale-build'

/**
 * What renders when a route fails instead of loading.
 *
 * Sits on each child route rather than the layout route, so the header, nav,
 * and footer survive a failure — you can navigate back out of it.
 *
 * The common failure by far is a stale build (see lib/stale-build.ts), and for
 * that this component is invisible: it reloads before anyone reads it. The
 * visible half is for everything else, plus the case where the reload itself
 * didn't help.
 */
export function RouteError() {
  const error = useRouteError()
  const location = useLocation()
  // `false` until we've decided, so the first paint is blank rather than a
  // flash of "something went wrong" on its way to a reload.
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
      // assign() rather than reload(): React Router has already committed the
      // navigation, so the address bar is on the destination — but assigning
      // the href we matched on is right either way, and it means the user lands
      // where they clicked instead of back where they started.
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
