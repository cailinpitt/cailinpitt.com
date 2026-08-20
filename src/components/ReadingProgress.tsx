import { useEffect, useRef, useState, type RefObject } from 'react'

interface ReadingProgressProps {
  /** Progress is measured across this element, not the page. */
  targetRef: RefObject<HTMLElement | null>
}

// Tracks the *article*, not the document: hits 100% when the post's last line
// reaches the bottom of the window, so the related-posts list and footer
// don't read as another 15% left to go. Renders nothing until there's
// something to track, which also keeps it off the prerendered HTML.
export function ReadingProgress({ targetRef }: ReadingProgressProps) {
  const [progress, setProgress] = useState<number | null>(null)
  // Written from the scroll handler, read next frame — a burst of scroll
  // events costs one measurement, not one per event.
  const frame = useRef<number | null>(null)

  useEffect(() => {
    const el = targetRef.current
    if (!el) return

    const measure = () => {
      frame.current = null
      const top = el.getBoundingClientRect().top + window.scrollY
      // Distance scrolled between the article's first line hitting the top
      // and its last line hitting the bottom.
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
    // Images/embeds land after first paint and change the article's height,
    // moving the finish line — without this the bar reads short until
    // something else triggers a re-measure.
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
    // aria-hidden: a value that changes on every scroll frame would be noise,
    // and a screen reader already has this from its place in the document.
    <div className="reading-progress" aria-hidden="true">
      <div className="reading-progress-fill" style={{ transform: `scaleX(${progress})` }} />
    </div>
  )
}
