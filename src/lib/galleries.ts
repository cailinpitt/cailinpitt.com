export interface GalleryImage {
  src: string
  alt: string
  /** Optional explicit dimensions to prevent layout shift (recommended). */
  width?: number
  height?: number
}

export interface Gallery {
  /** Exact URL path, preserved from Squarespace, e.g. /2022 or /past-work */
  path: string
  title: string
  description?: string
  images: GalleryImage[]
}

// These mirror the existing Squarespace gallery URLs. The `images` arrays are populated
// by the image-migration step (scripts/download-images.mjs writes files into
// /public/images/<gallery>/ and you reference them here). Stubbed empty for now so routes
// exist and the site builds before the photos are migrated.
export const galleries: Gallery[] = [
  { path: '/past-work', title: 'Past Work', images: [] },
  { path: '/latest-work', title: 'Latest Work (2017)', images: [] },
  { path: '/latest', title: 'Latest (2016)', images: [] },
  { path: '/2022', title: '2022', images: [] },
  { path: '/2021', title: '2021', images: [] },
  { path: '/2020', title: '2020', images: [] },
  { path: '/2019', title: '2019', images: [] },
  { path: '/2018', title: '2018', images: [] },
  { path: '/2017', title: '2017', images: [] },
  { path: '/2016', title: '2016', images: [] },
  { path: '/2015', title: '2015', images: [] },
  { path: '/2014', title: '2014', images: [] },
]
