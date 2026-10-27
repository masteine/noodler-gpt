// Визначення основної частоти (McLeod Pitch Method) і перетворення частота ↔ нота.
// Без залежностей від DOM, тому працює і в браузері, і в Node (див. scripts/test-pitch.mjs).

export const FREQ_MIN = 25
export const FREQ_MAX = 1200

export interface PitchResult {
  frequency: number
  /** Висота піку NSDF, 0…1: наскільки сигнал періодичний (1 — ідеальний тон). */
  clarity: number
}

export interface PitchOptions {
  minFreq?: number
  maxFreq?: number
  /** Нижче цього RMS сигнал вважаємо тишею. */
  minRms?: number
  /** Нижче цієї чіткості результат відкидаємо як шум. */
  minClarity?: number
  /** Поріг вибору піку відносно найвищого (k у статті McLeod). */
  peakRatio?: number
}

// Грубий пошук іде на зменшеній частоті дискретизації (дешево), точне уточнення — на повній.
const COARSE_RATE = 12000

let scratchDec = new Float64Array(0)
let scratchTmp = new Float64Array(0)
let scratchNsdf = new Float64Array(0)
let scratchRaw = new Float64Array(0)

function ensure(n: number) {
  if (scratchRaw.length < n) {
    scratchRaw = new Float64Array(n)
    scratchTmp = new Float64Array(n)
    scratchDec = new Float64Array(n)
    scratchNsdf = new Float64Array(n)
  }
}

/** Параболічна інтерполяція вершини по трьох точках: повертає зсув -0.5…0.5 і висоту піку. */
function parabola(a: number, b: number, c: number): { shift: number; height: number } {
  const denom = a - 2 * b + c
  if (denom === 0) return { shift: 0, height: b }
  const shift = (0.5 * (a - c)) / denom
  return { shift, height: b - 0.25 * (a - c) * shift }
}

/**
 * Основна частота сигналу або null, якщо це тиша/шум.
 * `buf` — останні N відліків із мікрофона (рекомендовано 8192 при 44.1/48 кГц).
 */
export function detectPitch(
  buf: Float32Array,
  sampleRate: number,
  opts: PitchOptions = {},
): PitchResult | null {
  const minFreq = opts.minFreq ?? FREQ_MIN
  const maxFreq = opts.maxFreq ?? FREQ_MAX
  const minRms = opts.minRms ?? 0.004
  const minClarity = opts.minClarity ?? 0.8
  const peakRatio = opts.peakRatio ?? 0.9

  const n = buf.length
  const maxLagFull = Math.min(Math.floor(sampleRate / minFreq), Math.floor(n / 2))
  if (n < 64 || maxLagFull < 4) return null

  ensure(n)
  const raw = scratchRaw

  // Прибираємо постійну складову і міряємо рівень.
  let mean = 0
  for (let i = 0; i < n; i++) mean += buf[i]
  mean /= n
  let energy = 0
  for (let i = 0; i < n; i++) {
    const v = buf[i] - mean
    raw[i] = v
    energy += v * v
  }
  if (Math.sqrt(energy / n) < minRms) return null

  // --- Грубий етап: згладжуємо (двічі ковзне середнє) і проріджуємо до ~8 кГц ---
  const D = Math.max(1, Math.floor(sampleRate / COARSE_RATE))
  let y: Float64Array
  let m: number
  if (D === 1) {
    y = raw
    m = n
  } else {
    const tmp = scratchTmp
    // Ковзне середнє довжини D, двічі = трикутне вікно (краще давить аліасинг).
    let acc = 0
    for (let i = 0; i < n; i++) {
      acc += raw[i]
      if (i >= D) acc -= raw[i - D]
      tmp[i] = acc / D
    }
    m = Math.floor(n / D)
    y = scratchDec
    // Друге середнє застосовуємо лише в точках проріджування.
    for (let k = 0; k < m; k++) {
      const end = k * D + D - 1
      let s = 0
      for (let j = 0; j < D; j++) s += tmp[end - j]
      y[k] = s / D
    }
  }

  const rateC = sampleRate / D
  const maxLag = Math.min(Math.floor(rateC / minFreq), Math.floor(m / 2))
  const minLag = Math.max(2, Math.floor(rateC / maxFreq) - 1)
  if (maxLag <= minLag + 2) return null

  // NSDF: 2·r(τ) / m(τ), m(τ) оновлюємо рекурентно.
  const nsdf = scratchNsdf
  let mTau = 0
  for (let j = 0; j < m; j++) mTau += 2 * y[j] * y[j]
  for (let tau = 0; tau <= maxLag + 1; tau++) {
    let r = 0
    const lim = m - tau
    for (let j = 0; j < lim; j++) r += y[j] * y[j + tau]
    nsdf[tau] = mTau > 0 ? (2 * r) / mTau : 0
    mTau -= y[m - tau - 1] * y[m - tau - 1] + y[tau] * y[tau]
  }

  // Кандидати: усі додатні локальні максимуми NSDF. (Класичний MPM бере максимум кожної ділянки
  // між перетинами нуля, але на спектрі з сильною другою гармонікою NSDF може не опускатися
  // нижче нуля, і тоді перший пік губиться й виходить октава вниз.)
  const peaks: number[] = []
  for (let tau = Math.max(minLag, 1); tau <= maxLag; tau++) {
    if (nsdf[tau] > 0 && nsdf[tau] > nsdf[tau - 1] && nsdf[tau] >= nsdf[tau + 1]) peaks.push(tau)
  }
  if (peaks.length === 0) return null

  // Висоту піку беремо після інтерполяції: при малій кількості відліків на період (високі ноти)
  // найближчий цілий лаг може сидіти на схилі й давати занижену висоту.
  const heights = peaks.map((p) => parabola(nsdf[p - 1], nsdf[p], nsdf[p + 1]).height)
  let top = 0
  for (const h of heights) if (h > top) top = h
  const threshold = top * peakRatio
  let pick = 0
  for (let i = 0; i < peaks.length; i++) {
    if (heights[i] >= threshold) {
      pick = i
      break
    }
  }
  const coarse = peaks[pick]
  const c = parabola(nsdf[coarse - 1], nsdf[coarse], nsdf[coarse + 1])
  let clarity = c.height
  const lagFull0 = (coarse + c.shift) * D

  // --- Точний етап: NSDF на повній частоті біля знайденого лагу ---
  let lag = lagFull0
  if (D > 1) {
    const lo = Math.max(2, Math.floor(lagFull0) - D - 1)
    const hi = Math.min(maxLagFull + D, Math.ceil(lagFull0) + D + 1, Math.floor(n / 2))
    if (hi - lo >= 3) {
      // m(τ) = Σ_{j<n-τ} x² + Σ_{j≥τ} x²; стартові суми для τ = lo.
      let total = 0
      for (let j = 0; j < n; j++) total += raw[j] * raw[j]
      let head = total
      let tail = total
      for (let j = 0; j < lo; j++) {
        head -= raw[n - 1 - j] * raw[n - 1 - j]
        tail -= raw[j] * raw[j]
      }
      const vals: number[] = []
      for (let tau = lo; tau <= hi; tau++) {
        let r = 0
        const lim = n - tau
        for (let j = 0; j < lim; j++) r += raw[j] * raw[j + tau]
        const mm = head + tail
        vals.push(mm > 0 ? (2 * r) / mm : 0)
        head -= raw[n - 1 - tau] * raw[n - 1 - tau]
        tail -= raw[tau] * raw[tau]
      }
      let bi = 0
      for (let i = 1; i < vals.length; i++) if (vals[i] > vals[bi]) bi = i
      if (bi > 0 && bi < vals.length - 1) {
        const p = parabola(vals[bi - 1], vals[bi], vals[bi + 1])
        lag = lo + bi + p.shift
        clarity = Math.max(clarity, p.height)
      }
    }
  }

  if (clarity < minClarity) return null
  const frequency = sampleRate / lag
  if (!(frequency >= minFreq * 0.97 && frequency <= maxFreq * 1.03)) return null
  return { frequency, clarity: Math.min(1, clarity) }
}

// --- Ноти ---

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

export interface NoteInfo {
  name: string
  octave: number
  midi: number
  /** Відхилення від найближчої ноти, −50…+50 (плюс — частота вища). */
  cents: number
  targetFreq: number
}

export function noteToFrequency(midi: number, a4 = 440): number {
  return a4 * Math.pow(2, (midi - 69) / 12)
}

/** Назва ноти й октава за MIDI-номером (60 → C4). */
export function midiToParts(midi: number): { name: string; octave: number } {
  return { name: NOTE_NAMES[((midi % 12) + 12) % 12], octave: Math.floor(midi / 12) - 1 }
}

export function midiToName(midi: number): string {
  const { name, octave } = midiToParts(midi)
  return `${name}${octave}`
}

export function frequencyToNote(freq: number, a4 = 440): NoteInfo {
  const exact = 69 + 12 * Math.log2(freq / a4)
  const midi = Math.round(exact)
  return {
    name: NOTE_NAMES[((midi % 12) + 12) % 12],
    octave: Math.floor(midi / 12) - 1,
    midi,
    cents: (exact - midi) * 100,
    targetFreq: noteToFrequency(midi, a4),
  }
}
