import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { YouTubeMediaHandler, YtState, nearestRate, type SyncTarget, type YtPlayerLike } from './handler'

class FakePlayer implements YtPlayerLike {
  state: number = YtState.CUED
  time = 0
  duration = 200
  rate = 1
  volume = 100
  calls: string[] = []
  getDuration() {
    return this.duration
  }
  getCurrentTime() {
    return this.time
  }
  getPlayerState() {
    return this.state
  }
  playVideo() {
    this.calls.push('play')
    this.state = YtState.PLAYING
  }
  pauseVideo() {
    this.calls.push('pause')
    this.state = YtState.PAUSED
  }
  seekTo(seconds: number) {
    this.calls.push(`seek:${seconds}`)
    this.time = seconds
    // як у YouTube: seek з CUED/ENDED запускає відтворення
    if (this.state === YtState.CUED || this.state === YtState.ENDED || this.state === YtState.UNSTARTED) {
      this.state = YtState.PLAYING
    }
  }
  getPlaybackRate() {
    return this.rate
  }
  setPlaybackRate(rate: number) {
    this.calls.push(`rate:${rate}`)
    this.rate = rate
  }
  getAvailablePlaybackRates() {
    return [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2]
  }
  getVolume() {
    return this.volume
  }
  setVolume(v: number) {
    this.calls.push(`vol:${v}`)
    this.volume = v
  }
}

function makeTarget() {
  const t = {
    positions: [] as number[],
    playing: false,
    speed: 1,
    calls: [] as string[],
    updatePosition(ms: number) {
      t.positions.push(ms)
    },
    play() {
      t.calls.push('play')
      t.playing = true
    },
    pause() {
      t.calls.push('pause')
      t.playing = false
    },
    stop() {
      t.calls.push('stop')
      t.playing = false
    },
    get isPlaying() {
      return t.playing
    },
    setPlaybackSpeed(rate: number) {
      t.speed = rate
    },
  }
  return t satisfies SyncTarget
}

describe('nearestRate', () => {
  it('прив’язує до доступних швидкостей YouTube', () => {
    expect(nearestRate(0.7)).toBe(0.75)
    expect(nearestRate(1.1)).toBe(1)
    expect(nearestRate(0.3, [0.5, 1])).toBe(0.5)
    expect(nearestRate(3)).toBe(2)
    expect(nearestRate(1, [])).toBe(1)
  })
})

describe('YouTubeMediaHandler', () => {
  let player: FakePlayer
  let target: ReturnType<typeof makeTarget>
  let handler: YouTubeMediaHandler

  beforeEach(() => {
    vi.useFakeTimers()
    player = new FakePlayer()
    target = makeTarget()
    handler = new YouTubeMediaHandler(player, target, 50)
  })

  afterEach(() => {
    handler.destroy()
    vi.useRealTimers()
  })

  it('тривалість у мс, 0 поки невідома', () => {
    expect(handler.backingTrackDuration).toBe(200_000)
    player.duration = Number.NaN
    expect(handler.backingTrackDuration).toBe(0)
  })

  it('seek до старту відкладається і застосовується в play()', () => {
    handler.seekTo(12_000)
    expect(player.calls).toEqual([])
    handler.play()
    expect(player.calls).toEqual(['seek:12', 'play'])
    expect(player.state).toBe(YtState.PLAYING)
  })

  it('seek під час паузи виконується одразу й не запускає відео', () => {
    player.state = YtState.PAUSED
    handler.seekTo(5_000)
    expect(player.calls).toEqual(['seek:5'])
    expect(player.state).toBe(YtState.PAUSED)
  })

  it('seek після завершення (stop → 0) не перезапускає відео', () => {
    player.state = YtState.ENDED
    handler.seekTo(0)
    expect(player.calls).toEqual([])
    expect(player.state).toBe(YtState.ENDED)
  })

  it('PLAYING запускає тікер позиції і підтягує alphaTab', () => {
    player.time = 1
    handler.onStateChange(YtState.PLAYING)
    expect(target.calls).toEqual(['play'])
    vi.advanceTimersByTime(160)
    expect(target.positions).toEqual([1000, 1000, 1000])
    target.calls.length = 0
    // повторний PLAYING, коли alphaTab уже грає, нічого не дублює
    handler.onStateChange(YtState.PLAYING)
    expect(target.calls).toEqual([])
  })

  it('PAUSED зупиняє тікер, надсилає фінальну позицію і ставить alphaTab на паузу', () => {
    handler.onStateChange(YtState.PLAYING)
    vi.advanceTimersByTime(50)
    player.time = 2.5
    handler.onStateChange(YtState.PAUSED)
    expect(target.calls).toEqual(['play', 'pause'])
    expect(target.positions.at(-1)).toBe(2500)
    const n = target.positions.length
    vi.advanceTimersByTime(500)
    expect(target.positions.length).toBe(n)
  })

  it('ENDED зупиняє alphaTab', () => {
    handler.onStateChange(YtState.PLAYING)
    handler.onStateChange(YtState.ENDED)
    expect(target.calls).toEqual(['play', 'stop'])
  })

  it('playbackRate прив’язується до доступних швидкостей', () => {
    handler.playbackRate = 0.6
    expect(handler.playbackRate).toBe(0.5)
    expect(player.calls).toEqual(['rate:0.5'])
    handler.playbackRate = 0.5
    expect(player.calls).toEqual(['rate:0.5'])
  })

  it('зміна швидкості в плеєрі передається alphaTab', () => {
    handler.onPlaybackRateChange(1.5)
    expect(target.speed).toBe(1.5)
    expect(handler.playbackRate).toBe(1.5)
  })

  it('гучність 0..1 ↔ 0..100', () => {
    handler.masterVolume = 0.37
    expect(player.volume).toBe(37)
    handler.masterVolume = 2
    expect(player.volume).toBe(100)
    expect(handler.masterVolume).toBe(1)
  })

  it('destroy зупиняє тікер', () => {
    handler.onStateChange(YtState.PLAYING)
    handler.destroy()
    const n = target.positions.length
    vi.advanceTimersByTime(500)
    expect(target.positions.length).toBe(n)
  })
})
