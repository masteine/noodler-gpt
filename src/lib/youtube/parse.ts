// Витягує id відео з того, що користувач вставив: повний URL, коротке посилання або голий id.

const ID = /^[A-Za-z0-9_-]{11}$/
const PATH_ID = /^\/(?:embed|shorts|live|v)\/([A-Za-z0-9_-]{11})(?:[/?#]|$)/

export function parseVideoId(input: string): string | null {
  const s = input.trim()
  if (!s) return null
  if (ID.test(s)) return s

  let url: URL
  try {
    url = new URL(s.includes('://') ? s : `https://${s}`)
  } catch {
    return null
  }

  const host = url.hostname.toLowerCase().replace(/^(www|m|music)\./, '')
  if (host === 'youtu.be') {
    const id = url.pathname.split('/')[1] ?? ''
    return ID.test(id) ? id : null
  }
  if (host !== 'youtube.com' && host !== 'youtube-nocookie.com') return null

  const v = url.searchParams.get('v')
  if (v && ID.test(v)) return v
  const m = url.pathname.match(PATH_ID)
  return m ? m[1] : null
}

export function watchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`
}
