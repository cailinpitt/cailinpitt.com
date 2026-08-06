import { describe, expect, it } from 'vitest'
import {
  buildTree,
  COMMANDS,
  complete,
  commonPrefix,
  findNode,
  postFile,
  promptPath,
  resolvePath,
  run,
  tokenize,
  type Shell,
  type ShellState,
  type TerminalPhoto,
  type TerminalPost,
} from '../src/lib/terminal'

const posts: TerminalPost[] = [
  { path: '/blog/2026/8/1/seasons', title: 'Seasons', date: '2026-08-01', tags: ['Music'] },
  { path: '/blog/2023/3/3/paramore', title: 'Paramore', date: '2023-03-03', tags: ['music'] },
  { path: '/blog/2019/2/2/cleveland', title: 'Cleveland', date: '2019-02-02', tags: ['travel'] },
]

const photos: TerminalPhoto[] = [
  { id: '2026-img-1', year: '2026', thumb: '/images/2026/a-1000.webp', alt: 'A street' },
  { id: '2026-img-2', year: '2026', thumb: '/images/2026/b-1000.webp', alt: 'A bridge' },
  { id: '2019-img-9', year: '2019', thumb: '/images/2019/c-1000.webp', alt: 'A lake' },
]

const book = {
  userBookId: 1,
  readId: 1,
  title: 'The Bee Sting',
  authors: 'Paul Murray',
  slug: null,
  cover: null,
  pages: null,
  rating: null,
  statusId: 2,
  startedAt: null,
  finishedAt: null,
}

const article = {
  id: 'a1',
  url: 'https://example.com/a-piece',
  title: 'A piece',
  site: null,
  excerpt: null,
  image: null,
  note: null,
  readAt: 1,
}

const film = {
  id: 'office-space|2026-07-25',
  title: 'Office Space',
  year: 1999,
  slug: 'office-space',
  watchedDate: '2026-07-25',
  rewatch: true,
  rating: 3.5,
  liked: false,
  poster: null,
}

const ride = {
  id: '19614959439',
  sportType: 'EBikeRide',
  kind: 'ebike' as const,
  startDate: '2026-08-05',
  distanceMi: 10.1,
  elevationFt: 120,
  movingTime: 2400,
  trainer: false,
}

const tree = buildTree(posts, photos)

const state = (cwd = '/'): ShellState => ({
  cwd,
  tree,
  stats: { posts: posts.length, words: 1234, photos: photos.length, years: 2 },
  photos,
  history: [],
})

function fakeShell(overrides: Partial<Shell> = {}) {
  const navigated: string[] = []
  const shell: Shell = {
    navigate: (to) => navigated.push(to),
    setTheme: () => {},
    theme: () => 'light',
    now: () => new Date('2026-08-03T12:00:00Z'),
    random: () => 0,
    fetchText: async () => '---\ntitle: "Seasons"\n---\n\nThe body.\n',
    fetchNow: async () => ({
      nowPlaying: null,
      lastPlayed: { track: 'Hard Times', artist: 'Paramore', album: null, image: null, uts: 1 },
      updatedAt: 0,
    }),
    fetchReading: async () => ({
      currentlyReading: [book],
      lastFinished: null,
      todaysArticle: article,
      updatedAt: 0,
    }),
    fetchWatching: async () => ({ lastFilm: film, updatedAt: 0 }),
    fetchMoving: async () => ({ lastActivity: ride, updatedAt: 0 }),
    fetchGuestbook: async () => ({ entries: [], nextCursor: null, total: 0 }),
    ...overrides,
  }
  return { shell, navigated }
}

describe('resolvePath', () => {
  it('resolves relative, absolute, and home paths', () => {
    expect(resolvePath('/blog', 'tags')).toBe('/blog/tags')
    expect(resolvePath('/blog', '/photos')).toBe('/photos')
    expect(resolvePath('/blog', '~')).toBe('/')
    expect(resolvePath('/blog', '~/photos')).toBe('/photos')
    expect(resolvePath('/blog', undefined)).toBe('/blog')
    expect(resolvePath('/blog', '.')).toBe('/blog')
  })

  it('stops at the root rather than climbing above it', () => {
    expect(resolvePath('/blog/tags', '../..')).toBe('/')
    expect(resolvePath('/', '../../..')).toBe('/')
  })
})

describe('the tree', () => {
  it('puts multi-item sections in directories and single pages at the root', () => {
    const names = (tree.children ?? []).map((child) => child.name)
    expect(names).toContain('blog')
    expect(names).toContain('photos')
    expect(names).toContain('listening')
    expect(names).toContain('guestbook')
  })

  it('names a post file after the last segment of its URL', () => {
    expect(postFile('/blog/2023/3/3/paramore')).toBe('paramore.md')
    expect(findNode(tree, '/blog/paramore.md')?.to).toBe('/blog/2023/3/3/paramore')
  })

  it('gives every post a Markdown source to read', () => {
    const post = findNode(tree, '/blog/seasons.md')
    expect(post?.source).toBe('/blog/2026/8/1/seasons.md')
  })

  it('collapses tag casing the way /blog/tag/<slug> does', () => {
    const tags = findNode(tree, '/blog/tags')?.children ?? []
    expect(tags.map((tag) => tag.name)).toEqual(['music', 'travel'])
    expect(findNode(tree, '/blog/tags/music')?.children).toHaveLength(2)
  })

  it('groups photos by year, newest first', () => {
    const years = (findNode(tree, '/photos')?.children ?? [])
      .filter((child) => child.kind === 'dir')
      .map((child) => child.name)
    expect(years).toEqual(['2026', '2019'])
    expect(findNode(tree, '/photos/2026')?.children).toHaveLength(2)
    expect(findNode(tree, '/photos/2026/2026-img-1')?.to).toBe('/photos/2026-img-1')
  })

  it('returns nothing for a path that is not there', () => {
    expect(findNode(tree, '/blog/nope.md')).toBeUndefined()
  })
})

describe('tokenize', () => {
  it('splits on whitespace and keeps quoted arguments whole', () => {
    expect(tokenize('ls /blog')).toEqual(['ls', '/blog'])
    expect(tokenize('echo "two words"')).toEqual(['echo', 'two words'])
    expect(tokenize("echo 'two words'")).toEqual(['echo', 'two words'])
    expect(tokenize('   ')).toEqual([])
  })
})

describe('completion', () => {
  it('completes a command in the first position', () => {
    expect(complete('neo', state()).input).toBe('neofetch ')
  })

  it('fills in as far as the candidates agree, and lists them', () => {
    const result = complete('cat /photos/2026/2026-img-', state())
    expect(result.input).toBe('cat /photos/2026/2026-img-')
    expect(result.candidates).toEqual(['2026-img-1', '2026-img-2'])
  })

  it('completes a path without losing the directory in front of it', () => {
    expect(complete('cat /blog/seas', state()).input).toBe('cat /blog/seasons.md ')
  })

  it('completes relative to the working directory', () => {
    expect(complete('cat seas', state('/blog')).input).toBe('cat seasons.md ')
  })

  it('leaves a directory on its slash so the next Tab goes into it', () => {
    expect(complete('cd ta', state('/blog')).input).toBe('cd tags/')
  })

  it('lists everything when there is nothing to match on yet', () => {
    expect(complete('cd ', state('/photos')).candidates).toEqual([
      'map',
      '2026/',
      '2019/',
    ])
  })

  it('leaves the input alone when nothing matches', () => {
    expect(complete('cat zzz', state()).input).toBe('cat zzz')
  })

  it('finds the shared prefix of a list', () => {
    expect(commonPrefix(['abcd', 'abce'])).toBe('abc')
    expect(commonPrefix(['abc'])).toBe('abc')
    expect(commonPrefix(['ab', 'cd'])).toBe('')
    expect(commonPrefix([])).toBe('')
  })
})

describe('commands', () => {
  // COMMANDS drives `help`, so a name listed there but not handled would print
  // "command not found" to someone who read it off the help output.
  it('implements every command it advertises', async () => {
    const { shell } = fakeShell()
    for (const spec of COMMANDS) {
      const result = await run(spec.name, state(), shell)
      const text = result.lines.map((line) => line.text).join('\n')
      expect(text, `\`${spec.name}\` is in COMMANDS but not handled by run()`).not.toContain(
        'command not found',
      )
    }
  })

  it('keeps the meta column out of the text, so it can be laid out', async () => {
    const { shell } = fakeShell()
    const rows = (await run('ls', state('/blog'), shell)).lines
    const post = rows.find((line) => line.text === 'seasons.md')
    expect(post?.meta).toBe('2026-08-01')
    expect(post?.href).toBe('/blog/2026/8/1/seasons')
  })

  it('cd moves, and refuses a file', async () => {
    const { shell } = fakeShell()
    expect((await run('cd blog', state(), shell)).cwd).toBe('/blog')
    expect((await run('cd /blog/tags/music', state(), shell)).cwd).toBe('/blog/tags/music')

    const onto = await run('cd seasons.md', state('/blog'), shell)
    expect(onto.cwd).toBeUndefined()
    expect(onto.lines[0].text).toContain('not a directory')

    const missing = await run('cd nowhere', state(), shell)
    expect(missing.lines[0].text).toContain('no such file or directory')
  })

  it('cd with no argument goes home', async () => {
    const { shell } = fakeShell()
    expect((await run('cd', state('/blog/tags'), shell)).cwd).toBe('/')
  })

  it('cat prints the published Markdown source', async () => {
    const { shell } = fakeShell()
    const result = await run('cat seasons.md', state('/blog'), shell)
    const text = result.lines.map((line) => line.text)
    expect(text).toContain('title: "Seasons"')
    expect(text).toContain('The body.')
    expect(result.lines.at(-1)?.href).toBe('/blog/2026/8/1/seasons.md')
  })

  it('cat sends you to `open` for a page with no source of its own', async () => {
    const { shell } = fakeShell()
    const result = await run('cat listening', state(), shell)
    expect(result.lines[0].text).toContain('nothing to read')
    expect(result.lines[1].text).toContain('open listening')
  })

  // /colophon and /projects are each one Markdown file, published next to their
  // HTML the way a post is — so `cat` reads them rather than pointing at `open`.
  it('cat prints a page written as a Markdown file', async () => {
    const { shell } = fakeShell()
    const result = await run('cat colophon', state(), shell)
    expect(result.lines.map((line) => line.text)).toContain('The body.')
    expect(result.lines.at(-1)?.href).toBe('/colophon.md')
  })

  it('cat reports a source it could not read rather than printing nothing', async () => {
    const { shell } = fakeShell({
      fetchText: async () => {
        throw new Error('offline')
      },
    })
    const result = await run('cat seasons.md', state('/blog'), shell)
    expect(result.lines[0].text).toContain('could not read it')
  })

  it('open navigates to the real page', async () => {
    const { shell, navigated } = fakeShell()
    await run('open seasons.md', state('/blog'), shell)
    await run('open', state('/photos'), shell)
    expect(navigated).toEqual(['/blog/2026/8/1/seasons', '/photos'])
  })

  it('photo shows a photograph', async () => {
    const { shell } = fakeShell()
    const result = await run('photo 2019-img-9', state(), shell)
    expect(result.lines[0].href).toBe('/photos/2019-img-9')
    expect(result.lines[1].image?.alt).toBe('A lake')

    const unknown = await run('photo nope', state(), shell)
    expect(unknown.lines[0].text).toContain('no such photograph')
  })

  it('find matches posts by title and tags, not only by file name', async () => {
    const { shell } = fakeShell()
    const hits = (await run('find paramore', state(), shell)).lines.map((line) => line.text)
    expect(hits.join('\n')).toContain('/blog/paramore.md')

    // A tag, not a word in any file name.
    const byTag = (await run('find travel', state(), shell)).lines.map((line) => line.href)
    expect(byTag).toContain('/blog/2019/2/2/cleveland')
  })

  it('find says so when there is no match', async () => {
    const { shell } = fakeShell()
    const result = await run('find zzzz', state(), shell)
    expect(result.lines[0].text).toContain('No match')
  })

  it('now covers music, reading, watching, and moving together', async () => {
    const { shell } = fakeShell()
    const text = (await run('now', state(), shell)).lines.map((line) => line.text).join('\n')
    expect(text).toContain('Hard Times')
    expect(text).toContain('The Bee Sting')
    expect(text).toContain('Office Space (1999)')
    expect(text).toContain('E-biked 10.1 miles')
  })

  it('now survives the moving Worker being down', async () => {
    const { shell } = fakeShell({
      fetchMoving: async () => {
        throw new Error('502')
      },
    })
    const text = (await run('now', state(), shell)).lines.map((line) => line.text).join('\n')
    // The other three still get their share of the screen.
    expect(text).toContain('Hard Times')
    expect(text).toContain('Office Space (1999)')
    expect(text).not.toContain('E-biked')
  })

  it('now survives the watching Worker being down', async () => {
    const { shell } = fakeShell({
      fetchWatching: async () => {
        throw new Error('502')
      },
    })
    const text = (await run('now', state(), shell)).lines.map((line) => line.text).join('\n')
    // The other two halves still land, and nothing announces the missing one:
    // a film is not something the page promised in the first place.
    expect(text).toContain('Hard Times')
    expect(text).toContain('The Bee Sting')
    expect(text).not.toContain('Office Space')
  })

  it("links today's article, falling back to its host", async () => {
    const { shell } = fakeShell()
    const lines = (await run('now', state(), shell)).lines
    const linked = lines.find((line) => line.href === 'https://example.com/a-piece')
    // The emoji sits outside the link, so it isn't underlined with the title.
    expect(linked?.text).toBe('A piece')
    expect(linked?.prefix).toBe('📄 ')
    expect(lines.some((line) => line.text.includes('example.com'))).toBe(true)
  })

  it('now keeps the half that answered when a Worker is down', async () => {
    const { shell } = fakeShell({
      fetchNow: async () => {
        throw new Error('502')
      },
    })
    const result = await run('now', state(), shell)
    expect(result.lines[0].tone).toBe('error')
    // The reading half still lands.
    expect(result.lines.map((line) => line.text).join('\n')).toContain('The Bee Sting')
  })

  it('watching shows the last film logged', async () => {
    const { shell } = fakeShell()
    const text = (await run('watching', state(), shell)).lines.map((line) => line.text).join('\n')
    expect(text).toContain('Office Space (1999)')
    // Half stars are rendered, not rounded — the point of the Letterboxd scale.
    expect(text).toContain('★★★½')
  })

  it('watching says so when the Worker is down', async () => {
    const { shell } = fakeShell({
      fetchWatching: async () => {
        throw new Error('502')
      },
    })
    const result = await run('watching', state(), shell)
    expect(result.lines[0].tone).toBe('error')
  })

  it('suggests a command for a near miss', async () => {
    const { shell } = fakeShell()
    const result = await run('lss', state(), shell)
    expect(result.lines[0].text).toContain('command not found')
    expect(result.lines[1].text).toContain('ls')
  })

  it('clear empties the screen', async () => {
    const { shell } = fakeShell()
    expect((await run('clear', state(), shell)).clear).toBe(true)
  })

  it('does nothing with an empty line', async () => {
    const { shell } = fakeShell()
    expect((await run('   ', state(), shell)).lines).toEqual([])
  })
})

describe('promptPath', () => {
  it('reads as a home directory', () => {
    expect(promptPath('/')).toBe('~')
    expect(promptPath('/blog/tags')).toBe('~/blog/tags')
  })
})
