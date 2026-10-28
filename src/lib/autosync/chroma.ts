// Хрома-ознаки: для кожного кадру звуку 12 чисел — скільки енергії припадає на кожен клас висоти
// (C, C#, …, B) незалежно від октави. Тембр і гучність при цьому майже не важать, тому хрома
// запису з YouTube і хрома, побудована з нот табу, виходять порівнянними.
// Чисті функції без Web Audio: працюють і в тестах у Node.

/** Кадрів хроми за секунду. 10 кадрів — крок 100 мс, достатньо для зсуву початку. */
export const CHROMA_FPS = 10

/** Нижня і верхня межа частот, які враховуємо: нижче — гул, вище — лише обертони. */
const F_MIN = 60
const F_MAX = 2000

/** Вікно згладжування в кадрах (≈ 1 с): прибирає дрібні розбіжності атак між табом і записом. */
const SMOOTH = 9

/** Кадр, у якому енергії менше за цей поріг, вважаємо тишею (нульовий вектор). */
const SILENCE = 1e-6

/** Частота дискретизації, до якої понижуємо звук перед FFT. */
const TARGET_RATE = 12000

/** Кадрів «сили атак» за секунду: крок 10 мс, щоб уточнювати мітки точніше за хрому. */
export const ONSET_FPS = 100
/** Вікно FFT для атак (≈140 мс на 12 кГц): досить, щоб розрізнити півтони від ~120 Гц; приріст амплітуд
 * усе одно локалізує атаку на 10 мс, бо пік приросту припадає на центр вікна. */
const ONSET_FRAME = 2048
/** Нижня межа частот для атак: бас нижче дає замало роздільності, а в табі його атаки збігаються з гітарою. */
const ONSET_F_MIN = 120
/** Сила атак нормується на середню в околі стількох секунд, щоб тихі місця не губились. */
const ONSET_NORM_SECONDS = 1.5

export interface ChromaOptions {
  frameSize?: number
  fps?: number
}

/**
 * Хрома запису: samples — моно, sampleRate — Гц. Повертає список 12-вимірних векторів,
 * по одному на кожні 1/fps с. Вектори нормалізовані (довжина 1) або нульові для тиші.
 */
export function audioChroma(input: Float32Array, inputRate: number, options: ChromaOptions = {}): Float32Array[] {
  const stream = new ChromaStream(inputRate, options)
  stream.push(input)
  return stream.frames(true)
}

/**
 * Потокова хрома: звук додається шматками (push), кадри рахуються, щойно для них вистачає семплів.
 * Так під час прослуховування не треба щоразу перераховувати весь запис.
 */
export class ChromaStream {
  readonly fps: number
  private readonly frameSize: number
  private readonly factor: number
  private readonly hop: number
  private readonly window: Float32Array
  private readonly binToPc: Int8Array
  private readonly fir: Float32Array | null
  private readonly firHalf: number
  /** Хвіст вхідного сигналу, потрібний FIR-фільтру для наступних вихідних семплів. */
  private carry = new Float32Array(0)
  private carryBase = 0
  private nextCenter = 0
  /** Понижений сигнал цілком. */
  private dec = new Float32Array(1 << 16)
  private decLength = 0
  private raw: Float32Array[] = []
  private readonly re: Float32Array
  private readonly im: Float32Array
  /** Спектральний потік (сила атаки) по класах висот, по кадрах ONSET_FPS. */
  private flux: Float32Array[] = []
  private readonly onsetHop: number
  private readonly onsetWindow: Float32Array
  private readonly onsetBinToPc: Int8Array
  private prevMag: Float32Array | null = null
  private readonly onsetRe = new Float32Array(ONSET_FRAME)
  private readonly onsetIm = new Float32Array(ONSET_FRAME)

  constructor(inputRate: number, options: ChromaOptions = {}) {
    this.fps = options.fps ?? CHROMA_FPS
    this.frameSize = options.frameSize ?? 8192
    // Понижуємо частоту до ~11 кГц: бас тоді розділяється по півтонах (бін FFT ≈ 1.4 Гц), а рахунок дешевший.
    this.factor = Math.max(1, Math.floor(inputRate / TARGET_RATE))
    const rate = inputRate / this.factor
    this.hop = rate / this.fps
    this.window = hann(this.frameSize)
    this.binToPc = binClasses(this.frameSize, rate)
    this.fir = this.factor > 1 ? lowpass(this.factor) : null
    this.firHalf = this.fir ? (this.fir.length - 1) / 2 : 0
    this.re = new Float32Array(this.frameSize)
    this.im = new Float32Array(this.frameSize)
    this.onsetHop = rate / ONSET_FPS
    this.onsetWindow = hann(ONSET_FRAME)
    this.onsetBinToPc = binClasses(ONSET_FRAME, rate, ONSET_F_MIN)
  }

  /** Секунд звуку вже отримано. */
  get seconds(): number {
    return this.decLength / (this.hop * this.fps)
  }

  push(samples: Float32Array): void {
    if (!this.fir) {
      this.append(samples)
      return
    }
    // Склеюємо хвіст і нові семпли; абсолютний індекс buf[0] = carryBase.
    const buf = new Float32Array(this.carry.length + samples.length)
    buf.set(this.carry, 0)
    buf.set(samples, this.carry.length)
    const base = this.carryBase
    const half = this.firHalf
    const taps = this.fir.length
    const out: number[] = []
    while (this.nextCenter + half < base + buf.length) {
      let acc = 0
      for (let i = 0; i < taps; i++) {
        const idx = this.nextCenter + i - half - base
        if (idx >= 0 && idx < buf.length) acc += buf[idx] * this.fir[i]
      }
      out.push(acc)
      this.nextCenter += this.factor
    }
    this.append(Float32Array.from(out))
    const keepFrom = Math.max(0, this.nextCenter - half - base)
    this.carry = buf.slice(keepFrom)
    this.carryBase = base + keepFrom
  }

  /**
   * Готові кадри (CENS). З flush — також кадри в кінці, для яких бракує семплів (доповнюються нулями),
   * як для цілого запису.
   */
  frames(flush = false): Float32Array[] {
    const total = Math.floor(this.decLength / this.hop)
    for (let f = this.raw.length; f < total; f++) {
      const start = Math.round(f * this.hop) - this.frameSize / 2
      if (!flush && start + this.frameSize > this.decLength) break
      this.raw.push(this.rawFrame(start))
    }
    return finishChroma(this.raw)
  }

  /**
   * Атаки по класах висот, по кадрах ONSET_FPS: приріст амплітуд між сусідніми кадрами, зібраний
   * у 12 класів і поділений на середню силу атак в околі ±ONSET_NORM_SECONDS. Пік у класі C ≈
   * у цю мить почала звучати нота C (у будь-якій октаві).
   */
  onsets(): Float32Array[] {
    this.prepare()
    return normalizeOnsets(this.flux, Math.round(ONSET_NORM_SECONDS * ONSET_FPS))
  }

  /** Дорахувати атаки для вже отриманого звуку: викликати потроху під час запису, щоб не чекати в кінці. */
  prepare(): void {
    const total = Math.floor(this.decLength / this.onsetHop)
    for (let f = this.flux.length; f < total; f++) {
      const start = Math.round(f * this.onsetHop) - ONSET_FRAME / 2
      if (start + ONSET_FRAME > this.decLength) break
      this.flux.push(this.fluxAt(start))
    }
  }

  private fluxAt(start: number): Float32Array {
    const re = this.onsetRe
    const im = this.onsetIm
    for (let i = 0; i < ONSET_FRAME; i++) {
      const idx = start + i
      re[i] = idx >= 0 && idx < this.decLength ? this.dec[idx] * this.onsetWindow[i] : 0
      im[i] = 0
    }
    fft(re, im)
    const half = ONSET_FRAME / 2
    const mag = new Float32Array(half)
    const flux = new Float32Array(12)
    for (let k = 1; k < half; k++) {
      mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k])
      const pc = this.onsetBinToPc[k]
      if (pc >= 0 && this.prevMag) flux[pc] += Math.max(0, mag[k] - this.prevMag[k])
    }
    this.prevMag = mag
    return flux
  }

  private append(samples: Float32Array): void {
    if (this.decLength + samples.length > this.dec.length) {
      let size = this.dec.length * 2
      while (size < this.decLength + samples.length) size *= 2
      const grown = new Float32Array(size)
      grown.set(this.dec.subarray(0, this.decLength))
      this.dec = grown
    }
    this.dec.set(samples, this.decLength)
    this.decLength += samples.length
  }

  private rawFrame(start: number): Float32Array {
    const { re, im, frameSize } = this
    for (let i = 0; i < frameSize; i++) {
      const idx = start + i
      re[i] = idx >= 0 && idx < this.decLength ? this.dec[idx] * this.window[i] : 0
      im[i] = 0
    }
    fft(re, im)
    const chroma = new Float32Array(12)
    for (let k = 1; k < frameSize / 2; k++) {
      const pc = this.binToPc[k]
      if (pc < 0) continue
      // Амплітуда, не енергія: інакше гучний бас затуляє все інше.
      chroma[pc] += Math.sqrt(re[k] * re[k] + im[k] * im[k])
    }
    return chroma
  }
}

/** Пороги квантування CENS: частка енергії кадру → рівень 0..4. Дрібне просочування стає нулем. */
const CENS_LEVELS = [0.05, 0.1, 0.2, 0.4]

/**
 * Спільне доведення для хроми зі звуку й з нот (CENS-ознаки Мюллера): нормалізація кадру,
 * грубе квантування на 5 рівнів, згладжування сусідніми кадрами, одинична довжина.
 */
export function finishChroma(raw: readonly Float32Array[]): Float32Array[] {
  const compressed = raw.map((c) => {
    let total = 0
    for (let i = 0; i < 12; i++) total += c[i]
    const out = new Float32Array(12)
    if (total < SILENCE) return out
    for (let i = 0; i < 12; i++) {
      const share = c[i] / total
      let level = 0
      while (level < CENS_LEVELS.length && share >= CENS_LEVELS[level]) level++
      out[i] = level
    }
    return out
  })
  const half = Math.floor(SMOOTH / 2)
  const result: Float32Array[] = []
  for (let f = 0; f < compressed.length; f++) {
    const out = new Float32Array(12)
    const from = Math.max(0, f - half)
    const to = Math.min(compressed.length - 1, f + half)
    for (let g = from; g <= to; g++) for (let i = 0; i < 12; i++) out[i] += compressed[g][i]
    result.push(unit(out))
  }
  return result
}

/**
 * Атаки по класах, поділені на ковзне середнє сумарної сили в околі ±half кадрів (плюс дрібка
 * від загального середнього, щоб тиша лишалась нулем, а не ділилась на нуль).
 */
export function normalizeOnsets(flux: readonly Float32Array[], half: number): Float32Array[] {
  const n = flux.length
  if (!n) return []
  const prefix = new Float64Array(n + 1)
  for (let i = 0; i < n; i++) {
    let sum = 0
    for (let pc = 0; pc < 12; pc++) sum += flux[i][pc]
    prefix[i + 1] = prefix[i] + sum
  }
  const global = prefix[n] / n
  const out: Float32Array[] = []
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - half)
    const b = Math.min(n, i + half + 1)
    const mean = (prefix[b] - prefix[a]) / (b - a)
    const k = global > 0 ? 1 / (mean + global * 0.05) : 0
    const v = new Float32Array(12)
    for (let pc = 0; pc < 12; pc++) v[pc] = flux[i][pc] * k
    out.push(v)
  }
  return out
}

/** Вектор одиничної довжини; нульовий лишається нульовим. */
export function unit(v: Float32Array): Float32Array {
  let norm = 0
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i]
  if (norm < SILENCE) return new Float32Array(v.length)
  const k = 1 / Math.sqrt(norm)
  const out = new Float32Array(v.length)
  for (let i = 0; i < v.length; i++) out[i] = v[i] * k
  return out
}

/** Косинусна відстань 0..1 між одиничними векторами; тиша з чим завгодно — 1. */
export function cosineDistance(a: Float32Array, b: Float32Array): number {
  let dot = 0
  for (let i = 0; i < 12; i++) dot += a[i] * b[i]
  return Math.max(0, Math.min(1, 1 - dot))
}

/** Хрома, зсунута на `semitones` півтонів угору (циклічно). */
export function rotate(v: Float32Array, semitones: number): Float32Array {
  const out = new Float32Array(12)
  const s = ((semitones % 12) + 12) % 12
  for (let i = 0; i < 12; i++) out[(i + s) % 12] = v[i]
  return out
}

/** Індекс першого не-тихого кадру (або length, якщо всі тихі). */
export function firstSound(frames: readonly Float32Array[]): number {
  for (let i = 0; i < frames.length; i++) if (!isSilent(frames[i])) return i
  return frames.length
}

/** Індекс останнього не-тихого кадру (або −1, якщо всі тихі). */
export function lastSound(frames: readonly Float32Array[]): number {
  for (let i = frames.length - 1; i >= 0; i--) if (!isSilent(frames[i])) return i
  return -1
}

function isSilent(v: Float32Array): boolean {
  for (let k = 0; k < 12; k++) if (v[k] > 0) return false
  return true
}

/** Низькочастотний FIR (віконний sinc) для прорідження у `factor` разів, щоб високі частоти не «загорталися» вниз. */
function lowpass(factor: number): Float32Array {
  const taps = 8 * factor + 1
  const half = (taps - 1) / 2
  const cutoff = 0.45 / factor
  const h = new Float32Array(taps)
  let sum = 0
  for (let i = 0; i < taps; i++) {
    const x = i - half
    const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x)
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (taps - 1))
    h[i] = sinc * w
    sum += h[i]
  }
  for (let i = 0; i < taps; i++) h[i] /= sum
  return h
}

function hann(n: number): Float32Array {
  const w = new Float32Array(n)
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1))
  return w
}

/** Для кожного біна FFT — клас висоти (0..11) або −1, якщо бін поза діапазоном. */
function binClasses(frameSize: number, sampleRate: number, fMin = F_MIN): Int8Array {
  const out = new Int8Array(frameSize / 2)
  for (let k = 0; k < frameSize / 2; k++) {
    const f = (k * sampleRate) / frameSize
    if (f < fMin || f > F_MAX) {
      out[k] = -1
      continue
    }
    const midi = 69 + 12 * Math.log2(f / 440)
    out[k] = ((Math.round(midi) % 12) + 12) % 12
  }
  return out
}

/** FFT на місці (radix-2, довжина — степінь двійки). */
export function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length
  if (n & (n - 1)) throw new Error('fft: довжина має бути степенем двійки')
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      let t = re[i]
      re[i] = re[j]
      re[j] = t
      t = im[i]
      im[i] = im[j]
      im[j] = t
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let j = 0; j < len / 2; j++) {
        const a = i + j
        const b = a + len / 2
        const tr = re[b] * cr - im[b] * ci
        const ti = re[b] * ci + im[b] * cr
        re[b] = re[a] - tr
        im[b] = im[a] - ti
        re[a] += tr
        im[a] += ti
        const ncr = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = ncr
      }
    }
  }
}
