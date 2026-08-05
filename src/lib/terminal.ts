// The shell behind /terminal. Pure: the outside world arrives as a `Shell`.
// Photo ids come from the route loader, not virtual:site-index (browser build has none).

import { imageUrl } from './images'
import { formatNumber, formatRelative } from './datetime'
import { tagSlug } from './tags'
import type { NowState } from './listening'
import type { Article, ReadingNow } from './reading'
import type { EntryPage } from './guestbook'

// ---- output --------------------------------------------------------------

export type Tone = 'default' | 'muted' | 'accent' | 'error' | 'prompt'

export interface Line {
  text: string
  tone?: Tone
  href?: string
  /** Printed before the link and left outside it, so it isn't underlined. */
  prefix?: string
  /** Right-hand column of a listing row. Laid out, not padded with spaces. */
  meta?: string
  image?: { src: string; alt: string }
}

const line = (text: string, tone?: Tone): Line => (tone ? { text, tone } : { text })
const link = (text: string, href: string): Line => ({ text, href })
const err = (text: string): Line => ({ text, tone: 'error' })
const muted = (text: string): Line => ({ text, tone: 'muted' })
const blank = (): Line => ({ text: '' })

// ---- the filesystem ------------------------------------------------------

export type NodeKind = 'dir' | 'post' | 'photo' | 'page'

export interface Node {
  name: string
  kind: NodeKind
  /** Where `open` goes. */
  to?: string
  /** The published `.md` that `cat` reads — posts, and the pages written as one. */
  source?: string
  /** Right-hand column in `ls`. */
  meta?: string
  /** Extra words `find` matches on. */
  keywords?: string
  children?: Node[]
}

export interface TerminalPost {
  path: string
  title: string
  date: string
  tags: string[]
}

export interface TerminalPhoto {
  id: string
  year: string
  thumb?: string
  src?: string
  alt: string
}

export interface SiteStats {
  posts: number
  words: number
  photos: number
  years: number
}

export const postFile = (path: string): string => `${path.split('/').filter(Boolean).pop()}.md`

/** The site as a directory tree; single pages sit at the root as files. */
export function buildTree(posts: TerminalPost[], photos: TerminalPhoto[]): Node {
  const postNodes: Node[] = posts.map((post) => ({
    name: postFile(post.path),
    kind: 'post',
    to: post.path,
    source: `${post.path}.md`,
    meta: post.date.slice(0, 10),
    keywords: `${post.title} ${post.tags.join(' ')}`,
  }))

  // Grouped by slug so casing can't split a tag, as /blog/tag/<slug> does.
  const byTag = new Map<string, { label: string; posts: Node[] }>()
  posts.forEach((post, i) => {
    for (const tag of post.tags) {
      const slug = tagSlug(tag)
      if (!slug) continue
      const group = byTag.get(slug) ?? { label: tag, posts: [] }
      group.posts.push(postNodes[i])
      byTag.set(slug, group)
    }
  })
  const tagNodes: Node[] = [...byTag.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([slug, group]) => ({
      name: slug,
      kind: 'dir' as const,
      to: `/blog/tag/${slug}`,
      meta: `${group.posts.length} ${group.posts.length === 1 ? 'post' : 'posts'}`,
      keywords: group.label,
      children: group.posts,
    }))

  // Year directories: five hundred names in one listing is not a listing.
  const byYear = new Map<string, Node[]>()
  for (const photo of photos) {
    const node: Node = {
      name: photo.id,
      kind: 'photo',
      to: `/photos/${photo.id}`,
      meta: photo.year,
      keywords: photo.alt,
    }
    byYear.set(photo.year, [...(byYear.get(photo.year) ?? []), node])
  }
  const yearNodes: Node[] = [...byYear.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([year, children]) => ({
      name: year,
      kind: 'dir' as const,
      to: `/photos#y${year}`,
      meta: `${children.length} ${children.length === 1 ? 'photo' : 'photos'}`,
      children,
    }))

  return {
    name: '',
    kind: 'dir',
    children: [
      {
        name: 'blog',
        kind: 'dir',
        to: '/blog',
        meta: `${posts.length} posts`,
        children: [
          {
            name: 'tags',
            kind: 'dir',
            to: '/blog',
            meta: `${tagNodes.length} tags`,
            children: tagNodes,
          },
          ...postNodes,
        ],
      },
      {
        name: 'photos',
        kind: 'dir',
        to: '/photos',
        meta: `${photos.length} photos`,
        children: [
          { name: 'map', kind: 'page', to: '/photos/map', meta: 'where they were taken' },
          ...yearNodes,
        ],
      },
      { name: 'about', kind: 'page', to: '/about', source: '/about.md', meta: 'who I am', keywords: 'bio me cailin' },
      // Reachable as a file (`cat now`, `open now`); typing `now` on its own is
      // still the command, which answers roughly the same question anyway.
      { name: 'now', kind: 'page', to: '/now', source: '/now.md', meta: 'what I am up to', keywords: 'currently today' },
      { name: 'listening', kind: 'page', to: '/listening', meta: 'music, from Last.fm', keywords: 'scrobbles now playing' },
      { name: 'reading', kind: 'page', to: '/reading', meta: 'books and articles', keywords: 'hardcover' },
      { name: 'timeline', kind: 'page', to: '/timeline', meta: 'one row per day', keywords: 'log activity' },
      // The two pages written as a single Markdown file publish their source the
      // way a post does, so `cat` reads them too.
      { name: 'projects', kind: 'page', to: '/projects', source: '/projects.md', meta: 'things I have built', keywords: 'software code apps' },
      { name: 'guestbook', kind: 'page', to: '/guestbook', meta: 'say hello', keywords: 'sign visitors' },
      { name: 'uses', kind: 'page', to: '/uses', source: '/uses.md', meta: 'what I use', keywords: 'gear setup hardware software tools' },
      { name: 'colophon', kind: 'page', to: '/colophon', source: '/colophon.md', meta: 'how this is built', keywords: 'about stack' },
      { name: 'privacy', kind: 'page', to: '/privacy', meta: 'what is and is not collected', keywords: 'cookies tracking' },
    ],
  }
}

/** Absolute path from `cwd` + arg, resolving `.`, `..`, `~`. Stops at the root. */
export function resolvePath(cwd: string, arg?: string): string {
  if (!arg || arg === '.') return cwd
  const fromRoot = arg.startsWith('/') || arg === '~' || arg.startsWith('~/')
  const parts = fromRoot ? [] : cwd.split('/').filter(Boolean)
  for (const segment of arg.replace(/^~/, '').split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') parts.pop()
    else parts.push(segment)
  }
  return `/${parts.join('/')}`
}

/** The node at an absolute path, or undefined. The root is `/`. */
export function findNode(root: Node, path: string): Node | undefined {
  let node: Node = root
  for (const segment of path.split('/').filter(Boolean)) {
    const next = node.children?.find((child) => child.name === segment)
    if (!next) return undefined
    node = next
  }
  return node
}

/** How a path is shown in the prompt: `~` for the root, `~/blog` below it. */
export const promptPath = (cwd: string): string => (cwd === '/' ? '~' : `~${cwd}`)

export const echoLine = (cwd: string, input: string): Line => ({
  text: `${promptPath(cwd)} $ ${input}`,
  tone: 'prompt',
})

// ---- commands ------------------------------------------------------------

export interface CommandSpec {
  name: string
  args?: string
  summary: string
}

/** Source of truth for `help`, completion, and did-you-mean. */
export const COMMANDS: CommandSpec[] = [
  { name: 'help', summary: 'What you are reading' },
  { name: 'ls', args: '[path]', summary: 'List what is here' },
  { name: 'cd', args: '[path]', summary: 'Change directory' },
  { name: 'pwd', summary: 'Print the working directory' },
  { name: 'cat', args: '<file>', summary: 'Print the Markdown source of a post or page' },
  { name: 'open', args: '[path]', summary: 'Open the real page on the site' },
  { name: 'find', args: '<words>', summary: 'Search posts, tags, and pages' },
  { name: 'photo', args: '[random|<id>]', summary: 'Show a photograph' },
  { name: 'now', summary: 'What is playing, and what I am reading' },
  { name: 'reading', summary: 'The shelf in full' },
  { name: 'guestbook', args: '[n]', summary: 'The most recent entries' },
  { name: 'sign', summary: 'Sign the guestbook' },
  { name: 'whoami', summary: 'Who I am, today' },
  { name: 'neofetch', summary: 'Site info, with a picture' },
  { name: 'theme', args: '[light|dark|system]', summary: 'Change the color theme' },
  { name: 'date', summary: 'The time where you are' },
  { name: 'echo', args: '<text>', summary: 'Print it back' },
  { name: 'history', summary: 'What you have typed' },
  { name: 'clear', summary: 'Clear the screen' },
  { name: 'exit', summary: 'Back to the ordinary site' },
]

const COMMAND_NAMES = COMMANDS.map((command) => command.name)

/** Split into command + args, keeping quoted arguments whole. */
export function tokenize(input: string): string[] {
  const tokens: string[] = []
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(input))) tokens.push(match[1] ?? match[2] ?? match[3])
  return tokens
}

/** The outside world, injected so commands stay testable. */
export interface Shell {
  navigate(to: string): void
  setTheme(theme: 'light' | 'dark' | 'system'): void
  theme(): string
  now(): Date
  random(): number
  fetchText(url: string): Promise<string>
  fetchNow(): Promise<NowState>
  fetchReading(): Promise<ReadingNow>
  fetchGuestbook(): Promise<EntryPage>
}

export interface ShellState {
  cwd: string
  tree: Node
  stats: SiteStats
  photos: TerminalPhoto[]
  history: string[]
}

export interface CommandResult {
  lines: Line[]
  cwd?: string
  clear?: boolean
}

/** Pad width for the left-aligned second column in `help` and `history`. */
const NAME_COLUMN = 34

function row(name: string, meta?: string): string {
  if (!meta) return name
  return name.length >= NAME_COLUMN ? `${name}  ${meta}` : name.padEnd(NAME_COLUMN) + meta
}

function sortChildren(children: Node[]): Node[] {
  return [...children].sort((a, b) => {
    if ((a.kind === 'dir') !== (b.kind === 'dir')) return a.kind === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

function lsLines(node: Node): Line[] {
  if (node.kind !== 'dir') return [{ text: node.name, meta: node.meta }]
  const children = node.children ?? []
  if (!children.length) return [muted('(empty)')]
  // Posts and photos keep their newest-first order; only the mixed root sorts.
  const ordered = children.some((child) => child.kind === 'post' || child.kind === 'photo')
    ? children
    : sortChildren(children)
  return ordered.map((child) => ({
    text: child.kind === 'dir' ? `${child.name}/` : child.name,
    meta: child.meta,
    href: child.kind === 'dir' ? undefined : child.to,
  }))
}

export function motd(stats: SiteStats): Line[] {
  return [
    line('cailinpitt.com', 'accent'),
    muted(
      `${formatNumber(stats.posts)} posts · ${formatNumber(stats.photos)} photographs · ${stats.years} years of data`,
    ),
    blank(),
    muted('`ls` to look around · `cat` to read a post · `help` for everything else'),
    muted('Tab completes · ↑ history · Ctrl-L clears · `exit` leaves'),
    blank(),
  ]
}

const CAMERA = [
  '    _________________ ',
  '   |  _____________  |',
  '   | |             | |',
  ' ==| |    .-----.   | |',
  '   | |   ( ( o ) )  | |',
  "   | |    '-----'   | |",
  '   | |_____________| |',
  '   |____[o]__________|',
]

function neofetch(state: ShellState, shell: Shell): Line[] {
  const { stats } = state
  const info: string[] = [
    'cailin@cailinpitt.com',
    '---------------------',
    `Host:    GitHub Pages + 4 Cloudflare Workers`,
    `OS:      prerendered React (vite-react-ssg)`,
    `Shell:   /terminal`,
    `Posts:   ${formatNumber(stats.posts)} (${formatNumber(stats.words)} words)`,
    `Photos:  ${formatNumber(stats.photos)} across ${stats.years} years`,
    `Theme:   ${shell.theme()}`,
  ]
  return CAMERA.map((art, i) => line(`${art}   ${info[i] ?? ''}`))
}

const pick = <T,>(items: T[], shell: Shell): T | undefined =>
  items.length ? items[Math.floor(shell.random() * items.length)] : undefined

function photoLines(photo: TerminalPhoto): Line[] {
  const src = imageUrl(photo.thumb ?? photo.src)
  return [
    link(photo.id, `/photos/${photo.id}`),
    ...(src ? [{ text: '', image: { src, alt: photo.alt } }] : []),
    muted(`${photo.year} · open ${photo.id} for the full frame`),
  ]
}

function articleLines(article: Article): Line[] {
  let host = article.site
  if (!host) {
    try {
      host = new URL(article.url).host
    } catch {
      host = article.url
    }
  }
  return [
    { text: article.title ?? article.url, href: article.url, prefix: '📄 ' },
    muted(`   ${host}`),
  ]
}

function nowPlayingLines({ nowPlaying, lastPlayed }: NowState): Line[] {
  const track = nowPlaying ?? lastPlayed
  if (!track) return [muted('Nothing scrobbled recently.')]
  return [
    line(`♪ ${track.track}`, 'accent'),
    line(`  ${track.artist}${track.album ? ` — ${track.album}` : ''}`),
    muted(nowPlaying ? '  playing now' : `  ${formatRelative(lastPlayed!.uts)}`),
  ]
}

function findLines(state: ShellState, query: string): Line[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return [err('find: give me something to look for')]

  const hits: Line[] = []
  const walk = (node: Node, path: string) => {
    for (const child of node.children ?? []) {
      const childPath = `${path === '/' ? '' : path}/${child.name}`
      // Ids only for photos; alt text would flood a common-word search.
      const haystack =
        child.kind === 'photo'
          ? child.name.toLowerCase()
          : `${child.name} ${child.keywords ?? ''}`.toLowerCase()
      if (terms.every((term) => haystack.includes(term))) {
        hits.push({ text: childPath, meta: child.meta, href: child.to })
      }
      if (child.children) walk(child, childPath)
    }
  }
  walk(state.tree, '/')

  if (!hits.length) return [muted(`No match for "${query}".`)]
  const shown = hits.slice(0, 20)
  return hits.length > shown.length
    ? [...shown, muted(`…and ${hits.length - shown.length} more`)]
    : shown
}

function didYouMean(typed: string): string | null {
  const near = COMMAND_NAMES.filter(
    (name) => name.startsWith(typed[0] ?? '') || name.includes(typed) || typed.includes(name),
  )
  return near.length ? near[0] : null
}

/** Run one line of input. */
export async function run(
  input: string,
  state: ShellState,
  shell: Shell,
): Promise<CommandResult> {
  const tokens = tokenize(input)
  if (!tokens.length) return { lines: [] }
  const [command, ...args] = tokens
  const rest = args.join(' ')

  switch (command) {
    case 'help':
      return {
        lines: [
          ...COMMANDS.map((spec) =>
            line(row(`${spec.name}${spec.args ? ` ${spec.args}` : ''}`, spec.summary)),
          ),
          blank(),
          muted('Tab completes · ↑ and ↓ walk your history · Ctrl-L clears'),
        ],
      }

    case 'ls': {
      const path = resolvePath(state.cwd, args[0])
      const node = findNode(state.tree, path)
      if (!node) return { lines: [err(`ls: ${args[0]}: no such file or directory`)] }
      return { lines: lsLines(node) }
    }

    case 'cd': {
      const path = resolvePath(state.cwd, args[0] ?? '/')
      const node = findNode(state.tree, path)
      if (!node) return { lines: [err(`cd: ${args[0]}: no such file or directory`)] }
      if (node.kind !== 'dir') {
        return { lines: [err(`cd: ${node.name}: not a directory (try \`open ${node.name}\`)`)] }
      }
      return { lines: [], cwd: path }
    }

    case 'pwd':
      return { lines: [line(state.cwd)] }

    case 'cat': {
      if (!args[0]) return { lines: [err('cat: which post?')] }
      const node = findNode(state.tree, resolvePath(state.cwd, args[0]))
      if (!node) return { lines: [err(`cat: ${args[0]}: no such file or directory`)] }
      if (!node.source) {
        return {
          lines: [
            err(`cat: ${node.name}: nothing to read`),
            ...(node.to ? [muted(`It's a page — try \`open ${node.name}\`.`)] : []),
          ],
        }
      }
      // The published .md itself, so it can't disagree with the post page.
      try {
        const source = await shell.fetchText(node.source)
        return {
          lines: [
            ...source.replace(/\n+$/, '').split('\n').map((text) => line(text)),
            blank(),
            link(`— ${node.source}`, node.source),
          ],
        }
      } catch {
        return { lines: [err(`cat: ${node.name}: could not read it`)] }
      }
    }

    case 'open': {
      const node = findNode(state.tree, resolvePath(state.cwd, args[0]))
      const to = node?.to ?? (state.cwd === '/' ? '/' : undefined)
      if (!to) return { lines: [err(`open: ${args[0] ?? state.cwd}: nowhere to go`)] }
      shell.navigate(to)
      return { lines: [muted(`Opening ${to}…`)] }
    }

    case 'find':
    case 'grep':
      return { lines: findLines(state, rest) }

    case 'photo': {
      if (!state.photos.length) return { lines: [muted('No photographs loaded.')] }
      if (!args[0] || args[0] === 'random') {
        const photo = pick(state.photos, shell)
        return { lines: photo ? photoLines(photo) : [muted('No photographs loaded.')] }
      }
      const photo = state.photos.find((candidate) => candidate.id === args[0])
      return photo
        ? { lines: photoLines(photo) }
        : { lines: [err(`photo: ${args[0]}: no such photograph`)] }
    }

    case 'now': {
      // Two Workers, one answer. Either can be down without taking the other's
      // half of the screen with it.
      const [music, reading] = await Promise.allSettled([
        shell.fetchNow(),
        shell.fetchReading(),
      ])
      const lines: Line[] =
        music.status === 'fulfilled'
          ? nowPlayingLines(music.value)
          : [err('now: the listening Worker did not answer')]

      if (reading.status === 'fulfilled') {
        for (const book of reading.value.currentlyReading) {
          lines.push(blank(), line(`📖 ${book.title}`, 'accent'))
          lines.push(muted(`   ${book.authors ?? 'Unknown'}`))
        }
        const article = reading.value.todaysArticle
        if (article) lines.push(blank(), ...articleLines(article))
      }
      return { lines }
    }

    case 'reading': {
      try {
        const { currentlyReading, lastFinished, todaysArticle } = await shell.fetchReading()
        const lines: Line[] = []
        for (const book of currentlyReading) {
          lines.push(line(`📖 ${book.title}`, 'accent'), muted(`   ${book.authors ?? 'Unknown'}`))
        }
        if (!lines.length && lastFinished) {
          lines.push(
            muted('Nothing in progress. Last finished:'),
            line(`📖 ${lastFinished.title}`, 'accent'),
            muted(`   ${lastFinished.authors ?? 'Unknown'}`),
          )
        }
        if (!lines.length) lines.push(muted('Nothing in progress.'))
        if (todaysArticle) lines.push(blank(), ...articleLines(todaysArticle))
        return { lines: [...lines, blank(), link('The whole shelf → /reading', '/reading')] }
      } catch {
        return { lines: [err('reading: the reading Worker did not answer')] }
      }
    }

    case 'guestbook': {
      const limit = Math.min(Math.max(Number(args[0]) || 5, 1), 25)
      try {
        const page = await shell.fetchGuestbook()
        const entries = page.entries.slice(0, limit)
        if (!entries.length) return { lines: [muted('Nobody has signed yet. Be the first: `sign`')] }
        const lines: Line[] = []
        for (const entry of entries) {
          lines.push(line(`${entry.name}${entry.location ? ` · ${entry.location}` : ''}`, 'accent'))
          lines.push(line(`  ${entry.message.replace(/\s+/g, ' ')}`))
          lines.push(muted(`  ${formatRelative(entry.createdAt)}`))
        }
        return {
          lines: [
            ...lines,
            blank(),
            muted(`${formatNumber(page.total)} signatures in total · \`sign\` to add yours`),
          ],
        }
      } catch {
        return { lines: [err('guestbook: the guestbook Worker did not answer')] }
      }
    }

    case 'sign':
      // Writes need the real form's Turnstile challenge; don't reinvent it.
      shell.navigate('/guestbook')
      return { lines: [muted('Opening the guestbook…')] }

    case 'whoami': {
      const { identities, descriptions } = await import('../../content/identity')
      const who = pick(identities, shell) ?? identities[0]
      const what = pick(descriptions, shell) ?? descriptions[0]
      return {
        lines: [
          line('cailin'),
          line(`Cailin is ${who} who ${what}.`),
          blank(),
          link('github.com/CailinPitt', 'https://github.com/CailinPitt'),
        ],
      }
    }

    case 'neofetch':
      return { lines: neofetch(state, shell) }

    case 'theme': {
      const wanted = args[0]
      if (wanted !== 'light' && wanted !== 'dark' && wanted !== 'system') {
        return {
          lines: [
            line(`Theme is ${shell.theme()}.`),
            muted('Usage: theme light | dark | system'),
          ],
        }
      }
      shell.setTheme(wanted)
      return { lines: [muted(`Theme set to ${wanted}.`)] }
    }

    case 'date':
      return { lines: [line(shell.now().toString())] }

    case 'echo':
      return { lines: [line(rest)] }

    case 'history':
      return {
        lines: state.history.length
          ? state.history.map((entry, i) => line(row(`${i + 1}`.padStart(4), entry)))
          : [muted('Nothing yet.')],
      }

    case 'clear':
      return { lines: [], clear: true }

    case 'exit':
      shell.navigate('/')
      return { lines: [muted('Bye.')] }

    // Easter eggs.
    case 'sudo':
      return { lines: [err('cailin is not in the sudoers file. This incident has been reported.')] }
    case 'rm':
      return { lines: [muted("Everything here is in git. You can't hurt it.")] }
    case 'man':
      return { lines: [muted(`No manual entry for ${args[0] ?? 'that'}. Try \`help\`.`)] }

    default: {
      const suggestion = didYouMean(command)
      return {
        lines: [
          err(`${command}: command not found`),
          ...(suggestion ? [muted(`Did you mean \`${suggestion}\`?`)] : []),
        ],
      }
    }
  }
}

// ---- tab completion ------------------------------------------------------

export function commonPrefix(values: string[]): string {
  if (!values.length) return ''
  let prefix = values[0]
  for (const value of values.slice(1)) {
    while (prefix && !value.startsWith(prefix)) prefix = prefix.slice(0, -1)
  }
  return prefix
}

export interface Completion {
  input: string
  /** Populated only when ambiguous. */
  candidates: string[]
}

/** Complete the last token: a command in first position, a path after it. */
export function complete(input: string, state: ShellState): Completion {
  const trailingSpace = /\s$/.test(input)
  const tokens = tokenize(input)
  const completingCommand = tokens.length === 0 || (tokens.length === 1 && !trailingSpace)
  const partial = trailingSpace ? '' : (tokens[tokens.length - 1] ?? '')

  // `cat blog/pa` completes `pa` inside `blog/` and must keep the `blog/`.
  const kept = completingCommand ? [] : trailingSpace ? tokens : tokens.slice(0, -1)
  const cut = partial.lastIndexOf('/')
  const dir = completingCommand || cut < 0 ? '' : partial.slice(0, cut + 1)
  const fragment = completingCommand ? partial : cut < 0 ? partial : partial.slice(cut + 1)

  const names = completingCommand
    ? COMMAND_NAMES.filter((name) => name.startsWith(fragment))
    : (findNode(state.tree, resolvePath(state.cwd, dir || '.'))?.children ?? [])
        .filter((child) => child.name.startsWith(fragment))
        .map((child) => (child.kind === 'dir' ? `${child.name}/` : child.name))

  if (!names.length) return { input, candidates: [] }

  const prefix = commonPrefix(names)
  const settled = names.length === 1 && !prefix.endsWith('/')
  const head = kept.length ? `${kept.join(' ')} ` : ''
  return {
    input: `${head}${dir}${prefix}${settled ? ' ' : ''}`,
    candidates: names.length > 1 ? names : [],
  }
}
