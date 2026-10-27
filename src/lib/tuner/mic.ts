// Мікрофон → AnalyserNode → detectPitch.
//
// Вибрано AnalyserNode + requestAnimationFrame, а не AudioWorklet: алгоритм живе в одному
// чистому модулі pitch.ts (його ж тестує Node-скрипт), немає окремого воркліт-файлу, який Vite
// не транспілює з TypeScript, і детекція (~2 мс на виклик) спокійно вкладається в головний потік.

import { getAudioContext } from '../audio'
import { detectPitch } from './pitch'
import { PitchSmoother, type PitchReading } from './smoother'

/** 8192 відліки: ≥ 2 періоди найнижчої струни (B0 ≈ 31 Гц) і ~170 мс затримки при 48 кГц. */
const FFT_SIZE = 8192
/** Скільки мс між вимірами (~30 разів на секунду). */
const INTERVAL_MS = 33

export type MicErrorCode = 'insecure' | 'unsupported' | 'denied' | 'no-device' | 'busy' | 'unknown'

/** Текст для користувача складає UI за кодом (мовою інтерфейсу); message — технічна деталь. */
export class MicError extends Error {
  code: MicErrorCode
  constructor(code: MicErrorCode, message: string = code) {
    super(message)
    this.name = 'MicError'
    this.code = code
  }
}

function toMicError(e: unknown): MicError {
  const name = e instanceof DOMException || e instanceof Error ? e.name : ''
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
    case 'PermissionDeniedError':
      return new MicError('denied')
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return new MicError('no-device')
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return new MicError('busy')
    default:
      return new MicError('unknown', e instanceof Error ? e.message : '')
  }
}

export class PitchTracker {
  /** Нове згладжене значення; null — сигналу нема (і утримання закінчилось). */
  onReading: (r: PitchReading | null) => void = () => {}
  /** Мікрофон відключився сам (витягнули пристрій, система забрала доступ). */
  onEnded: () => void = () => {}

  private stream: MediaStream | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private analyser: AnalyserNode | null = null
  private mute: GainNode | null = null
  private buf: Float32Array<ArrayBuffer> = new Float32Array(FFT_SIZE)
  private smoother = new PitchSmoother(5, 400)
  private raf = 0
  private lastRun = 0
  private startToken = 0
  private running = false

  get active(): boolean {
    return this.running
  }

  /** Викликати з обробника кліку: вимоги автовідтворення і запит дозволу потребують жесту. */
  async start(): Promise<void> {
    if (this.running) return
    if (typeof window === 'undefined' || !window.isSecureContext) {
      throw new MicError('insecure')
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new MicError('unsupported')
    }

    const token = ++this.startToken
    // Контекст створюємо до await, поки жест користувача ще «свіжий».
    const ctx = getAudioContext()

    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      })
    } catch (e) {
      throw toMicError(e)
    }
    if (token !== this.startToken) {
      // stop() викликали, поки чекали на дозвіл.
      for (const t of stream.getTracks()) t.stop()
      return
    }

    const analyser = ctx.createAnalyser()
    analyser.fftSize = FFT_SIZE
    analyser.smoothingTimeConstant = 0
    const source = ctx.createMediaStreamSource(stream)
    source.connect(analyser)
    // Нульове підсилення в destination: вузол «тягнеться» графом у Safari, а звук мікрофона не лунає в динаміках.
    const mute = ctx.createGain()
    mute.gain.value = 0
    analyser.connect(mute)
    mute.connect(ctx.destination)

    for (const t of stream.getAudioTracks()) {
      t.onended = () => {
        if (this.stream !== stream) return
        this.stop()
        this.onEnded()
      }
    }

    this.stream = stream
    this.source = source
    this.analyser = analyser
    this.mute = mute
    this.buf = new Float32Array(analyser.fftSize)
    this.smoother.reset()
    this.running = true
    this.lastRun = 0
    this.raf = requestAnimationFrame(this.tick)
  }

  stop() {
    this.startToken++
    this.running = false
    cancelAnimationFrame(this.raf)
    if (this.stream) {
      for (const t of this.stream.getTracks()) {
        t.onended = null
        t.stop()
      }
    }
    this.source?.disconnect()
    this.analyser?.disconnect()
    this.mute?.disconnect()
    this.stream = this.source = this.analyser = this.mute = null
    this.smoother.reset()
  }

  private tick = (t: number) => {
    if (!this.running || !this.analyser) return
    this.raf = requestAnimationFrame(this.tick)
    if (t - this.lastRun < INTERVAL_MS) return
    this.lastRun = t

    const ctx = this.analyser.context as AudioContext
    // Safari/iOS може призупинити контекст (згортання, дзвінок): пробуємо відновити.
    if (ctx.state !== 'running') void ctx.resume().catch(() => {})

    this.analyser.getFloatTimeDomainData(this.buf)
    this.onReading(this.smoother.push(detectPitch(this.buf, ctx.sampleRate), t))
  }
}
