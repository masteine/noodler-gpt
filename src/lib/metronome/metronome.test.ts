import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BPM_MAX, BPM_MIN, Metronome, TapTempo, type BeatEvent } from './metronome'

// ---------------------------------------------------------------------------
// Моки браузерного оточення (у Node немає Worker, document і AudioContext)
// ---------------------------------------------------------------------------

class FakeWorker {
  static instances: FakeWorker[] = []

  onmessage: ((e: { data: unknown }) => void) | null = null
  messages: unknown[] = []
  terminated = false

  constructor() {
    FakeWorker.instances.push(this)
  }

  postMessage(msg: unknown) {
    this.messages.push(msg)
  }

  terminate() {
    this.terminated = true
  }

  /** Імітує "tick" від справжнього Worker. */
  tick() {
    this.onmessage?.({ data: 'tick' })
  }

  messagesOfType(type: string) {
    return this.messages.filter((m) => (m as { type: string }).type === type)
  }
}

type Listener = () => void

function createFakeDocument() {
  const listeners = new Map<string, Set<Listener>>()
  return {
    hidden: false,
    addEventListener: vi.fn((type: string, fn: Listener) => {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)!.add(fn)
    }),
    removeEventListener: vi.fn((type: string, fn: Listener) => {
      listeners.get(type)?.delete(fn)
    }),
    dispatch(type: string) {
      for (const fn of [...(listeners.get(type) ?? [])]) fn()
    },
    listenerCount(type: string) {
      return listeners.get(type)?.size ?? 0
    },
  }
}

class FakeAudioParam {
  /** Усі значення, які присвоювали через `.value = ...`. */
  valueWrites: number[] = []
  private _value = 0

  get value() {
    return this._value
  }
  set value(v: number) {
    this._value = v
    this.valueWrites.push(v)
  }

  setValueAtTime = vi.fn()
  exponentialRampToValueAtTime = vi.fn()
}

interface Click {
  /** Аргумент osc.start(time). */
  time: number
  /** Частота осцилятора на момент start(). */
  freq: number
}

class FakeAudioContext {
  currentTime = 0
  destination = { kind: 'destination' }
  resume = vi.fn(() => Promise.resolve())
  state: string = 'running'
  private listeners = new Set<() => void>()
  addEventListener(_type: string, fn: () => void) {
    this.listeners.add(fn)
  }
  removeEventListener(_type: string, fn: () => void) {
    this.listeners.delete(fn)
  }
  /** Імітує зміну стану контексту (iOS: interrupted). */
  setState(state: string) {
    this.state = state
    for (const fn of this.listeners) fn()
  }
  clicks: Click[] = []

  createOscillator() {
    const ctx = this
    const osc = {
      type: 'square',
      frequency: new FakeAudioParam(),
      connect: (node: unknown) => node,
      start(time: number) {
        ctx.clicks.push({ time, freq: osc.frequency.value })
      },
      stop: vi.fn(),
    }
    return osc
  }

  createGain() {
    return {
      gain: new FakeAudioParam(),
      connect: (node: unknown) => node,
    }
  }

  asContext() {
    return this as unknown as AudioContext
  }
}

// ---------------------------------------------------------------------------
// TapTempo
// ---------------------------------------------------------------------------

describe('TapTempo', () => {
  it('returns null on the first tap', () => {
    expect(new TapTempo().tap(1000)).toBeNull()
  })

  it('returns 120 BPM for two taps 500 ms apart', () => {
    const t = new TapTempo()
    t.tap(1000)
    expect(t.tap(1500)).toBe(120)
  })

  it('returns 120 BPM for a steady series of taps 500 ms apart', () => {
    const t = new TapTempo()
    let bpm: number | null = null
    for (let i = 0; i < 5; i++) bpm = t.tap(i * 500)
    expect(bpm).toBe(120)
  })

  it('starts a new series when the pause since the last tap exceeds 2000 ms', () => {
    const t = new TapTempo()
    t.tap(0)
    t.tap(500)
    // Пауза 2001 мс: старі тапи відкидаються, це знову перший тап.
    expect(t.tap(2501)).toBeNull()
  })

  it('does not reset when the pause is exactly 2000 ms', () => {
    const t = new TapTempo()
    t.tap(0)
    expect(t.tap(2000)).toBe(30)
  })

  it('ignores taps from before the pause when computing tempo after a reset by timeout', () => {
    const t = new TapTempo()
    t.tap(0)
    t.tap(100)
    t.tap(10_000)
    expect(t.tap(10_500)).toBe(120)
  })

  it('clamps slow tapping to BPM_MIN', () => {
    const t = new TapTempo()
    t.tap(0)
    // Найповільніший інтервал без скидання - 2000 мс, це рівно 30 BPM.
    expect(t.tap(2000)).toBe(BPM_MIN)
  })

  it('clamps very fast tapping to BPM_MAX', () => {
    const t = new TapTempo()
    t.tap(0)
    // 100 мс між тапами = 600 BPM, має обрізатися до 300.
    expect(t.tap(100)).toBe(BPM_MAX)
  })

  it('exposes the 30..300 tempo range', () => {
    expect(BPM_MIN).toBe(30)
    expect(BPM_MAX).toBe(300)
  })

  it('averages over only the last 8 taps', () => {
    const t = new TapTempo()
    // Спершу 4 повільні тапи з інтервалом 1000 мс (60 BPM)...
    let now = 0
    t.tap(now)
    for (let i = 0; i < 3; i++) t.tap((now += 1000))
    // ...потім 8 швидких з інтервалом 500 мс. Старі тапи мають повністю випасти з вікна.
    let bpm: number | null = null
    for (let i = 0; i < 8; i++) bpm = t.tap((now += 500))
    expect(bpm).toBe(120)
  })

  it('still includes slower older taps while they are within the last 8', () => {
    const t = new TapTempo()
    t.tap(0)
    t.tap(1000) // інтервал 1000
    // Один швидкий інтервал 500: середнє (1000 + 500) / 2 = 750 мс -> 80 BPM.
    expect(t.tap(1500)).toBe(80)
  })

  it('reset() forgets previous taps', () => {
    const t = new TapTempo()
    t.tap(0)
    t.tap(500)
    t.reset()
    expect(t.tap(600)).toBeNull()
  })

  it('computes tempo normally after reset() and two new taps', () => {
    const t = new TapTempo()
    t.tap(0)
    t.tap(500)
    t.reset()
    t.tap(600)
    expect(t.tap(1000)).toBe(150)
  })
})

// ---------------------------------------------------------------------------
// Metronome
// ---------------------------------------------------------------------------

describe('Metronome', () => {
  let ctx: FakeAudioContext
  let doc: ReturnType<typeof createFakeDocument>
  let metronome: Metronome

  const worker = () => FakeWorker.instances[FakeWorker.instances.length - 1]

  /**
   * Просуває годинник AudioContext кроками по 50 мс і "тикає" воркер після кожного кроку.
   * Фейкові таймери рухаємо синхронно з аудіо-годинником, щоб onBeat спрацьовував у хронологічному порядку.
   */
  function advance(seconds: number) {
    const step = 0.05
    const steps = Math.round(seconds / step)
    for (let i = 0; i < steps; i++) {
      ctx.currentTime += step
      vi.advanceTimersByTime(step * 1000)
      worker().tick()
    }
  }

  const intervals = (times: number[]) => times.slice(1).map((t, i) => t - times[i])
  const clickTimes = () => ctx.clicks.map((c) => c.time)

  beforeEach(() => {
    vi.useFakeTimers()
    FakeWorker.instances = []
    ctx = new FakeAudioContext()
    doc = createFakeDocument()
    vi.stubGlobal('Worker', FakeWorker)
    vi.stubGlobal('document', doc)
    metronome = new Metronome(ctx.asContext())
  })

  afterEach(() => {
    metronome.destroy()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  describe('lifecycle', () => {
    it('is not running right after construction', () => {
      expect(metronome.isRunning).toBe(false)
    })

    it('does not schedule anything before start()', () => {
      advance(1)
      expect(ctx.clicks).toHaveLength(0)
    })

    it('start() marks the metronome as running and resumes the audio context', () => {
      metronome.start()
      expect(metronome.isRunning).toBe(true)
      expect(ctx.resume).toHaveBeenCalledTimes(1)
    })

    it('start() asks the worker to start ticking every 25 ms', () => {
      metronome.start()
      expect(worker().messagesOfType('start')).toEqual([{ type: 'start', interval: 25 }])
    })

    it('start() schedules the first click 50 ms ahead of the audio clock', () => {
      ctx.currentTime = 10
      metronome.start()
      expect(ctx.clicks).toHaveLength(1)
      expect(ctx.clicks[0].time).toBeCloseTo(10.05, 10)
    })

    it('start() notifies onStateChange(true)', () => {
      const states: boolean[] = []
      metronome.onStateChange = (r) => states.push(r)
      metronome.start()
      expect(states).toEqual([true])
    })

    it('calling start() twice does not post a second start command', () => {
      metronome.start()
      metronome.start()
      expect(worker().messagesOfType('start')).toHaveLength(1)
    })

    it('calling start() twice does not duplicate the scheduled clicks', () => {
      metronome.start()
      metronome.start()
      expect(ctx.clicks).toHaveLength(1)
    })

    it('calling start() twice does not resume the context or notify twice', () => {
      const states: boolean[] = []
      metronome.onStateChange = (r) => states.push(r)
      metronome.start()
      metronome.start()
      expect(ctx.resume).toHaveBeenCalledTimes(1)
      expect(states).toEqual([true])
    })

    it('start() twice schedules the same clicks as a single start()', () => {
      metronome.start()
      metronome.start()
      advance(2)
      const doubled = clickTimes()

      const ctx2 = new FakeAudioContext()
      const m2 = new Metronome(ctx2.asContext())
      m2.start()
      for (let i = 0; i < 40; i++) {
        ctx2.currentTime += 0.05
        worker().tick()
      }
      expect(doubled).toEqual(ctx2.clicks.map((c) => c.time))
      m2.destroy()
    })

    it('stop() posts a stop command and flips isRunning', () => {
      metronome.start()
      metronome.stop()
      expect(metronome.isRunning).toBe(false)
      expect(worker().messagesOfType('stop')).toHaveLength(1)
    })

    it('stop() notifies onStateChange(false)', () => {
      const states: boolean[] = []
      metronome.onStateChange = (r) => states.push(r)
      metronome.start()
      metronome.stop()
      expect(states).toEqual([true, false])
    })

    it('stop() on a metronome that is not running does nothing', () => {
      const onState = vi.fn()
      metronome.onStateChange = onState
      metronome.stop()
      expect(onState).not.toHaveBeenCalled()
      expect(worker().messages).toHaveLength(0)
    })

    it('stops scheduling new clicks after stop() even if the worker keeps ticking', () => {
      metronome.start()
      advance(1)
      const before = ctx.clicks.length
      metronome.stop()
      advance(2)
      expect(ctx.clicks).toHaveLength(before)
    })

    it('stop() clears pending visual timers', () => {
      metronome.start()
      advance(1)
      expect(vi.getTimerCount()).toBeGreaterThan(0)
      metronome.stop()
      expect(vi.getTimerCount()).toBe(0)
    })

    it('does not fire onBeat after stop() for clicks that were already scheduled', () => {
      const onBeat = vi.fn()
      metronome.onBeat = onBeat
      metronome.start()
      metronome.stop()
      vi.runAllTimers()
      expect(onBeat).not.toHaveBeenCalled()
    })

    it('start() after stop() begins again from the first beat', () => {
      metronome.beatsPerBar = 4
      metronome.start()
      advance(1.1) // кілька доль
      metronome.stop()
      ctx.clicks.length = 0
      metronome.start()
      expect(ctx.clicks[0].freq).toBe(1320)
    })

    it('toggle() starts and then stops', () => {
      metronome.toggle()
      expect(metronome.isRunning).toBe(true)
      metronome.toggle()
      expect(metronome.isRunning).toBe(false)
    })

    it('destroy() terminates the worker', () => {
      metronome.destroy()
      expect(worker().terminated).toBe(true)
    })

    it('destroy() stops a running metronome', () => {
      metronome.start()
      metronome.destroy()
      expect(metronome.isRunning).toBe(false)
      expect(worker().messagesOfType('stop')).toHaveLength(1)
    })

    it('destroy() removes the visibilitychange listener it added', () => {
      expect(doc.listenerCount('visibilitychange')).toBe(1)
      metronome.destroy()
      expect(doc.listenerCount('visibilitychange')).toBe(0)
      expect(doc.removeEventListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function))
    })
  })

  describe('timing', () => {
    it('schedules clicks 0.5 s apart for 120 BPM in 4/4', () => {
      metronome.bpm = 120
      metronome.beatsPerBar = 4
      metronome.beatUnit = 4
      metronome.start()
      advance(4)
      const gaps = intervals(clickTimes())
      expect(gaps.length).toBeGreaterThanOrEqual(7)
      for (const g of gaps) expect(g).toBeCloseTo(0.5, 10)
    })

    it('schedules clicks 0.5 s apart for 6/8 at 120 BPM (BPM counts beats of the beat unit)', () => {
      metronome.bpm = 120
      metronome.beatsPerBar = 6
      metronome.beatUnit = 8
      metronome.start()
      advance(5)
      const gaps = intervals(clickTimes())
      expect(gaps.length).toBeGreaterThanOrEqual(8)
      for (const g of gaps) expect(g).toBeCloseTo(0.5, 10)
    })

    it('divides the beat interval by 2 for eighth-note subdivisions', () => {
      metronome.subdivision = 2
      metronome.start()
      advance(3)
      for (const g of intervals(clickTimes())) expect(g).toBeCloseTo(0.25, 10)
    })

    it('divides the beat interval by 3 for triplets', () => {
      metronome.subdivision = 3
      metronome.start()
      advance(3)
      const gaps = intervals(clickTimes())
      expect(gaps.length).toBeGreaterThanOrEqual(8)
      for (const g of gaps) expect(g).toBeCloseTo(0.5 / 3, 10)
    })

    it('divides the beat interval by 4 for sixteenth notes', () => {
      metronome.subdivision = 4
      metronome.start()
      advance(3)
      const gaps = intervals(clickTimes())
      expect(gaps.length).toBeGreaterThanOrEqual(8)
      for (const g of gaps) expect(g).toBeCloseTo(0.125, 10)
    })

    it('scales the interval with BPM (60 BPM gives 1 s)', () => {
      metronome.bpm = 60
      metronome.start()
      advance(4)
      for (const g of intervals(clickTimes())) expect(g).toBeCloseTo(1, 10)
    })

    it('does not schedule clicks further ahead than 0.15 s of the audio clock while visible', () => {
      metronome.start()
      advance(2)
      const last = clickTimes().at(-1)!
      expect(last).toBeLessThan(ctx.currentTime + 0.15)
    })

    it('looks ahead 1.2 s when the page becomes hidden', () => {
      metronome.start()
      doc.hidden = true
      doc.dispatch('visibilitychange')
      const last = clickTimes().at(-1)!
      expect(last).toBeGreaterThan(1)
      expect(last).toBeLessThan(ctx.currentTime + 1.2)
    })

    it('goes back to the short lookahead when the page becomes visible again', () => {
      metronome.start()
      doc.hidden = true
      doc.dispatch('visibilitychange')
      doc.hidden = false
      doc.dispatch('visibilitychange')
      ctx.currentTime = 20
      worker().tick()
      // Перший клік після довгої паузи плануємо у "минуле", далі лише в межах 0.15 с.
      const future = clickTimes().filter((t) => t > 20 + 0.15)
      expect(future).toHaveLength(0)
    })
  })

  describe('accents', () => {
    it('plays the first beat at 1320 Hz', () => {
      metronome.start()
      expect(ctx.clicks[0].freq).toBe(1320)
    })

    it('plays regular beats at 880 Hz', () => {
      metronome.start()
      advance(2)
      expect(ctx.clicks.slice(1, 4).map((c) => c.freq)).toEqual([880, 880, 880])
    })

    it('plays subdivision clicks at 660 Hz and keeps the accent only on sub 0 of beat 0', () => {
      metronome.subdivision = 2
      metronome.start()
      advance(2.2)
      // 4/4 з вісімками: 1320, 660, 880, 660, 880, 660, 880, 660, потім знову 1320
      expect(ctx.clicks.slice(0, 9).map((c) => c.freq)).toEqual([
        1320, 660, 880, 660, 880, 660, 880, 660, 1320,
      ])
    })

    it('does not accent the first beat when accentFirstBeat is false', () => {
      metronome.accentFirstBeat = false
      metronome.start()
      advance(2.2)
      expect(ctx.clicks.length).toBeGreaterThanOrEqual(5)
      expect(ctx.clicks.every((c) => c.freq !== 1320)).toBe(true)
      expect(ctx.clicks.slice(0, 5).map((c) => c.freq)).toEqual([880, 880, 880, 880, 880])
    })

    it('still plays subdivision clicks at 660 Hz when accentFirstBeat is false', () => {
      metronome.accentFirstBeat = false
      metronome.subdivision = 2
      metronome.start()
      advance(1.2)
      expect(ctx.clicks.slice(0, 4).map((c) => c.freq)).toEqual([880, 660, 880, 660])
    })

    it('accents the first beat of every bar, not just the first bar', () => {
      metronome.beatsPerBar = 3
      metronome.start()
      advance(4)
      const freqs = ctx.clicks.map((c) => c.freq)
      expect(freqs.slice(0, 7)).toEqual([1320, 880, 880, 1320, 880, 880, 1320])
    })

    it('applies the volume to the envelope peak', () => {
      metronome.volume = 0.5
      const gains: FakeAudioParam[] = []
      const origCreateGain = ctx.createGain.bind(ctx)
      ctx.createGain = () => {
        const g = origCreateGain()
        gains.push(g.gain)
        return g
      }
      metronome.start()
      // Акцент: gain 1 * volume 0.5, друга аргумент exponentialRamp = піковий рівень.
      expect(gains[0].exponentialRampToValueAtTime.mock.calls[0][0]).toBeCloseTo(0.5, 10)
    })
  })

  describe('beat counter', () => {
    function collectBeats() {
      const events: BeatEvent[] = []
      metronome.onBeat = (e) => events.push(e)
      return events
    }

    it('reports beat and sub indices via onBeat', () => {
      const events = collectBeats()
      metronome.subdivision = 2
      metronome.start()
      advance(1.2)
      vi.runAllTimers()
      expect(events.slice(0, 4).map((e) => [e.beat, e.sub])).toEqual([
        [0, 0],
        [0, 1],
        [1, 0],
        [1, 1],
      ])
    })

    it('passes the scheduled audio time to onBeat', () => {
      const events = collectBeats()
      metronome.start()
      vi.runAllTimers()
      expect(events[0].time).toBeCloseTo(0.05, 10)
    })

    it('fires onBeat only after the delay until the click time', () => {
      const events = collectBeats()
      metronome.start() // клік за 50 мс
      vi.advanceTimersByTime(49)
      expect(events).toHaveLength(0)
      vi.advanceTimersByTime(1)
      expect(events).toHaveLength(1)
    })

    it('wraps the beat counter around beatsPerBar', () => {
      const events = collectBeats()
      metronome.beatsPerBar = 3
      metronome.start()
      advance(4)
      vi.runAllTimers()
      expect(events.slice(0, 8).map((e) => e.beat)).toEqual([0, 1, 2, 0, 1, 2, 0, 1])
    })

    it('wraps correctly with subdivisions (sub resets on each new beat)', () => {
      const events = collectBeats()
      metronome.beatsPerBar = 2
      metronome.subdivision = 3
      metronome.start()
      advance(3)
      vi.runAllTimers()
      expect(events.slice(0, 7).map((e) => [e.beat, e.sub])).toEqual([
        [0, 0],
        [0, 1],
        [0, 2],
        [1, 0],
        [1, 1],
        [1, 2],
        [0, 0],
      ])
    })

    /**
     * Доводить лічильник до beat=5 при beatsPerBar=7: заплановані долі 0..4,
     * наступною до планування чекає доля 5.
     */
    function runUntilNextBeatIs5(events: BeatEvent[]) {
      metronome.beatsPerBar = 7
      metronome.start()
      while (ctx.clicks.length < 5) advance(0.05)
      vi.runAllTimers()
      expect(events.map((e) => e.beat)).toEqual([0, 1, 2, 3, 4])
      events.length = 0
    }

    // Регресія: schedule() раніше викликав click(this.beat, ...) без перевірки поточного
    // beatsPerBar, тож "осиротіла" доля 5 потрапляла в такт із 3 долей. Тепер лічильник
    // скидається на 0 перед кліком.
    it('keeps the beat counter within the bar when beatsPerBar shrinks from 7 to 3 at beat 5', () => {
      const events = collectBeats()
      runUntilNextBeatIs5(events)

      metronome.beatsPerBar = 3
      advance(2.5)
      vi.runAllTimers()

      expect(events.length).toBeGreaterThanOrEqual(4)
      expect(events.every((e) => e.beat < 3)).toBe(true)
    })

    it('starts a fresh 0,1,2 cycle right after beatsPerBar shrinks', () => {
      const events = collectBeats()
      runUntilNextBeatIs5(events)

      metronome.beatsPerBar = 3
      advance(2.5)
      vi.runAllTimers()

      const beats = events.map((e) => e.beat)
      expect(beats.length).toBeGreaterThanOrEqual(3)
      expect(beats.every((b) => b >= 0 && b < 3)).toBe(true)
      expect(beats.slice(0, 3)).toEqual([0, 1, 2])
    })

    it('plays an accented downbeat right after beatsPerBar shrinks past the current beat', () => {
      const events = collectBeats()
      runUntilNextBeatIs5(events)
      const before = ctx.clicks.length

      metronome.beatsPerBar = 3
      advance(0.6)
      const next = ctx.clicks.slice(before)
      expect(next.length).toBeGreaterThan(0)
      expect(next[0].freq).toBe(1320)
    })

    it('applies a subdivision change only from the next beat, keeping the grid', () => {
      metronome.bpm = 30
      metronome.subdivision = 4
      metronome.start()
      advance(0.9)
      metronome.subdivision = 1
      advance(8)
      const t = clickTimes()
      // Після зміни кожна нова доля стоїть на сітці 2 с, без зайвого кліку посеред долі.
      const downbeats = ctx.clicks.filter((c) => c.freq !== 660).map((c) => c.time)
      for (let i = 1; i < downbeats.length; i++) {
        const gap = downbeats[i] - downbeats[i - 1]
        expect(gap).toBeCloseTo(2, 6)
      }
      expect(t.length).toBeGreaterThan(3)
    })

    it('stops itself when the audio context leaves the running state (iOS interruption)', () => {
      metronome.start()
      expect(metronome.isRunning).toBe(true)
      ctx.setState('interrupted')
      expect(metronome.isRunning).toBe(false)
    })

    it('cancels already scheduled oscillators on stop()', () => {
      const oscs: { stop: ReturnType<typeof vi.fn> }[] = []
      const orig = ctx.createOscillator.bind(ctx)
      ctx.createOscillator = () => {
        const o = orig()
        oscs.push(o as unknown as { stop: ReturnType<typeof vi.fn> })
        return o
      }
      metronome.start()
      advance(0.3)
      const before = oscs.map((o) => o.stop.mock.calls.length)
      metronome.stop()
      const after = oscs.map((o) => o.stop.mock.calls.length)
      expect(after.some((n, i) => n > before[i])).toBe(true)
    })

    it('handles beatsPerBar growing during playback without leaving the new bar', () => {
      const events = collectBeats()
      metronome.beatsPerBar = 2
      metronome.start()
      advance(0.7)
      metronome.beatsPerBar = 5
      advance(4)
      vi.runAllTimers()
      expect(events.every((e) => e.beat >= 0 && e.beat < 5)).toBe(true)
    })
  })
})
