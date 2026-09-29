import { useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { SavedFilter } from './reading'

/** ?q= and ?site= on /links and /reading/articles, so a filtered view can be shared. */
export function useSavedFilter() {
  const [params, setParams] = useSearchParams()
  const q = params.get('q') ?? ''
  const site = params.get('site') ?? ''

  const filter = useMemo<Required<SavedFilter>>(() => ({ q, site }), [q, site])

  const set = useCallback(
    (key: 'q' | 'site', value: string) =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          if (value.trim()) next.set(key, value)
          else next.delete(key)
          return next
        },
        { replace: true },
      ),
    [setParams],
  )

  return {
    filter,
    filtered: Boolean(q.trim() || site),
    setQ: useCallback((value: string) => set('q', value), [set]),
    setSite: useCallback((value: string) => set('site', value), [set]),
  }
}
