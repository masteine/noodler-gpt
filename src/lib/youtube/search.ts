// Пошук оригінального запису табу на YouTube.
// Модуль спільний для браузера (src) і серверної функції (api/yt-search.ts),
// тому не використовує ні DOM-, ні Node-специфічних API (лише fetch/URL).

export interface YtResult {
  videoId: string
  title: string
  channel: string
  thumbnail: string
  durationSec: number | null
}

/** Немає ні серверного ендпойнта, ні ключа користувача. */
export class SearchUnavailableError extends Error {}

/** Пошук не вдався. status — HTTP-код прямого запиту до Google; null — збій серверного ендпойнта.
 *  Текст для користувача складає UI мовою інтерфейсу. */
export class SearchFailedError extends Error {
  status: number | null
  constructor(status: number | null) {
    super(status === null ? 'search service unavailable' : `YouTube search failed (HTTP ${status})`)
    this.status = status
  }
}

const SEARCH_URL = 'https://www.googleapis.com/youtube/v3/search'
const VIDEOS_URL = 'https://www.googleapis.com/youtube/v3/videos'

/** Пошуковий запит із метаданих табу: «виконавець назва»; якщо порожньо — з імені файлу. */
export function buildQuery(artist: string, title: string, fileName: string | null): string {
  const fromMeta = `${artist ?? ''} ${title ?? ''}`.replace(/\s+/g, ' ').trim()
  if (fromMeta) return fromMeta
  if (!fileName) return ''
  return fileName
    .replace(/\.[A-Za-z0-9]{1,5}$/, '') // розширення (.gp5, .gpx, ...)
    .replace(/_/g, ' ')
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ') // «(ver 2)», «[Guitar Pro]»
    .replace(/\btabs?\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function youtubeSearchUrl(query: string): string {
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`
}

/** ISO-8601 тривалість (PT1H2M3S) у секунди; не розпізнано — null. */
export function parseIsoDuration(iso: string): number | null {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso ?? '')
  if (!m || iso === 'P' || iso.endsWith('T')) return null
  const [d, h, min, s] = [m[1], m[2], m[3], m[4]].map((x) => (x ? Number(x) : 0))
  return d * 86400 + h * 3600 + min * 60 + s
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      try {
        return String.fromCodePoint(code)
      } catch {
        return whole
      }
    }
    return ENTITIES[body.toLowerCase()] ?? whole
  })
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** Склеює відповіді search.list та videos.list у плоский список. */
export function mapSearchResponse(search: unknown, videos: unknown): YtResult[] {
  const durations = new Map<string, number | null>()
  const vItems = isObj(videos) && Array.isArray(videos.items) ? videos.items : []
  for (const v of vItems) {
    if (!isObj(v)) continue
    const id = str(v.id)
    const cd = isObj(v.contentDetails) ? str(v.contentDetails.duration) : ''
    if (id) durations.set(id, cd ? parseIsoDuration(cd) : null)
  }

  const sItems = isObj(search) && Array.isArray(search.items) ? search.items : []
  const out: YtResult[] = []
  for (const it of sItems) {
    if (!isObj(it)) continue
    const videoId = isObj(it.id) ? str(it.id.videoId) : ''
    if (!videoId) continue
    const sn = isObj(it.snippet) ? it.snippet : {}
    const th = isObj(sn.thumbnails) ? sn.thumbnails : {}
    const medium = isObj(th.medium) ? str(th.medium.url) : ''
    const def = isObj(th.default) ? str(th.default.url) : ''
    out.push({
      videoId,
      title: decodeEntities(str(sn.title)),
      channel: decodeEntities(str(sn.channelTitle)),
      thumbnail: medium || def,
      durationSec: durations.get(videoId) ?? null,
    })
  }
  return out
}

export interface SearchOptions {
  apiKey?: string | null
  endpoint?: string
  fetchImpl?: typeof fetch
  signal?: AbortSignal
}

function isAbort(e: unknown): boolean {
  return isObj(e) && e.name === 'AbortError'
}

async function searchDirect(query: string, apiKey: string, f: typeof fetch, signal?: AbortSignal): Promise<YtResult[]> {
  const sp = new URLSearchParams({
    part: 'snippet',
    type: 'video',
    videoEmbeddable: 'true',
    maxResults: '5',
    q: query,
    key: apiKey,
  })
  const sRes = await f(`${SEARCH_URL}?${sp}`, { signal })
  if (!sRes.ok) throw new SearchFailedError(sRes.status)
  const sJson: unknown = await sRes.json()

  const ids = (mapSearchResponse(sJson, null)).map((r) => r.videoId)
  if (ids.length === 0) return []

  const vp = new URLSearchParams({ part: 'contentDetails', id: ids.join(','), key: apiKey })
  let vJson: unknown = null
  try {
    const vRes = await f(`${VIDEOS_URL}?${vp}`, { signal })
    if (vRes.ok) vJson = await vRes.json()
  } catch (e) {
    if (isAbort(e)) throw e // тривалість — необов'язкова, інші збої ігноруємо
  }
  return mapSearchResponse(sJson, vJson)
}

/** Шукає відео: спершу серверний ендпойнт, далі — прямий виклик з ключем користувача. */
export async function searchYouTube(query: string, opts: SearchOptions = {}): Promise<YtResult[]> {
  const { apiKey, endpoint = '/api/yt-search', signal } = opts
  const f = opts.fetchImpl ?? fetch
  let status = 0

  try {
    const res = await f(`${endpoint}?q=${encodeURIComponent(query)}`, { signal })
    status = res.status
    if (res.ok) {
      const data: unknown = await res.json()
      if (Array.isArray(data)) return data as YtResult[]
    }
  } catch (e) {
    if (isAbort(e)) throw e
    // мережева помилка або не-JSON — пробуємо запасний шлях
  }

  if (apiKey) return searchDirect(query, apiKey, f, signal)
  if (status === 0 || status === 404 || status === 200) throw new SearchUnavailableError('no search endpoint and no API key')
  throw new SearchFailedError(null)
}
