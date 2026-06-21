import { galleryDefinitions, type Gallery, type GalleryImage } from './galleries'
import { toPost, type AtprotoData, type Post, type PostSummary } from './posts'

export interface GallerySummary extends Omit<Gallery, 'images'> {
  cover?: GalleryImage
}

async function loadAtproto(): Promise<AtprotoData> {
  const path = await import('node:path')
  const { readFile } = await import('node:fs/promises')
  try {
    return JSON.parse(await readFile(path.join(process.cwd(), 'content', 'atproto.json'), 'utf8'))
  } catch {
    return { did: null, publication: null, documents: {} }
  }
}

export async function loadPosts(): Promise<Post[]> {
  const path = await import('node:path')
  const { readFile, readdir } = await import('node:fs/promises')
  const blogDir = path.join(process.cwd(), 'content', 'blog')
  const atproto = await loadAtproto()
  const files = (await readdir(blogDir)).filter((file) => file.endsWith('.md'))
  const posts = await Promise.all(
    files.map(async (file) =>
      toPost(path.join(blogDir, file), await readFile(path.join(blogDir, file), 'utf8'), atproto),
    ),
  )
  return posts.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
}

export async function loadPostSummaries(): Promise<PostSummary[]> {
  return (await loadPosts()).map(({ body: _body, ...post }) => post)
}

export async function loadPublicationUri(): Promise<string | null> {
  return (await loadAtproto()).publication
}

export async function loadGalleries(): Promise<Gallery[]> {
  const path = await import('node:path')
  const { readFile } = await import('node:fs/promises')
  const manifest = JSON.parse(
    await readFile(path.join(process.cwd(), 'src', 'lib', 'gallery-images.json'), 'utf8'),
  ) as Record<string, GalleryImage[]>

  return galleryDefinitions.map(({ imageKey, ...gallery }) => ({
    ...gallery,
    images: manifest[imageKey] ?? [],
  }))
}

export async function loadGallerySummaries(): Promise<GallerySummary[]> {
  return (await loadGalleries()).map(({ images, ...gallery }) => ({
    ...gallery,
    cover: images[0],
  }))
}
