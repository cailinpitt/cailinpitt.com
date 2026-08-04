/**
 * Jump to an element and stay there while the page finishes loading.
 *
 * A plain `href="#id"` is enough on a page whose layout is final, and this one
 * isn't: a post's images are markdown `<img>` tags with no width or height, so
 * each reserves no space until it paints. Click a link to the foot of the page
 * before the cover image arrives and the browser scrolls correctly — then the
 * image lands, everything below it drops by its height, and the target is a
 * screen or two below the reader. It reads as "the button didn't work", and
 * clicking again works because by then the image is cached.
 *
 * So: scroll, then scroll again once the images that were still in flight have
 * settled. The second pass is skipped the moment the reader takes over — being
 * yanked somewhere a second later is worse than the problem.
 */

/** How long to keep watching before deciding the page is as settled as it gets. */
const SETTLE_TIMEOUT_MS = 5000

export function jumpToAnchor(id: string): void {
  const target = document.getElementById(id)
  if (!target) return

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  target.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' })

  const pending = Array.from(document.images).filter((image) => !image.complete)
  if (pending.length === 0) return

  let left = pending.length
  let cancelled = false
  const cleanup: (() => void)[] = []

  const finish = () => {
    cancelled = true
    for (const off of cleanup) off()
  }

  // Any deliberate scroll means the reader has chosen where to be.
  for (const event of ['wheel', 'touchstart', 'keydown'] as const) {
    const cancel = () => finish()
    window.addEventListener(event, cancel, { once: true, passive: true })
    cleanup.push(() => window.removeEventListener(event, cancel))
  }
  const timer = setTimeout(finish, SETTLE_TIMEOUT_MS)
  cleanup.push(() => clearTimeout(timer))

  const settled = () => {
    if (cancelled || --left > 0) return
    finish()
    // No smooth scroll for the correction: it's fixing a jump that already
    // happened, not making a new one.
    target.scrollIntoView({ behavior: 'auto', block: 'start' })
  }

  for (const image of pending) {
    image.addEventListener('load', settled, { once: true })
    image.addEventListener('error', settled, { once: true })
    cleanup.push(() => {
      image.removeEventListener('load', settled)
      image.removeEventListener('error', settled)
    })
  }
}
