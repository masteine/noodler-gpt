import type { SchedulerCommand } from './scheduler.worker'

export interface BeatEvent {
  /** Індекс долі в такті, з нуля. */
  beat: number
  /** Індекс підрозділу всередині долі, з нуля (0 = сама доля). */
  sub: number
  /** Час кліку за годинником AudioContext. */
  time: number
}

export const BPM_MIN = 30
export const BPM_MAX = 300

/**
 * Метроном за схемою "lookahead scheduling": Worker будить нас кожні ~25 мс,
 * ми плануємо всі кліки на найближчі scheduleAhead секунд точно по аудіо-годиннику.
 * Завдяки цьому клік не пливе, навіть якщо головний потік зайнятий рендером.
 */
export class Metronome {
  bpm = 120
  beatsPerBar = 4
  /** Яка нота рахується за долю: 4 = чверть, 8 = восьма. BPM завжди означає кількість таких долей за хвилину. */
  beatUnit = 4
  /** Скільки кліків на одну долю: 1, 2 (восьмі), 3 (тріолі), 4 (шістнадцяті). */
  subdivision = 1
  accentFirstBeat = true
  volume = 1

  onBeat?: (e: BeatEvent) => void
  onStateChange?: (running: boolean) => void

  private readonly ctx: AudioContext
  private readonly worker: Worker
  private readonly lookaheadMs = 25
  /** Скільки секунд уперед планувати. У фоновій вкладці збільшуємо, бо Worker можуть пригальмувати. */
  private scheduleAhead = 0.15
  private nextTime = 0
  private beat = 0
  private sub = 0
  /** Підрозділ, зафіксований на початку поточної долі: зміна діє з наступної долі. */
  private beatSubdivision = 1
  private running = false
  private visualTimers = new Set<ReturnType<typeof setTimeout>>()
  /** Осцилятори, які вже заплановані, але ще не відзвучали: на stop() їх треба скасувати. */
  private pending = new Set<OscillatorNode>()

  constructor(ctx: AudioContext) {
    this.ctx = ctx
    this.worker = new Worker(new URL('./scheduler.worker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = () => this.schedule()
    document.addEventListener('visibilitychange', this.onVisibility)
    this.ctx.addEventListener('statechange', this.onCtxState)
  }

  get isRunning() {
    return this.running
  }

  start() {
    if (this.running) return
    void this.ctx.resume()
    // iOS: без цього беззвучний перемикач глушить Web Audio.
    const session = (navigator as { audioSession?: { type: string } }).audioSession
    if (session) session.type = 'playback'
    this.running = true
    this.beat = 0
    this.sub = 0
    this.nextTime = this.ctx.currentTime + 0.05
    this.post({ type: 'start', interval: this.lookaheadMs })
    this.schedule()
    this.onStateChange?.(true)
  }

  stop() {
    if (!this.running) return
    this.running = false
    this.post({ type: 'stop' })
    for (const t of this.visualTimers) clearTimeout(t)
    this.visualTimers.clear()
    // Скасовуємо кліки, заплановані наперед (у прихованій вкладці це до 1.2 с).
    const now = this.ctx.currentTime
    for (const osc of this.pending) {
      try {
        osc.stop(now)
      } catch {
        /* уже зупинений */
      }
    }
    this.pending.clear()
    this.onStateChange?.(false)
  }

  toggle() {
    if (this.running) this.stop()
    else this.start()
  }

  destroy() {
    this.stop()
    this.worker.terminate()
    document.removeEventListener('visibilitychange', this.onVisibility)
    this.ctx.removeEventListener('statechange', this.onCtxState)
  }

  private post(cmd: SchedulerCommand) {
    this.worker.postMessage(cmd)
  }

  /** iOS: дзвінок, Siri або блокування екрана зупиняють годинник контексту, тож UI має це показати. */
  private onCtxState = () => {
    if (this.running && this.ctx.state !== 'running') this.stop()
  }

  private onVisibility = () => {
    this.scheduleAhead = document.hidden ? 1.2 : 0.15
    if (this.running) this.schedule()
  }

  private schedule() {
    if (!this.running) return
    const horizon = this.ctx.currentTime + this.scheduleAhead
    while (this.nextTime < horizon) {
      // Розмір або підрозділ могли зменшити під час гри: тримаємо лічильники в межах такту.
      if (this.beat >= this.beatsPerBar) this.beat = 0
      if (this.sub === 0) this.beatSubdivision = this.subdivision
      this.click(this.beat, this.sub, this.nextTime)
      this.advance()
    }
  }

  private advance() {
    const secondsPerBeat = 60 / this.bpm
    this.nextTime += secondsPerBeat / this.beatSubdivision
    this.sub += 1
    if (this.sub >= this.beatSubdivision) {
      this.sub = 0
      this.beat = (this.beat + 1) % this.beatsPerBar
    }
  }

  private click(beat: number, sub: number, time: number) {
    const isAccent = this.accentFirstBeat && beat === 0 && sub === 0
    const isSub = sub !== 0
    const freq = isAccent ? 1320 : isSub ? 660 : 880
    const gain = (isAccent ? 1 : isSub ? 0.3 : 0.65) * this.volume

    // Короткий синтезований клік: синус із різкою атакою та швидким затуханням.
    const osc = this.ctx.createOscillator()
    const env = this.ctx.createGain()
    osc.type = 'sine'
    osc.frequency.value = freq
    env.gain.setValueAtTime(0.0001, time)
    env.gain.exponentialRampToValueAtTime(Math.max(gain, 0.0001), time + 0.002)
    env.gain.exponentialRampToValueAtTime(0.0001, time + 0.045)
    osc.connect(env).connect(this.ctx.destination)
    osc.start(time)
    osc.stop(time + 0.05)
    this.pending.add(osc)
    osc.onended = () => this.pending.delete(osc)

    // Візуальний маячок синхронізуємо з аудіо-часом, а не з моментом планування.
    // Вспалах синхронізуємо з моментом, коли звук реально дійде до користувача (Bluetooth додає 150-250 мс).
    const latency = this.ctx.outputLatency || this.ctx.baseLatency || 0
    const delay = Math.max(0, (time - this.ctx.currentTime + latency) * 1000)
    const timer = setTimeout(() => {
      this.visualTimers.delete(timer)
      if (this.running) this.onBeat?.({ beat, sub, time })
    }, delay)
    this.visualTimers.add(timer)
  }
}

/** Tap tempo: тримає останні натискання і рахує середній інтервал. */
export class TapTempo {
  private taps: number[] = []
  private readonly resetAfterMs = 2000
  private readonly maxTaps = 8

  /** Повертає новий BPM або null, якщо натискань ще замало. */
  tap(now = performance.now()): number | null {
    const last = this.taps[this.taps.length - 1]
    if (last !== undefined && now - last > this.resetAfterMs) this.taps = []
    this.taps.push(now)
    if (this.taps.length > this.maxTaps) this.taps.shift()
    if (this.taps.length < 2) return null
    const span = this.taps[this.taps.length - 1] - this.taps[0]
    const avgInterval = span / (this.taps.length - 1)
    const bpm = Math.round(60000 / avgInterval)
    return Math.min(BPM_MAX, Math.max(BPM_MIN, bpm))
  }

  reset() {
    this.taps = []
  }
}
