export interface GalleryImage {
  src: string
  alt: string
  /** Explicit original dimensions to set the aspect ratio and prevent layout shift. */
  width?: number
  height?: number
}

export interface Gallery {
  /** Exact URL path, preserved from Squarespace, e.g. /2022 or /past-work */
  path: string
  title: string
  description?: string
  images: GalleryImage[]
  /** Canonical path, when this gallery is an alias of another (e.g. /past-work → /2022). */
  canonicalPath?: string
}

// All images (galleries + blog) are served from R2; see src/lib/images.ts.
export { imageUrl } from './images'

export interface GalleryDefinition extends Omit<Gallery, 'images'> {
  imageKey: string
}

// Route metadata stays in the client bundle; the much larger image manifest is
// loaded by server-only route loaders in content.server.ts.
export const galleryDefinitions: GalleryDefinition[] = [
  { path: '/2022', title: '2022', imageKey: '2022' },
  { path: '/2021', title: '2021', imageKey: '2021' },
  { path: '/2020', title: '2020', imageKey: '2020' },
  { path: '/2019', title: '2019', imageKey: '2019' },
  { path: '/2018', title: '2018', imageKey: '2018' },
  { path: '/latest-work', title: '2017', imageKey: 'latest-work' },
  { path: '/latest', title: '2016', imageKey: 'latest' },
  { path: '/2015', title: '2015', imageKey: '2015' },
  { path: '/2014', title: '2014', imageKey: '2014' },
  // /past-work historically redirected to /2022; keep the URL working as an alias.
  { path: '/past-work', title: 'Past Work', imageKey: '2022', canonicalPath: '/2022' },
]
