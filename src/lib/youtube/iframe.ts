// Завантаження YouTube IFrame Player API. Скрипт підключаємо лише раз і лише тоді,
// коли користувач справді хоче відео, щоб не тягнути Google-скрипти на кожне відкриття файлу.

import { t } from '../i18n/index.svelte'

const API_SRC = 'https://www.youtube.com/iframe_api'
/** Домен без рекламних cookie: YouTube не ставить трекінгові cookie, поки відео не запущено. */
const PLAYER_HOST = 'https://www.youtube-nocookie.com'

let apiPromise: Promise<typeof YT> | null = null

export function loadIframeApi(): Promise<typeof YT> {
  if (apiPromise) return apiPromise
  apiPromise = new Promise<typeof YT>((resolve, reject) => {
    const existing = window.YT
    if (existing?.Player) {
      resolve(existing)
      return
    }
    const previous = window.onYouTubeIframeAPIReady
    window.onYouTubeIframeAPIReady = () => {
      previous?.()
      if (window.YT) resolve(window.YT)
      else reject(new Error(t('yt.apiInit')))
    }
    const script = document.createElement('script')
    script.src = API_SRC
    script.async = true
    script.onerror = () => {
      apiPromise = null
      script.remove()
      reject(new Error(t('yt.apiLoad')))
    }
    document.head.appendChild(script)
  })
  return apiPromise
}

export interface PlayerEvents {
  onStateChange?: (state: YT.PlayerState) => void
  onPlaybackRateChange?: (rate: number) => void
  onError?: (code: number) => void
}

/** Створює плеєр у вказаному елементі та чекає на готовність. */
export async function createPlayer(host: HTMLElement, videoId: string, events: PlayerEvents = {}): Promise<YT.Player> {
  const api = await loadIframeApi()
  return new Promise<YT.Player>((resolve, reject) => {
    let ready = false
    const player = new api.Player(host, {
      videoId,
      width: '100%',
      height: '100%',
      host: PLAYER_HOST,
      playerVars: {
        playsinline: 1,
        rel: 0,
        controls: 1,
        enablejsapi: 1,
        origin: window.location.origin,
      },
      events: {
        onReady: () => {
          ready = true
          resolve(player)
        },
        onStateChange: (e) => events.onStateChange?.(e.data),
        onPlaybackRateChange: (e) => events.onPlaybackRateChange?.(e.data),
        onError: (e) => {
          events.onError?.(e.data)
          if (!ready) reject(new Error(describeError(e.data)))
        },
      },
    })
  })
}

/** Коди помилок з документації IFrame API. */
export function describeError(code: number): string {
  switch (code) {
    case 2:
      return t('yt.badId')
    case 5:
      return t('yt.html5')
    case 100:
      return t('yt.notFound')
    case 101:
    case 150:
      return t('yt.noEmbed')
    default:
      return t('yt.error', { code })
  }
}
