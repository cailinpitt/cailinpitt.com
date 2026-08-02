import { useEffect, useRef, useState, type RefObject } from 'react'

interface ReadingProgressProps {
  /** The element being read — progress is measured across this, not the page. */
  targetRef: RefObject<HTMLElement | null>
}

/**
 * A hairline at the top of the window that fills as you read a post.
 *
 * It tracks the *article*, not the document: the bar hits 100% when the last
 * line of the post reaches the bottom of the window, so the related-posts list,
 * the newer/older nav, and the footer don't read as another 15% left to go.
 *
 * Nothing renders until there is something to track — a post shorter than the
 * window can't be scrolled through, and a progress bar stuck at either end is
 * just a stripe across the page. That also keeps it off the prerendered HTML,
 * so it can't flash in before hydration measures anything.
 */
export function ReadingProgress({ targetRef }: ReadingProgressProps) {
  const [progress, setProgress] = useState<number | null>(null)
  // Written from the scroll handler and read on the next frame, so a burst of
  // scroll events costs one measurement rather than one per event.
  const frame = useRef<number | null>(null)

  useEffect(() => {
    const el = targetRef.current
    if (!el) return

    const measure = () => {
      frame.current = null
      const top = el.getBoundingClientRect().top + window.scrollY
      // How far the page scrolls between the article's first line reaching the
      // top of the window and its last line reaching the bottom.
      const distance = el.offsetHeight - window.innerHeight
      if (distance <= 0) {
        setProgress(null)
        return
      }
      const scrolled = (window.scrollY - top) / distance
      setProgress(Math.min(1, Math.max(0, scrolled)))
    }

    const schedule = () => {
      if (frame.current === null) frame.current = requestAnimationFrame(measure)
    }

    measure()
    window.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    // Images and embeds land after first paint and change the article's height,
    // which moves the finish line. Without this the bar reads short on a photo
    // essay until something else happens to trigger a re-measure.
    const observer = new ResizeObserver(schedule)
    observer.observe(el)

    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current)
      window.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      observer.disconnect()
    }
  }, [targetRef])

  if (progress === null) return null

  return (
    // Decorative: it says nothing a screen reader can't get from where it already
    // is in the document, and announcing a value that changes on every scroll
    // frame would be noise.
    <div className="reading-progress" aria-hidden="true">
      <div className="reading-progress-fill" style={{ transform: `scaleX(${progress})` }} />
    </div>
  )
}
