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

export interface ChromaOptions {
  frameSize?: number
  fps?: number
}

/**
 * Хрома запису: samples — моно, sampleRate — Гц. Повертає список 12-вимірних векторів,
 * по одному на кожні 1/fps с. Вектори нормалізовані (довжина 1) або нульові для тиші.
 */
export function audioChroma(input: Float32Array, inputRate: number, options: ChromaOptions = {}): Float32Array[] {
  const fps = options.fps ?? CHROMA_FPS
  const frameSize = options.frameSize ?? 8192
  // Понижуємо частоту до ~11 кГц: бас тоді розділяється по півтонах (бін FFT ≈ 1.4 Гц), а рахунок дешевший.
  const factor = Math.max(1, Math.floor(inputRate / TARGET_RATE))
  const samples = factor > 1 ? decimate(input, factor) : input
  const sampleRate = inputRate / factor
  const hop = sampleRate / fps
  const window = hann(frameSize)
  const binToPc = binClasses(frameSize, sampleRate)
  const re = new Float32Array(frameSize)
  const im = new Float32Array(frameSize)
  const raw: Float32Array[] = []
  const count = Math.max(0, Math.floor(samples.length / hop))
  for (let f = 0; f < count; f++) {
    // Вікно центроване на моменті кадру, щоб час хроми не зсувався на половину вікна.
    const start = Math.round(f * hop) - frameSize / 2
    for (let i = 0; i < frameSize; i++) {
      const idx = start + i
      const s = idx >= 0 && idx < samples.length ? samples[idx] : 0
      re[i] = s * window[i]
      im[i] = 0
    }
    fft(re, im)
    const chroma = new Float32Array(12)
    for (let k = 1; k < frameSize / 2; k++) {
      const pc = binToPc[k]
      if (pc < 0) continue
      // Амплітуда, не енергія: інакше гучний бас затуляє все інше.
      chroma[pc] += Math.sqrt(re[k] * re[k] + im[k] * im[k])
    }
    raw.push(chroma)
  }
  return finishChroma(raw)
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

/**
 * Проріджує сигнал у `factor` разів після низькочастотного FIR-фільтра (віконний sinc),
 * щоб високі частоти не «загорталися» вниз.
 */
export function decimate(samples: Float32Array, factor: number): Float32Array {
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
  const out = new Float32Array(Math.floor(samples.length / factor))
  for (let o = 0; o < out.length; o++) {
    const center = o * factor
    let acc = 0
    for (let i = 0; i < taps; i++) {
      const idx = center + i - half
      if (idx >= 0 && idx < samples.length) acc += samples[idx] * h[i]
    }
    out[o] = acc
  }
  return out
}

function hann(n: number): Float32Array {
  const w = new Float32Array(n)
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1))
  return w
}

/** Для кожного біна FFT — клас висоти (0..11) або −1, якщо бін поза діапазоном. */
function binClasses(frameSize: number, sampleRate: number): Int8Array {
  const out = new Int8Array(frameSize / 2)
  for (let k = 0; k < frameSize / 2; k++) {
    const f = (k * sampleRate) / frameSize
    if (f < F_MIN || f > F_MAX) {
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
