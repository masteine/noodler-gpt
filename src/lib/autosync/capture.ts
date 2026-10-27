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

export class TabAudioRecorder {
  private chunks: Float32Array[] = []
  private total = 0
  private recording = false
  /** Користувач зупинив «показ» вкладки в панелі браузера. */
  ended = false
  onended: (() => void) | null = null

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
      return new TabAudioRecorder(stream, context, node)
    } catch (e) {
      for (const track of stream.getTracks()) track.stop()
      void context.close()
      throw e
    }
  }

  get sampleRate(): number {
    return this.context.sampleRate
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

  /** Усе записане одним масивом, запис триває. */
  snapshot(): Recording {
    const samples = new Float32Array(this.total)
    let pos = 0
    for (const c of this.chunks) {
      samples.set(c, pos)
      pos += c.length
    }
    return { samples, sampleRate: this.context.sampleRate }
  }

  /** Зупиняє збір і віддає все записане. */
  stop(): Recording {
    this.recording = false
    const rec = this.snapshot()
    this.chunks = []
    return rec
  }

  close(): void {
    this.recording = false
    this.node.port.onmessage = null
    for (const track of this.stream.getTracks()) track.stop()
    void this.context.close()
  }
}
