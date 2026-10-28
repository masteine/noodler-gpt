// Оркестратор на фейковому плеєрі й рекордері: «відео» — синтезований риф із тишею на початку,
// рекордер віддає семпли в темпі «реального часу» (керованого sleep), плеєр повідомляє час.
import { describe, expect, it } from 'vitest'
import { CancelledError, autoSyncOffset, median, type RecorderLike } from './autosync'
import { chromaFromNotes, type BarTime, type NoteEvent } from './score'
import { mix, tone } from './chroma.test'
import { YtState, type YtPlayerLike } from '../youtube/handler'

const SR = 22050
const BAR_MS = 2000

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

function bars(count: number, shiftMs = 0): BarTime[] {
  return Array.from({ length: count }, (_, i) => ({ barIndex: i, barOccurence: 0, startMs: i * BAR_MS + shiftMs }))
}

/** Темп запису: час у табі (мс) → час у «відео» (с). Кусково-лінійний, щоб перевірити мітки. */
type Warp = (tabMs: number) => number

const linear =
  (leadIn: number, ratio: number): Warp =>
  (ms) =>
    leadIn + (ms / 1000) * ratio

/** «Відео»: тиша leadIn с, далі риф. Плеєр і рекордер читають один годинник. */
class World {
  clock = 0 // секунди відео
  audio: Float32Array
  constructor(notes: NoteEvent[], warp: Warp, tail = 30) {
    const total = warp(notes.at(-1)!.onsetMs + 2000) + tail
    this.audio = new Float32Array(Math.round(total * SR))
    for (const n of notes) {
      const at = Math.round(warp(n.onsetMs) * SR)
      const len = warp(n.onsetMs + Math.max(300, n.durationMs)) - warp(n.onsetMs)
      mix(this.audio, tone(n.midi, len * 1.5), at)
    }
  }
  get duration() {
    return this.audio.length / SR
  }
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
  readonly sampleRate = SR
  ended = false
  private from = 0
  private taken = 0
  private active = false
  constructor(
    private world: World,
    private latency = 0.12,
    /** Чи «виміряв» рекордер свою затримку (як справжній — клацанням). */
    readonly latencySeconds = latency,
  ) {}
  get seconds() {
    return this.active ? Math.max(0, this.world.clock - this.from - this.latency) : 0
  }
  start() {
    this.active = true
    this.from = this.world.clock
    this.taken = 0
  }
  drain() {
    const upto = this.seconds
    const chunk = this.world.slice(this.from + this.taken, this.from + upto)
    this.taken = upto
    return chunk.length ? [Float32Array.from(chunk)] : []
  }
  stop() {
    this.active = false
  }
}

/** sleep, що крутить годинник «відео», поки плеєр грає. */
function makeSleep(world: World, player: FakePlayer) {
  return async (ms: number) => {
    if (player.playing) world.clock += ms / 1000
  }
}

const notes = riff(30) // 60 с нот, 30 тактів по 2 с: еталон пошуку (30 с) покриває лише половину

describe('autoSyncOffset', () => {
  it('знаходить початок при інтро 6.4 с і ставить мітки по тактах', async () => {
    const warp = linear(6.4, 1)
    const world = new World(notes, warp)
    const player = new FakePlayer(world)
    const recorder = new FakeRecorder(world)
    const phases: string[] = []
    const result = await autoSyncOffset({
      player,
      notes,
      bars: bars(30),
      recorder,
      sleep: makeSleep(world, player),
      onProgress: (p) => phases.push(p.phase),
    })
    expect(Math.abs(result.offsetMs - 6400)).toBeLessThan(250)
    expect(result.confidence).toBe('good')
    expect(result.shift).toBe(0)
    expect(result.trackedBars).toBe(30)
    expect(player.playing).toBe(false)
    expect(phases).toContain('tracking')
    expect(phases.at(-1)).toBe('analyzing')
    expect(result.points[0]).toEqual({ barIndex: 0, barOccurence: 0, barPosition: 0, millisecondOffset: result.offsetMs })
    expect(result.points.length).toBeGreaterThanOrEqual(5)
    for (const p of result.points) {
      expect(Math.abs(p.millisecondOffset - warp(p.barIndex * BAR_MS) * 1000)).toBeLessThan(120)
    }
    for (let i = 1; i < result.points.length; i++) expect(result.points[i].millisecondOffset).toBeGreaterThan(result.points[i - 1].millisecondOffset)
  })

  it('запис, що сповільнюється посередині: мітки йдуть за темпом', async () => {
    // Перші 18 тактів у темпі табу, далі на 25 % повільніше (уже під час відстеження).
    const knee = 18 * BAR_MS
    const warp: Warp = (ms) => 3 + (ms <= knee ? ms / 1000 : knee / 1000 + ((ms - knee) / 1000) * 1.25)
    const world = new World(notes, warp)
    const player = new FakePlayer(world)
    const recorder = new FakeRecorder(world)
    const result = await autoSyncOffset({ player, notes, bars: bars(30), recorder, sleep: makeSleep(world, player) })
    expect(result.trackedBars).toBe(30)
    const lastPoint = result.points.at(-1)!
    expect(lastPoint.barIndex).toBe(29)
    for (const p of result.points) {
      expect(Math.abs(p.millisecondOffset - warp(p.barIndex * BAR_MS) * 1000)).toBeLessThan(120)
    }
  })

  it('невиміряна затримка захоплення зсуває всі мітки на неї', async () => {
    const warp = linear(3, 1)
    const world = new World(notes, warp)
    const player = new FakePlayer(world)
    const recorder = new FakeRecorder(world, 0.3, 0)
    const result = await autoSyncOffset({ player, notes, bars: bars(30), recorder, sleep: makeSleep(world, player) })
    const late = result.points.slice(1).map((p) => p.millisecondOffset - warp(p.barIndex * BAR_MS) * 1000)
    expect(median(late)).toBeGreaterThan(200)
    expect(median(late)).toBeLessThan(400)
  })

  it('таб із паузою на початку: зсув ураховує, що перша нота не на такті 1', async () => {
    const shifted = notes.map((n) => ({ ...n, onsetMs: n.onsetMs + 2000 }))
    const world = new World(notes, linear(5, 1))
    const player = new FakePlayer(world)
    const recorder = new FakeRecorder(world)
    const result = await autoSyncOffset({ player, notes: shifted, bars: bars(31), recorder, sleep: makeSleep(world, player) })
    // Нота з табу (2 с після такту 1) звучить у відео на 5 с, отже такт 1 — на 3 с.
    expect(Math.abs(result.offsetMs - 3000)).toBeLessThan(250)
  })

  it('«Стоп» після знайденого початку завершує з тим, що простежено', async () => {
    const world = new World(notes, linear(2, 1))
    const player = new FakePlayer(world)
    const recorder = new FakeRecorder(world)
    const abort = new AbortController()
    const sleep = async (ms: number) => {
      if (player.playing) world.clock += ms / 1000
      if (world.clock > 40) abort.abort()
    }
    const result = await autoSyncOffset({ player, notes, bars: bars(30), recorder, sleep, signal: abort.signal })
    expect(Math.abs(result.offsetMs - 2000)).toBeLessThan(250)
    expect(result.trackedBars).toBeGreaterThanOrEqual(13)
    expect(result.trackedBars).toBeLessThan(30)
  })

  it('скасування до перших секунд — CancelledError', async () => {
    const world = new World(notes, linear(3, 1))
    const player = new FakePlayer(world)
    const recorder = new FakeRecorder(world)
    const abort = new AbortController()
    const sleep = async (ms: number) => {
      if (player.playing) world.clock += ms / 1000
      if (world.clock > 2) abort.abort()
    }
    await expect(autoSyncOffset({ player, notes, bars: bars(30), recorder, sleep, signal: abort.signal })).rejects.toBeInstanceOf(CancelledError)
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
