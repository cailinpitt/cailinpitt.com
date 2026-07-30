import { appleMusicSearchUrl, spotifySearchUrl } from '../lib/listening'

/** Small Spotify + Apple Music search links for a song/album. */
export function ListenLinks({ query, className }: { query: string; className?: string }) {
  return (
    <span className={className ? `listen-links ${className}` : 'listen-links'}>
      <a
        className="listen-link"
        href={spotifySearchUrl(query)}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Search Spotify for ${query}`}
        title="Search on Spotify"
      >
        <SpotifyIcon />
      </a>
      <a
        className="listen-link"
        href={appleMusicSearchUrl(query)}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Search Apple Music for ${query}`}
        title="Search on Apple Music"
      >
        <AppleIcon />
      </a>
    </span>
  )
}

function SpotifyIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
      <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.52 17.34c-.24.36-.66.48-1.02.24-2.82-1.74-6.36-2.1-10.56-1.14-.42.12-.78-.18-.9-.54-.12-.42.18-.78.54-.9 4.56-1.02 8.52-.6 11.64 1.32.42.18.48.66.3 1.02zm1.44-3.3c-.3.42-.84.6-1.26.3-3.24-1.98-8.16-2.58-11.94-1.38-.48.12-1.02-.12-1.14-.6-.12-.48.12-1.02.6-1.14 4.38-1.32 9.78-.66 13.5 1.62.36.18.54.78.24 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.1 9.3c-.6.18-1.2-.18-1.38-.72-.18-.6.18-1.2.72-1.38 4.32-1.32 11.4-1.02 15.9 1.62.54.3.72 1.02.42 1.56-.24.48-.96.66-1.5.36z" />
    </svg>
  )
}

function AppleIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
      <path d="M17.05 12.04c-.03-2.85 2.33-4.22 2.43-4.29-1.32-1.94-3.38-2.2-4.11-2.23-1.75-.18-3.41 1.03-4.29 1.03-.88 0-2.25-1.01-3.7-.98-1.9.03-3.66 1.11-4.64 2.81-1.98 3.43-.51 8.5 1.42 11.28.94 1.36 2.06 2.89 3.53 2.83 1.42-.06 1.96-.92 3.67-.92 1.71 0 2.2.92 3.7.89 1.53-.03 2.5-1.39 3.44-2.75 1.08-1.58 1.53-3.11 1.55-3.19-.03-.02-2.98-1.14-3.01-4.53l.01-.03zM14.28 4.5c.78-.94 1.3-2.26 1.16-3.57-1.12.05-2.48.75-3.28 1.69-.72.83-1.35 2.16-1.18 3.43 1.25.1 2.52-.63 3.3-1.55z" />
    </svg>
  )
}
