// Vercel-функція: проксі до YouTube Data API v3 (ключ лишається на сервері).
import { mapSearchResponse } from '../src/lib/youtube/search.js'

const API = 'https://www.googleapis.com/youtube/v3'

function json(body: unknown, status = 200, cache = false): Response {
  const headers: Record<string, string> = { 'Content-Type': 'application/json; charset=utf-8' }
  if (cache) headers['Cache-Control'] = 'public, s-maxage=86400, stale-while-revalidate=604800'
  return new Response(JSON.stringify(body), { status, headers })
}

export async function GET(request: Request): Promise<Response> {
  const q = (new URL(request.url).searchParams.get('q') ?? '').trim().slice(0, 200).trim()
  if (!q) return json({ error: 'empty-query' }, 400)

  const key = process.env.YT_API_KEY
  if (!key) return json({ error: 'search-disabled' }, 404)

  try {
    const sp = new URLSearchParams({
      part: 'snippet',
      type: 'video',
      videoEmbeddable: 'true',
      maxResults: '5',
      q,
      key,
    })
    const sRes = await fetch(`${API}/search?${sp}`)
    if (!sRes.ok) return json({ error: 'upstream' }, 502)
    const searchJson: unknown = await sRes.json()

    const ids = mapSearchResponse(searchJson, null).map((r) => r.videoId)
    let videosJson: unknown = null
    if (ids.length > 0) {
      const vp = new URLSearchParams({ part: 'contentDetails', id: ids.join(','), key })
      const vRes = await fetch(`${API}/videos?${vp}`)
      if (!vRes.ok) return json({ error: 'upstream' }, 502)
      videosJson = await vRes.json()
    }
    return json(mapSearchResponse(searchJson, videosJson), 200, true)
  } catch {
    return json({ error: 'upstream' }, 502)
  }
}
