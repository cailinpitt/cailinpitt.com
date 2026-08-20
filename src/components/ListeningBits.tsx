// Shared presentation for /listening and /listening/<year>, so the two can't drift apart.

import { ListenLinks } from './ListenLinks'
import {
  albumQuery,
  formatNumber,
  trackQuery,
  type AlbumStat,
  type ArtistStat,
  type TrackStat,
} from '../lib/listening'

export function Art({ src, alt, className }: { src: string | null; alt: string; className: string }) {
  if (!src) return <span className={`${className} art-placeholder`} aria-hidden="true" />
  return <img src={src} alt={alt} className={className} loading="lazy" decoding="async" />
}

export function StatTile({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="stat-tile">
      <dt>{label}</dt>
      <dd>{typeof value === 'number' ? formatNumber(value) : value}</dd>
    </div>
  )
}

// Single series, so counts are direct-labeled instead of needing a legend.
export function TopArtists({ artists }: { artists: ArtistStat[] }) {
  const max = artists[0]?.count ?? 1
  return (
    <div className="top-block">
      <h3 className="top-title">Top artists</h3>
      <ol className="bar-list">
        {artists.map((a) => (
          <li key={a.name}>
            <span className="bar-label">{a.name}</span>
            <span className="bar-track" aria-hidden="true">
              <span className="bar-fill" style={{ width: `${(a.count / max) * 100}%` }} />
            </span>
            <span className="bar-value">{formatNumber(a.count)}</span>
          </li>
        ))}
      </ol>
    </div>
  )
}

export function TopAlbums({ albums }: { albums: AlbumStat[] }) {
  return (
    <div className="top-block">
      <h3 className="top-title">Top albums</h3>
      <ol className="rank-list">
        {albums.map((a) => (
          <li key={`${a.album}—${a.artist}`}>
            <Art src={a.image} alt="" className="rank-art" />
            <span className="rank-meta">
              <span className="rank-primary">{a.album}</span>
              <span className="rank-secondary">{a.artist}</span>
            </span>
            <span className="rank-count">{formatNumber(a.count)}</span>
            <ListenLinks query={albumQuery(a.artist, a.album)} />
          </li>
        ))}
      </ol>
    </div>
  )
}

export function TopTracks({ tracks }: { tracks: TrackStat[] }) {
  return (
    <div className="top-block">
      <h3 className="top-title">Top tracks</h3>
      <ol className="rank-list">
        {tracks.map((t) => (
          <li key={`${t.track}—${t.artist}`}>
            <Art src={t.image} alt="" className="rank-art" />
            <span className="rank-meta">
              <span className="rank-primary">{t.track}</span>
              <span className="rank-secondary">{t.artist}</span>
            </span>
            <span className="rank-count">{formatNumber(t.count)}</span>
            <ListenLinks query={trackQuery(t.artist, t.track)} />
          </li>
        ))}
      </ol>
    </div>
  )
}
