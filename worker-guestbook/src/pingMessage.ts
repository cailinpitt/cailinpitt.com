// No worker imports, so the site's tests can use it directly.
type EntryFields = {
  name: string
  message: string
  location: string | null
  country: string | null
}

export interface PingMessage {
  title: string
  body: string
  click: string
}

export function entryPing(entry: EntryFields): PingMessage {
  const where = entry.location ?? entry.country
  return {
    title: where ? `${entry.name} · ${where}` : entry.name,
    body: entry.message,
    click: 'https://cailinpitt.com/guestbook',
  }
}
