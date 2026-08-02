import { byNewest, type Photo } from './photos'
import { datedPhotos } from './timeline'
import { toPost, type AtprotoData, type Post, type PostSummary } from './posts'

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

export async function loadPhotos(): Promise<Photo[]> {
  const path = await import('node:path')
  const { readFile } = await import('node:fs/promises')
  const manifest = JSON.parse(
    await readFile(path.join(process.cwd(), 'src', 'lib', 'photos.json'), 'utf8'),
  ) as Photo[]
  return manifest.sort(byNewest)
}

export async function loadDatedPhotos(): Promise<Photo[]> {
  return datedPhotos(await loadPhotos())
}
