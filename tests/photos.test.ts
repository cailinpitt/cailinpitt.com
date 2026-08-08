import { describe, expect, it } from 'vitest'
import {
  assignPhotoId,
  approxDateForYear,
  byNewest,
  GRID_WIDTHS,
  photoFiles,
  renditionPath,
  resolveDate,
  slugify,
} from '../scripts/photo-manifest.mjs'
import {
  byNewest as byNewestUi,
  formatPhotoDate,
  formatPhotoDateShort,
  GRID_WIDTHS as GRID_WIDTHS_UI,
  photoNeighbors,
  photoYearBreaks,
  renditionPath as renditionPathUi,
  thumbSrcset,
  type Photo,
} from '../src/lib/photos'

// The feed's two invariants: a photo's id is a URL that must never move, and its
// place in the feed is decided by year first and date second. Everything here is
// about one of those two.

const photo = (over: Partial<Photo> & Pick<Photo, 'id' | 'year' | 'date'>): Photo => ({
  src: `/images/${over.year}/${over.id}.webp`,
  alt: `Photograph — ${over.year}`,
  ...over,
})

describe('slugify', () => {
  it('lowercases and dashes anything that is not alphanumeric', () => {
    expect(slugify('IMG_0116')).toBe('img-0116')
    expect(slugify('dji_fly_20260718_193222_326_photo')).toBe('dji-fly-20260718-193222-326-photo')
    expect(slugify('_2A_0611-copy')).toBe('2a-0611-copy')
  })

  it('does not leave leading or trailing dashes', () => {
    expect(slugify('yuck-')).toBe('yuck')
    expect(slugify('--i m trying--')).toBe('i-m-trying')
  })
})

describe('assignPhotoId', () => {
  it('is the year and the filename', () => {
    expect(assignPhotoId('2019', 'IMG_0116', new Set())).toBe('2019-img-0116')
  })

  it('keeps the same filename in two years apart', () => {
    const used = new Set<string>()
    expect(assignPhotoId('2017', 'IMG_8165', used)).toBe('2017-img-8165')
    expect(assignPhotoId('2022', 'IMG_8165', used)).toBe('2022-img-8165')
  })

  it('suffixes a collision within one year rather than reusing an id', () => {
    const used = new Set<string>()
    expect(assignPhotoId('2019', 'IMG 1', used)).toBe('2019-img-1')
    expect(assignPhotoId('2019', 'IMG-1', used)).toBe('2019-img-1-2')
    expect(assignPhotoId('2019', 'img_1', used)).toBe('2019-img-1-3')
  })
})

describe('resolveDate', () => {
  it('prefers the capture time, and takes the year from it', () => {
    const exif = { shot: '2025-12-30T18:04:00' }
    expect(resolveDate({ exif, existing: undefined, year: '2026' })).toEqual({
      date: '2025-12-30T18:04:00',
      year: '2025',
    })
  })

  it('keeps a date already in the manifest, filed under its folder year', () => {
    const existing = { date: '2016-11-13T20:48:06' }
    expect(resolveDate({ exif: undefined, existing, year: '2014' })).toEqual({
      date: '2016-11-13T20:48:06',
      year: '2014',
      approx: true,
    })
  })

  it('falls back to the first of the year', () => {
    expect(resolveDate({ exif: undefined, existing: undefined, year: '2019' })).toEqual({
      date: approxDateForYear('2019'),
      year: '2019',
      approx: true,
    })
  })

  it('upgrades an approximate photo once its original turns up with EXIF', () => {
    const existing = { date: '2016-11-13T20:48:06', approx: true }
    const exif = { shot: '2014-06-21T09:12:00' }
    expect(resolveDate({ exif, existing, year: '2014' })).toEqual({
      date: '2014-06-21T09:12:00',
      year: '2014',
    })
  })
})

describe('feed order', () => {
  // A recovered upload date can land outside the year the photo is filed under,
  // which is exactly why year leads: a 2014 photo uploaded in 2016 belongs in the
  // 2014 block, at the position that upload time gives it.
  const feed = [
    photo({ id: '2014-a', year: '2014', date: '2016-11-13T20:48:06', approx: true }),
    photo({ id: '2016-b', year: '2016', date: '2016-02-02T00:00:00', approx: true }),
    photo({ id: '2014-b', year: '2014', date: '2015-01-01T00:00:00', approx: true }),
    photo({ id: '2026-a', year: '2026', date: '2026-07-18T19:32:23' }),
  ]

  it('sorts by year, then date within it', () => {
    expect([...feed].sort(byNewestUi).map((p) => p.id)).toEqual([
      '2026-a',
      '2016-b',
      '2014-a',
      '2014-b',
    ])
  })

  it('sorts the same way in the sync script as on the site', () => {
    const ui = [...feed].sort(byNewestUi).map((p) => p.id)
    const script = [...feed].sort(byNewest).map((p) => p.id)
    expect(script).toEqual(ui)
  })

  it('breaks ties on the id, so the order never depends on input order', () => {
    const tied = [
      photo({ id: '2019-b', year: '2019', date: '2019-01-01T00:00:00', approx: true }),
      photo({ id: '2019-a', year: '2019', date: '2019-01-01T00:00:00', approx: true }),
    ]
    expect([...tied].sort(byNewestUi).map((p) => p.id)).toEqual(['2019-b', '2019-a'])
    expect([...tied].reverse().sort(byNewestUi).map((p) => p.id)).toEqual(['2019-b', '2019-a'])
  })

  it('anchors the first photo of each year', () => {
    const sorted = [...feed].sort(byNewestUi)
    expect([...photoYearBreaks(sorted)]).toEqual(['2026-a', '2016-b', '2014-a'])
  })

  it('walks newer and older from any photo', () => {
    const sorted = [...feed].sort(byNewestUi)
    const middle = photoNeighbors(sorted, '2016-b')
    expect(middle.newer?.id).toBe('2026-a')
    expect(middle.older?.id).toBe('2014-a')
    // The ends have nowhere further to go, which is what hides a nav link.
    expect(photoNeighbors(sorted, '2026-a').newer).toBeUndefined()
    expect(photoNeighbors(sorted, '2014-b').older).toBeUndefined()
  })

  it('reports a miss rather than a neighbor for an unknown id', () => {
    expect(photoNeighbors(feed, 'nope').photo).toBeUndefined()
  })
})

describe('how a date is phrased', () => {
  it('gives an exact photo its day', () => {
    const p = photo({ id: '2026-a', year: '2026', date: '2026-07-18T19:32:23' })
    expect(formatPhotoDate(p)).toBe('July 18, 2026')
    expect(formatPhotoDateShort(p)).toBe('Jul 18')
  })

  it('gives an approximate photo only its year — never the placeholder day', () => {
    const p = photo({ id: '2019-a', year: '2019', date: '2019-01-01T00:00:00', approx: true })
    expect(formatPhotoDate(p)).toBe('2019')
    expect(formatPhotoDateShort(p)).toBe('2019')
  })

  it('labels an approximate photo with its folder year, not its date year', () => {
    const p = photo({ id: '2014-a', year: '2014', date: '2016-11-13T20:48:06', approx: true })
    expect(formatPhotoDate(p)).toBe('2014')
  })
})

describe('what belongs to a photo', () => {
  // npm run photos:rm deletes from this. Missing a rendition leaves an orphan in
  // R2; missing the original means the next images:sync republishes the photo.
  it('finds both renditions and the original stem', () => {
    expect(
      photoFiles({
        id: '2026-img-1919',
        src: '/images/2026/IMG_1919.webp',
        thumb: '/images/2026/IMG_1919-1000.webp',
      }),
    ).toEqual({
      folder: '2026',
      stem: 'IMG_1919',
      renditions: ['/images/2026/IMG_1919.webp', '/images/2026/IMG_1919-1000.webp'],
      originalStem: 'IMG_1919',
    })
  })

  it('takes the folder from the path, not from the year the photo is labeled', () => {
    // A capture date can file a photo under a different year than its folder.
    const files = photoFiles({
      id: '2026-img-0001',
      src: '/images/2026/IMG_0001.webp',
      thumb: '/images/2026/IMG_0001-1000.webp',
      year: '2025',
    })
    expect(files.folder).toBe('2026')
  })

  it('copes with a photo that has no thumbnail', () => {
    const files = photoFiles({ id: '2014-x', src: '/images/2014/x.webp' })
    expect(files.renditions).toEqual(['/images/2014/x.webp'])
  })

  it('deletes every grid rendition the entry claims, without repeating the thumb', () => {
    const files = photoFiles({
      id: '2026-img-1919',
      src: '/images/2026/IMG_1919.webp',
      thumb: '/images/2026/IMG_1919-1000.webp',
      widths: [400, 800, 1000],
    })
    expect(files.renditions).toEqual([
      '/images/2026/IMG_1919.webp',
      '/images/2026/IMG_1919-1000.webp',
      '/images/2026/IMG_1919-400.webp',
      '/images/2026/IMG_1919-800.webp',
    ])
  })

  it('deletes only the widths a photo actually has', () => {
    // An entry synced before a width was added never had that file; asking R2
    // to delete it would report a phantom as missing.
    const files = photoFiles({
      id: '2019-x',
      src: '/images/2019/x.webp',
      thumb: '/images/2019/x-1000.webp',
      widths: [1000],
    })
    expect(files.renditions).toEqual(['/images/2019/x.webp', '/images/2019/x-1000.webp'])
  })
})

describe('grid renditions', () => {
  // The encoder and the browser have to agree on which files exist: a width the
  // srcset offers but images:sync never wrote is a 404 the browser picks itself.
  it('offers exactly the widths the sync script encodes', () => {
    expect(GRID_WIDTHS_UI).toEqual(GRID_WIDTHS)
  })

  it('derives the same rendition path on both sides', () => {
    for (const width of GRID_WIDTHS) {
      expect(renditionPathUi('/images/2026/x.webp', width)).toBe(
        renditionPath('/images/2026/x.webp', width),
      )
    }
  })

  it("names the thumb's own width, so `thumb` and the srcset agree", () => {
    expect(renditionPathUi('/images/2026/x.webp', 1000)).toBe('/images/2026/x-1000.webp')
  })

  it('builds a narrow-first srcset of absolute R2 urls', () => {
    expect(thumbSrcset({ src: '/images/2026/x.webp', widths: [400, 800, 1000] })).toBe(
      'https://images.cailinpitt.com/images/2026/x-400.webp 400w, ' +
        'https://images.cailinpitt.com/images/2026/x-800.webp 800w, ' +
        'https://images.cailinpitt.com/images/2026/x-1000.webp 1000w',
    )
  })

  it('offers no srcset when there is only one rendition to choose from', () => {
    expect(thumbSrcset({ src: '/images/2019/x.webp', widths: [1000] })).toBeUndefined()
    expect(thumbSrcset({ src: '/images/2019/x.webp' })).toBeUndefined()
  })
})
