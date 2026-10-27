import { describe, expect, it, vi } from 'vitest'
import {
  buildQuery,
  mapSearchResponse,
  parseIsoDuration,
  searchYouTube,
  SearchUnavailableError,
  youtubeSearchUrl,
} from './search'

const searchFixture = {
  items: [
    {
      id: { kind: 'youtube#video', videoId: 'abc123' },
      snippet: {
        title: 'Metallica - Nothing Else Matters &amp; Friends &#39;Live&#39; &quot;HD&quot;',
        channelTitle: 'Metallica',
        thumbnails: { default: { url: 'http://d.jpg' }, medium: { url: 'http://m.jpg' } },
      },
    },
    {
      id: { kind: 'youtube#video', videoId: 'nodur' },
      snippet: { title: 'Cover', channelTitle: 'Someone', thumbnails: { default: { url: 'http://d2.jpg' } } },
    },
    { id: { kind: 'youtube#channel' }, snippet: { title: 'skip me' } },
  ],
}
const videosFixture = { items: [{ id: 'abc123', contentDetails: { duration: 'PT6M29S' } }] }

describe('buildQuery', () => {
  it('виконавець + назва', () => {
    expect(buildQuery('Metallica', 'Nothing Else Matters', null)).toBe('Metallica Nothing Else Matters')
  })
  it('лише назва', () => {
    expect(buildQuery('', ' Enter Sandman ', 'x.gp5')).toBe('Enter Sandman')
  })
  it("лише ім'я файлу", () => {
    expect(buildQuery('', '', 'Metallica_-_Nothing_Else_Matters (ver 3).gp5')).toBe('Metallica - Nothing Else Matters')
  })
  it('прибирає розширення, дужки та слово tab', () => {
    expect(buildQuery('', '', 'Song_Name [Guitar Pro] tabs.gpx')).toBe('Song Name')
    expect(buildQuery('', '', 'Song.gp')).toBe('Song')
  })
  it('нічого немає — порожній рядок', () => {
    expect(buildQuery('', '', null)).toBe('')
  })
})

describe('youtubeSearchUrl', () => {
  it('кодує запит', () => {
    expect(youtubeSearchUrl('a b&c')).toBe('https://www.youtube.com/results?search_query=a%20b%26c')
  })
})

describe('parseIsoDuration', () => {
  it('парсить', () => {
    expect(parseIsoDuration('PT4M13S')).toBe(253)
    expect(parseIsoDuration('PT1H2M')).toBe(3720)
    expect(parseIsoDuration('PT45S')).toBe(45)
  })
  it('сміття — null', () => {
    expect(parseIsoDuration('garbage')).toBeNull()
    expect(parseIsoDuration('')).toBeNull()
    expect(parseIsoDuration('PT')).toBeNull()
  })
})

describe('mapSearchResponse', () => {
  it('мапить, декодує сутності, дефолти', () => {
    const r = mapSearchResponse(searchFixture, videosFixture)
    expect(r).toHaveLength(2)
    expect(r[0]).toEqual({
      videoId: 'abc123',
      title: `Metallica - Nothing Else Matters & Friends 'Live' "HD"`,
      channel: 'Metallica',
      thumbnail: 'http://m.jpg',
      durationSec: 389,
    })
    expect(r[1].thumbnail).toBe('http://d2.jpg')
    expect(r[1].durationSec).toBeNull()
  })
  it('толерантний до сміття', () => {
    expect(mapSearchResponse(null, undefined)).toEqual([])
  })
})

const res = (status: number, body: unknown) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })

describe('searchYouTube', () => {
  it('200 з ендпойнта', async () => {
    const data = [{ videoId: 'x', title: 't', channel: 'c', thumbnail: '', durationSec: 1 }]
    const fetchImpl = vi.fn(async (_url: string | URL | Request) => res(200, data))
    expect(await searchYouTube('a b', { fetchImpl: fetchImpl as typeof fetch })).toEqual(data)
    expect(fetchImpl.mock.calls[0][0]).toBe('/api/yt-search?q=a%20b')
  })

  it('404 + ключ → прямі виклики googleapis', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url)
      if (u.startsWith('/api/')) return res(404, { error: 'search-disabled' })
      if (u.includes('/search?')) return res(200, searchFixture)
      return res(200, videosFixture)
    })
    const r = await searchYouTube('metallica one', { fetchImpl: fetchImpl as typeof fetch, apiKey: 'KEY1' })
    expect(r[0].durationSec).toBe(389)
    const urls = fetchImpl.mock.calls.map((c) => String(c[0]))
    expect(urls).toHaveLength(3)
    expect(urls[1]).toContain('googleapis.com/youtube/v3/search')
    expect(urls[1]).toContain('key=KEY1')
    expect(urls[1]).toContain('q=metallica+one')
    expect(urls[2]).toContain('/videos?')
    expect(urls[2]).toContain('key=KEY1')
    expect(urls[2]).toContain('id=abc123%2Cnodur')
  })

  it('404 без ключа → SearchUnavailableError', async () => {
    const fetchImpl = vi.fn(async () => res(404, { error: 'search-disabled' }))
    await expect(searchYouTube('q', { fetchImpl })).rejects.toBeInstanceOf(SearchUnavailableError)
  })

  it('мережева помилка + ключ → fallback', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url)
      if (u.startsWith('/api/')) throw new TypeError('network')
      if (u.includes('/search?')) return res(200, searchFixture)
      return res(200, videosFixture)
    })
    const r = await searchYouTube('q', { fetchImpl: fetchImpl as typeof fetch, apiKey: 'K' })
    expect(r.map((x) => x.videoId)).toEqual(['abc123', 'nodur'])
  })

  it('5xx без ключа → загальна помилка', async () => {
    const fetchImpl = vi.fn(async () => res(502, { error: 'upstream' }))
    const p = searchYouTube('q', { fetchImpl })
    await expect(p).rejects.toThrow(Error)
    await expect(p).rejects.not.toBeInstanceOf(SearchUnavailableError)
  })
})
