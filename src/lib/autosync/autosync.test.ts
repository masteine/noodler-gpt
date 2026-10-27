// Оркестратор на фейковому плеєрі й рекордері: «відео» — синтезований риф із тишею на початку,
// рекордер віддає семпли в темпі «реального часу» (керованого sleep), плеєр повідомляє час.
import { describe, expect, it } from 'vitest'
import { CancelledError, autoSyncOffset, median, type RecorderLike } from './autosync'
import type { Recording } from './capture'
import { chromaFromNotes, type NoteEvent } from './score'
import { mix, tone } from './chroma.test'
import { YtState, type YtPlayerLike } from '../youtube/handler'

const SR = 22050

function riff(bars: number): NoteEvent[] {
  const notes: NoteEvent[] = []
  const chords = [
    [40, 47, 52],
    [43, 50, 55],
    [45, 52, 57],
    [48, 55, 60],
  ]
  for (let bar = 0; bar < bars; bar++) {
    const chord = chords[bar % chords.length]
    for (let beat = 0; beat < 4; beat++) {
      const onsetMs = (bar * 4 + beat) * 500
      for (const midi of chord) notes.push({ onsetMs, durationMs: 450, midi })
      if (beat % 2 === 1) notes.push({ onsetMs: onsetMs + 250, durationMs: 200, midi: 64 + ((bar * 3 + beat) % 7) })
    }
  }
  return notes
}

/** «Відео»: тиша leadIn с, далі риф. Плеєр і рекордер читають один годинник. */
class World {
  clock = 0 // секунди відео
  audio: Float32Array
  constructor(notes: NoteEvent[], leadIn: number, tempoRatio = 1, tail = 30) {
    const total = leadIn + ((notes.at(-1)!.onsetMs + 2000) / 1000) * tempoRatio + tail
    this.audio = new Float32Array(Math.round(total * SR))
    for (const n of notes) {
      const at = Math.round((leadIn + (n.onsetMs / 1000) * tempoRatio) * SR)
      mix(this.audio, tone(n.midi, Math.max(0.3, n.durationMs / 1000) * 1.5), at)
    }
  }
  get duration() {
    return this.audio.length / SR
  }
  /** Семпли відео від секунди a до b. */
  slice(a: number, b: number) {
    return this.audio.subarray(Math.round(a * SR), Math.round(b * SR))
  }
}

class FakePlayer implements YtPlayerLike {
  state: number = YtState.CUED
  playing = false
  constructor(private world: World) {}
  getDuration() {
    return this.world.duration
  }
  getCurrentTime() {
    return this.world.clock
  }
  getPlayerState() {
    return this.state
  }
  playVideo() {
    this.state = YtState.PLAYING
    this.playing = true
  }
  pauseVideo() {
    this.state = YtState.PAUSED
    this.playing = false
  }
  seekTo(seconds: number) {
    this.world.clock = seconds
  }
  getPlaybackRate() {
    return 1
  }
  setPlaybackRate() {}
  getAvailablePlaybackRates() {
    return [1]
  }
  getVolume() {
    return 100
  }
  setVolume() {}
}

/** Рекордер: записує те, що «грає» плеєр, з невеликою затримкою захоплення. */
class FakeRecorder implements RecorderLike {
  ended = false
  private from = 0
  private active = false
  constructor(
    private world: World,
    private latency = 0.04,
  ) {}
  get seconds() {
    return this.active ? Math.max(0, this.world.clock - this.from - this.latency) : 0
  }
  start() {
    this.active = true
    this.from = this.world.clock
  }
  snapshot(): Recording {
    return { samples: this.world.slice(this.from, this.from + this.seconds), sampleRate: SR }
  }
  stop() {
    const rec = this.snapshot()
    this.active = false
    return rec
  }
}

/** sleep, що крутить годинник «відео», поки плеєр грає. */
function makeSleep(world: World, player: FakePlayer) {
  return async (ms: number) => {
    if (player.playing) world.clock += ms / 1000
  }
}

describe('autoSyncOffset', () => {
  const notes = riff(10) // 20 с нот

  it('знаходить початок при інтро 6.4 с і зупиняється раніше за повний запис', async () => {
    const world = new World(notes, 6.4)
    const player = new FakePlayer(world)
    const recorder = new FakeRecorder(world)
    const phases: string[] = []
    const result = await autoSyncOffset({
      player,
      notes,
      recorder,
      sleep: makeSleep(world, player),
      onProgress: (p) => phases.push(p.phase),
    })
    expect(Math.abs(result.offsetMs - 6400)).toBeLessThan(250)
    expect(result.confidence).toBe('good')
    expect(result.shift).toBe(0)
    expect(player.playing).toBe(false)
    expect(world.clock).toBeLessThan(6.4 + 20 + 10) // зупинилися невдовзі після кінця еталона
    expect(phases).toContain('listening')
    expect(phases.at(-1)).toBe('analyzing')
  })

  it('таб із паузою на початку: зсув ураховує, що перша нота не на такті 1', async () => {
    const shifted = notes.map((n) => ({ ...n, onsetMs: n.onsetMs + 2000 }))
    const world = new World(notes, 5)
    const player = new FakePlayer(world)
    const recorder = new FakeRecorder(world)
    const result = await autoSyncOffset({ player, notes: shifted, recorder, sleep: makeSleep(world, player) })
    // Нота з табу (2 с після такту 1) звучить у відео на 5 с, отже такт 1 — на 3 с.
    expect(Math.abs(result.offsetMs - 3000)).toBeLessThan(250)
  })

  it('скасування до перших секунд — CancelledError', async () => {
    const world = new World(notes, 3)
    const player = new FakePlayer(world)
    const recorder = new FakeRecorder(world)
    const abort = new AbortController()
    const sleep = async (ms: number) => {
      if (player.playing) world.clock += ms / 1000
      if (world.clock > 2) abort.abort()
    }
    await expect(autoSyncOffset({ player, notes, recorder, sleep, signal: abort.signal })).rejects.toBeInstanceOf(CancelledError)
    expect(player.playing).toBe(false)
  })

  it('median', () => {
    expect(median([])).toBe(0)
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 2, 3])).toBe(2.5)
  })

  it('еталон із нот не порожній для рифу', () => {
    expect(chromaFromNotes(notes, 5).length).toBe(50)
  })
})
