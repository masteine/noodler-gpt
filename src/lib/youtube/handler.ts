// Міст між плеєром YouTube і alphaTab у режимі PlayerMode.EnabledExternalMedia.
// alphaTab керує медіа через IExternalMediaHandler (play/pause/seek/rate/volume),
// а ми у відповідь регулярно повідомляємо йому поточний час відео через updatePosition.

import type * as alphaTab from '@coderline/alphatab'

/** Частина YT.Player, яка потрібна мосту. Окремий інтерфейс, щоб тестувати без iframe. */
export interface YtPlayerLike {
  getDuration(): number
  getCurrentTime(): number
  getPlayerState(): number
  playVideo(): void
  pauseVideo(): void
  seekTo(seconds: number, allowSeekAhead: boolean): void
  getPlaybackRate(): number
  setPlaybackRate(rate: number): void
  getAvailablePlaybackRates(): number[]
  getVolume(): number
  setVolume(volume: number): void
}

/** Те, що міст робить з alphaTab. Абстраговано, щоб handler не тягнув увесь AlphaTabApi. */
export interface SyncTarget {
  /** Передає alphaTab поточний час відео (мс). */
  updatePosition(ms: number): void
  play(): void
  pause(): void
  stop(): void
  readonly isPlaying: boolean
  /** Користувач змінив швидкість у самому плеєрі YouTube. */
  setPlaybackSpeed(rate: number): void
}

export const YtState = {
  UNSTARTED: -1,
  ENDED: 0,
  PLAYING: 1,
  PAUSED: 2,
  BUFFERING: 3,
  CUED: 5,
} as const

/** Швидкості, які підтримує вбудований плеєр YouTube (getAvailablePlaybackRates може повернути менше). */
export const YT_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]

export function nearestRate(rate: number, available: readonly number[] = YT_RATES): number {
  const rates = available.length ? available : YT_RATES
  let best = rates[0]
  for (const r of rates) if (Math.abs(r - rate) < Math.abs(best - rate)) best = r
  return best
}

export class YouTubeMediaHandler implements alphaTab.synth.IExternalMediaHandler {
  private _rate = 1
  private _volume = 1
  /**
   * YouTube запускає відтворення при seekTo, якщо плеєр ще не стартував (CUED/UNSTARTED) або вже закінчив (ENDED).
   * Тому в цих станах перемотку відкладаємо й застосовуємо в play().
   */
  private _pendingSeekMs: number | null = null
  private _timer: ReturnType<typeof setInterval> | null = null
  /**
   * Поки true, події плеєра YouTube не доходять до alphaTab: автосинхронізація сама керує відео
   * (грає з початку й слухає), і alphaTab не має на це реагувати.
   */
  suspended = false

  constructor(
    readonly player: YtPlayerLike,
    private readonly target: SyncTarget,
    private readonly intervalMs = 50,
  ) {
    this._rate = player.getPlaybackRate() || 1
  }

  // --- IExternalMediaHandler ---

  get backingTrackDuration(): number {
    const d = this.player.getDuration()
    return Number.isFinite(d) && d > 0 ? d * 1000 : 0
  }

  get playbackRate(): number {
    return this._rate
  }

  set playbackRate(value: number) {
    const rate = nearestRate(value, this.player.getAvailablePlaybackRates())
    this._rate = rate
    if (this.player.getPlaybackRate() !== rate) this.player.setPlaybackRate(rate)
  }

  get masterVolume(): number {
    return this._volume
  }

  set masterVolume(value: number) {
    this._volume = Math.max(0, Math.min(1, value))
    this.player.setVolume(Math.round(this._volume * 100))
  }

  seekTo(time: number): void {
    const ms = Math.max(0, time)
    const state = this.player.getPlayerState()
    if (state === YtState.UNSTARTED || state === YtState.CUED || state === YtState.ENDED) {
      this._pendingSeekMs = ms
      return
    }
    this._pendingSeekMs = null
    this.player.seekTo(ms / 1000, true)
  }

  play(): void {
    if (this._pendingSeekMs !== null) {
      const ms = this._pendingSeekMs
      this._pendingSeekMs = null
      this.player.seekTo(ms / 1000, true)
    }
    this.player.playVideo()
  }

  pause(): void {
    this.player.pauseVideo()
  }

  // --- наш бік ---

  /** Поточний час відео в мс (для tap-sync). */
  get currentTimeMs(): number {
    return this.player.getCurrentTime() * 1000
  }

  /** Обробник події onStateChange від плеєра YouTube. */
  onStateChange(state: number): void {
    if (this.suspended) return
    switch (state) {
      case YtState.PLAYING:
        this._pendingSeekMs = null
        this.startTicking()
        // Користувач натиснув play всередині iframe: підтягуємо alphaTab.
        if (!this.target.isPlaying) this.target.play()
        break
      case YtState.PAUSED:
        this.stopTicking()
        this.tick()
        if (this.target.isPlaying) this.target.pause()
        break
      case YtState.ENDED:
        this.stopTicking()
        this.target.stop()
        break
    }
  }

  /** Обробник onPlaybackRateChange: швидкість змінили в самому плеєрі. */
  onPlaybackRateChange(rate: number): void {
    if (rate === this._rate) return
    this._rate = rate
    this.target.setPlaybackSpeed(rate)
  }

  destroy(): void {
    this.stopTicking()
  }

  private startTicking() {
    if (this._timer !== null) return
    this._timer = setInterval(() => this.tick(), this.intervalMs)
  }

  private stopTicking() {
    if (this._timer === null) return
    clearInterval(this._timer)
    this._timer = null
  }

  private tick() {
    this.target.updatePosition(this.player.getCurrentTime() * 1000)
  }
}

/** Джерело звуку плеєра: синтезатор alphaTab або оригінальний запис з YouTube. */
export type Source = 'synth' | 'youtube'
