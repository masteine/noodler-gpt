// Захоплення звуку власної вкладки через getDisplayMedia. Це єдиний спосіб у браузері почути,
// що грає iframe YouTube: Web Audio до cross-origin iframe не дістається. Працює лише в Chromium
// (Chrome, Edge) на десктопі — Safari й Firefox звук вкладки не віддають, мобільні браузери
// getDisplayMedia не мають. Звук лишається в пам’яті сторінки й нікуди не надсилається.

export interface Recording {
  samples: Float32Array
  sampleRate: number
}

export class NoTabAudioError extends Error {
  constructor() {
    super('tab audio not shared')
    this.name = 'NoTabAudioError'
  }
}

/** Чи браузер може захопити звук вкладки. */
export function isAutoSyncSupported(): boolean {
  if (typeof navigator === 'undefined') return false
  const md = navigator.mediaDevices
  if (!md || typeof md.getDisplayMedia !== 'function') return false
  const ua = navigator.userAgent
  if (/Mobi|Android|iPhone|iPad/i.test(ua)) return false
  return /Chrome\//.test(ua)
}

/** Код AudioWorklet: змішує канали в моно й шле блоки семплів у головний потік. */
const WORKLET = `
class NoodlerRecorder extends AudioWorkletProcessor {
  process(inputs) {
    const channels = inputs[0]
    if (!channels || channels.length === 0) return true
    const n = channels[0].length
    const mono = new Float32Array(n)
    for (const ch of channels) for (let i = 0; i < n; i++) mono[i] += ch[i] / channels.length
    this.port.postMessage(mono, [mono.buffer])
    return true
  }
}
registerProcessor('noodler-recorder', NoodlerRecorder)
`

/** Клацання для вимірювання затримки: частота, гучність, тривалість. */
const CLICK_HZ = 1000
const CLICK_GAIN = 0.2
const CLICK_SECONDS = 0.05
/** Скільки чекати на клацання в записі; більша затримка захоплення неправдоподібна. */
const CLICK_WAIT_SECONDS = 1.2
/** Поріг амплітуди, з якого вважаємо, що клацання дійшло. */
const CLICK_THRESHOLD = 0.02

export class TabAudioRecorder {
  private chunks: Float32Array[] = []
  private total = 0
  private recording = false
  /** Користувач зупинив «показ» вкладки в панелі браузера. */
  ended = false
  onended: (() => void) | null = null
  /**
   * Затримка захоплення в секундах: на стільки пізніше звук вкладки потрапляє в запис, ніж лунає.
   * Міряється в open() коротким клацанням через той самий шлях, що й звук відео. 0 — не виміряно.
   */
  latencySeconds = 0

  private constructor(
    private readonly stream: MediaStream,
    private readonly context: AudioContext,
    private readonly node: AudioWorkletNode,
  ) {
    node.port.onmessage = (e: MessageEvent<Float32Array>) => {
      if (!this.recording) return
      this.chunks.push(e.data)
      this.total += e.data.length
    }
    for (const track of stream.getAudioTracks()) {
      track.addEventListener('ended', () => {
        this.ended = true
        this.onended?.()
      })
    }
  }

  /**
   * Відкриває діалог «Поділитися» з підказкою вибрати поточну вкладку. Викликати лише з обробника
   * кліку: без жесту користувача браузер відмовить.
   */
  static async open(): Promise<TabAudioRecorder> {
    const constraints = {
      video: true, // Chrome не дозволяє запит лише звуку; відеодоріжку одразу зупиняємо
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      preferCurrentTab: true,
      selfBrowserSurface: 'include',
      systemAudio: 'exclude',
      surfaceSwitching: 'exclude',
      monitorTypeSurfaces: 'exclude',
    } as DisplayMediaStreamOptions
    const stream = await navigator.mediaDevices.getDisplayMedia(constraints)
    for (const track of stream.getVideoTracks()) track.stop()
    if (stream.getAudioTracks().length === 0) {
      for (const track of stream.getTracks()) track.stop()
      throw new NoTabAudioError()
    }
    const context = new AudioContext()
    try {
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }))
      try {
        await context.audioWorklet.addModule(url)
      } finally {
        URL.revokeObjectURL(url)
      }
      const node = new AudioWorkletNode(context, 'noodler-recorder', { numberOfOutputs: 1, outputChannelCount: [1] })
      const source = context.createMediaStreamSource(stream)
      source.connect(node)
      // Вузол мусить бути в графі до destination, щоб process() викликався; на вихід іде тиша.
      node.connect(context.destination)
      await context.resume()
      const recorder = new TabAudioRecorder(stream, context, node)
      await recorder.calibrate()
      return recorder
    } catch (e) {
      for (const track of stream.getTracks()) track.stop()
      void context.close()
      throw e
    }
  }

  get sampleRate(): number {
    return this.context.sampleRate
  }

  /**
   * Програє тихе клацання й дивиться, через скільки воно з’явилося в записі. Захоплення вкладки
   * йде через звуковий конвеєр браузера з помітною затримкою (десятки–сотні мс), а мітки без цієї
   * поправки запізнювались би рівно на стільки ж.
   */
  private async calibrate(): Promise<void> {
    const ctx = this.context
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.frequency.value = CLICK_HZ
    gain.gain.value = 0
    osc.connect(gain)
    gain.connect(ctx.destination)
    this.start()
    const startedAt = ctx.currentTime
    const at = startedAt + 0.25
    gain.gain.setValueAtTime(0, at)
    gain.gain.linearRampToValueAtTime(CLICK_GAIN, at + 0.005)
    gain.gain.setValueAtTime(CLICK_GAIN, at + CLICK_SECONDS)
    gain.gain.linearRampToValueAtTime(0, at + CLICK_SECONDS + 0.01)
    osc.start(at)
    osc.stop(at + CLICK_SECONDS + 0.02)
    await new Promise((r) => setTimeout(r, (at - startedAt + CLICK_WAIT_SECONDS) * 1000))
    this.stop()
    osc.disconnect()
    gain.disconnect()
    const rate = ctx.sampleRate
    const skip = Math.round((at - startedAt - 0.05) * rate)
    let index = 0
    let found = -1
    for (const chunk of this.drain()) {
      for (let i = 0; i < chunk.length && found < 0; i++) if (index + i >= skip && Math.abs(chunk[i]) > CLICK_THRESHOLD) found = index + i
      if (found >= 0) break
      index += chunk.length
    }
    this.chunks = []
    this.total = 0
    if (found < 0) return
    const latency = found / rate - (at - startedAt)
    if (latency >= -0.05 && latency <= CLICK_WAIT_SECONDS) this.latencySeconds = Math.max(0, latency)
  }

  /** Скільки секунд звуку вже зібрано. */
  get seconds(): number {
    return this.total / this.context.sampleRate
  }

  start(): void {
    this.chunks = []
    this.total = 0
    this.recording = true
  }

  /** Забирає шматки, що надійшли після попереднього drain. */
  drain(): Float32Array[] {
    const out = this.chunks
    this.chunks = []
    return out
  }

  stop(): void {
    this.recording = false
  }

  close(): void {
    this.recording = false
    this.node.port.onmessage = null
    for (const track of this.stream.getTracks()) track.stop()
    void this.context.close()
  }
}
