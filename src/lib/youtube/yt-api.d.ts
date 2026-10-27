// Мінімальні типи YouTube IFrame Player API — лише те, що використовує застосунок.
// Повний опис: https://developers.google.com/youtube/iframe_api_reference

declare namespace YT {
  enum PlayerState {
    UNSTARTED = -1,
    ENDED = 0,
    PLAYING = 1,
    PAUSED = 2,
    BUFFERING = 3,
    CUED = 5,
  }

  interface PlayerVars {
    autoplay?: 0 | 1
    controls?: 0 | 1
    playsinline?: 0 | 1
    rel?: 0 | 1
    modestbranding?: 0 | 1
    enablejsapi?: 0 | 1
    origin?: string
    start?: number
  }

  interface OnStateChangeEvent {
    data: PlayerState
    target: Player
  }

  interface OnPlaybackRateChangeEvent {
    data: number
    target: Player
  }

  interface OnErrorEvent {
    data: number
    target: Player
  }

  interface PlayerOptions {
    videoId?: string
    width?: string | number
    height?: string | number
    host?: string
    playerVars?: PlayerVars
    events?: {
      onReady?: (e: { target: Player }) => void
      onStateChange?: (e: OnStateChangeEvent) => void
      onPlaybackRateChange?: (e: OnPlaybackRateChangeEvent) => void
      onError?: (e: OnErrorEvent) => void
    }
  }

  class Player {
    constructor(element: HTMLElement | string, options: PlayerOptions)
    playVideo(): void
    pauseVideo(): void
    stopVideo(): void
    seekTo(seconds: number, allowSeekAhead: boolean): void
    cueVideoById(videoId: string, startSeconds?: number): void
    loadVideoById(videoId: string, startSeconds?: number): void
    getPlayerState(): PlayerState
    getCurrentTime(): number
    getDuration(): number
    getVolume(): number
    setVolume(volume: number): void
    mute(): void
    unMute(): void
    isMuted(): boolean
    getPlaybackRate(): number
    setPlaybackRate(rate: number): void
    getAvailablePlaybackRates(): number[]
    getVideoData(): { video_id: string; title: string; author: string }
    getIframe(): HTMLIFrameElement
    addEventListener(event: string, listener: (e: { data: number; target: Player }) => void): void
    removeEventListener(event: string, listener: (e: { data: number; target: Player }) => void): void
    destroy(): void
  }
}

interface Window {
  YT?: typeof YT
  onYouTubeIframeAPIReady?: () => void
}
