// Оркестратор автосинхронізації: програє відео з початку, записує звук вкладки, будує хрому
// запису й табу та через subsequence DTW знаходить, у якій секунді відео звучить такт 1.
// Далі слухає далі й вікнами веде таб уздовж запису: з цього виходять мітки темпу по тактах,
// бо темп запису майже ніколи не збігається з табом (а в gp3 темп узагалі один на весь файл).
// Про alphaTab і UI не знає: ноти й такти приходять готовими списками, плеєр — через YtPlayerLike.

import { CHROMA_FPS, ChromaStream, ONSET_FPS, firstSound, lastSound } from './chroma'
import { bestShiftedMatch, subsequenceDtw, type ShiftedMatch } from './dtw'
import { chromaFromNotes, onsetsFromNotes, type BarTime, type NoteEvent, type Onset } from './score'
import { YtState, type YtPlayerLike } from '../youtube/handler'
import type { FlatSyncPoint } from '../youtube/sync'

/** Скільки секунд табу (від першої ноти) беремо за еталон для пошуку початку. */
export const REF_SECONDS = 30
/** Скільки секунд запису понад еталон слухаємо, шукаючи початок: стільки може тривати інтро, якого немає в табі. */
export const SEARCH_SECONDS = 45
/** Еталон коротший за це — нема з чим зіставляти. */
const MIN_REF_SECONDS = 6
/** Перша спроба знайти початок — після стількох секунд запису, далі — кожні STEP секунд. */
const FIRST_TRY_SECONDS = 20
const STEP_SECONDS = 5
/** Крок відстеження темпу після знайденого початку. */
const TRACK_STEP_SECONDS = 2
/** Вікно еталона під час відстеження і скільки секунд із його кінця не підтверджуємо (перевіряться наступним вікном). */
const TRACK_WINDOW_SECONDS = 20
const TRACK_TAIL_SECONDS = 4
/** Якщо вікно еталона не вклалося в запис у стільки разів довший, відстеження збилося. */
const TRACK_STALL_RATIO = 2.5
/** Посередній збіг вікна приймаємо лише коли запису вже стільки, що повільніший темп неможливий. */
const TRACK_PATIENCE_RATIO = 1.6
/** Мітка темпу через стільки тактів: частіше — шум DTW перетворюється на тремтіння темпу. */
const POINT_EVERY_BARS = 2
/** Збіг із такою вартістю на кадр приймаємо без подальшого прослуховування. */
const GOOD_COST = 0.2
/** Гірше за це — не віримо. */
const FAIR_COST = 0.35
/** Кінець еталона має лежати принаймні за стільки секунд до кінця запису, щоб не «впертися» в край. */
const END_MARGIN_SECONDS = 2
/** Уточнення мітки за атаками: шукаємо зсув від оцінки DTW у межах ±стільки мс. */
const ONSET_SEARCH_MS = 400
/** Штраф за кадр атак віддалення від оцінки DTW, частка від найкращого збігу: сусідня доля не має перетягти. */
const ONSET_DRIFT_PENALTY = 0.004
/** Уточнення приймаємо, лише якщо пік у стільки разів вищий за середнє по всьому діапазону зсувів. */
const ONSET_MIN_PEAK = 1.5
/** Атаки згладжуємо на ±стільки кадрів (трикутником): збіг терпить дрібні розбіжності. */
const ONSET_SMOOTH = 2
/** Нахил DTW міряємо на відрізку не коротшому за стільки мс, інакше він шумить. */
const ONSET_SLOPE_MIN_MS = 1000
/** Нахил DTW беремо, починаючи за стільки мс до початку відрізка. */
const ONSET_SLOPE_BACK_MS = 2000
/** Поправки темпу відрізка відносно нахилу DTW, які перебираємо при уточненні. */
const ONSET_RATIOS = [0.85, 0.9, 0.95, 1, 1.05, 1.1, 1.15, 1.2]

export type Confidence = 'good' | 'fair' | 'poor'

export interface AutoSyncProgress {
  phase: 'starting' | 'listening' | 'tracking' | 'analyzing'
  seconds: number
  /** Скільки тактів уже має мітки (фаза tracking). */
  bars: number
}

export interface AutoSyncResult {
  /** Час у відео, де звучить такт 1 (мс). */
  offsetMs: number
  /** Мітки темпу по тактах у часі відео (включно з тактом 0), готові для alphaTab. */
  points: FlatSyncPoint[]
  /** Скільки тактів табу простежено в записі. */
  trackedBars: number
  confidence: Confidence
  /** На скільки півтонів запис вище за таб (0..11; 11 означає «на півтон нижче»). */
  shift: number
  cost: number
}

export class NoNotesError extends Error {
  constructor() {
    super('not enough notes')
    this.name = 'NoNotesError'
  }
}

export class CancelledError extends Error {
  constructor() {
    super('cancelled')
    this.name = 'CancelledError'
  }
}

/** Те, що оркестратору треба від рекордера; окремий інтерфейс, щоб тестувати без Web Audio. */
export interface RecorderLike {
  readonly sampleRate: number
  readonly seconds: number
  readonly ended: boolean
  /** Затримка захоплення: на стільки секунд пізніше звук потрапляє в запис, ніж лунає (0, якщо не міряно). */
  readonly latencySeconds?: number
  start(): void
  stop(): void
  /** Шматки звуку, що надійшли після попереднього виклику. */
  drain(): Float32Array[]
}

export interface AutoSyncOptions {
  player: YtPlayerLike
  notes: readonly NoteEvent[]
  /** Такти табу в порядку відтворення. */
  bars: readonly BarTime[]
  recorder: RecorderLike
  onProgress?: (p: AutoSyncProgress) => void
  /** Зупинити: після знайденого початку — завершити з тим, що є; до нього — скасувати. */
  signal?: AbortSignal
  /** Для тестів: замість setTimeout. */
  sleep?: (ms: number) => Promise<void>
  /** Діагностика кроків (console.debug у застосунку). */
  debug?: (message: string) => void
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export async function autoSyncOffset(options: AutoSyncOptions): Promise<AutoSyncResult> {
  const { player, recorder, signal } = options
  const sleep = options.sleep ?? defaultSleep
  const progress = options.onProgress ?? (() => {})
  const debug = options.debug ?? (() => {})
  const fps = CHROMA_FPS

  // Хрома всього табу; еталон для пошуку початку — перші REF_SECONDS від першої ноти.
  const tabEndMs = options.bars.length ? options.bars[options.bars.length - 1].startMs + 60_000 : REF_SECONDS * 1000
  const full = chromaFromNotes(options.notes, tabEndMs / 1000)
  const lead = firstSound(full)
  // Кінець еталона — секунда після останньої атаки: далі лише загасання, де шлях DTW довільний.
  const lastOnsetMs = options.notes.reduce((m, n) => Math.max(m, n.onsetMs), 0)
  const last = Math.min(lastSound(full) + 1, Math.ceil((lastOnsetMs / 1000) * fps) + fps)
  const ref = full.slice(lead, Math.min(lead + REF_SECONDS * fps, last))
  if (ref.length < MIN_REF_SECONDS * fps) throw new NoNotesError()

  progress({ phase: 'starting', seconds: 0, bars: 0 })
  player.seekTo(0, true)
  player.playVideo()
  for (let waited = 0; player.getPlayerState() !== YtState.PLAYING; waited += 50) {
    if (waited > 10_000) throw new Error('video did not start')
    if (signal?.aborted || recorder.ended) throw new CancelledError()
    await sleep(50)
  }

  const stream = new ChromaStream(recorder.sampleRate)
  /** Пари «секунд записано ↔ час відео» для переведення кадрів запису в час відео. */
  const pairs: number[] = []
  const pull = () => {
    for (const chunk of recorder.drain()) stream.push(chunk)
    stream.prepare()
    const sec = recorder.seconds
    if (sec > 0.5) pairs.push(player.getCurrentTime() - sec)
    return sec
  }
  const stopped = () => signal?.aborted || recorder.ended || player.getPlayerState() !== YtState.PLAYING

  recorder.start()
  let match: ShiftedMatch | null = null
  /** Для кадру еталона k — кадр запису (дробовий), де він звучить; NaN — не простежено. */
  const refToTarget = new Float64Array(full.length).fill(Number.NaN)
  let confirmedTo = lead // кадри еталона до цього (не включно) простежено
  let lost = false

  try {
    // --- Фаза 1: знайти початок ---
    let nextTry = FIRST_TRY_SECONDS
    let sec = 0
    while (!match) {
      await sleep(100)
      sec = pull()
      progress({ phase: 'listening', seconds: sec, bars: 0 })
      const limit = ref.length / fps + SEARCH_SECONDS
      if (stopped() || sec >= limit) {
        if (sec < MIN_REF_SECONDS + STEP_SECONDS) throw new CancelledError()
        match = bestShiftedMatch(ref, stream.frames(true))
        if (!match) throw new NoNotesError()
        break
      }
      if (sec >= nextTry) {
        nextTry += STEP_SECONDS
        const m = bestShiftedMatch(ref, stream.frames())
        if (m && m.cost <= GOOD_COST && m.end / fps <= sec - END_MARGIN_SECONDS) match = m
      }
    }
    debug(`start: frame ${match.start} cost ${match.cost.toFixed(3)} shift ${match.shift} after ${sec.toFixed(1)}s`)
    const found: ShiftedMatch = match
    for (let i = 0; i < found.path.length; i++) refToTarget[lead + i] = found.path[i]
    confirmedTo = Math.max(lead + 1, lead + found.path.length - TRACK_TAIL_SECONDS * fps)
    if (lead + ref.length >= last) confirmedTo = last

    // --- Фаза 2: вести таб далі вікнами, поки є ноти, запис і згода ---
    if (found.cost > FAIR_COST) lost = true
    let nextTrack = sec + TRACK_STEP_SECONDS
    while (!lost && confirmedTo < last && !stopped()) {
      await sleep(100)
      sec = pull()
      progress({ phase: 'tracking', seconds: sec, bars: trackedBars(options.bars, confirmedTo, fps) })
      if (sec < nextTrack) continue
      nextTrack = sec + TRACK_STEP_SECONDS

      const refFrom = confirmedTo - 1
      const refTo = Math.min(refFrom + TRACK_WINDOW_SECONDS * fps, last)
      const final = refTo >= last
      const targetFrom = Math.round(refToTarget[refFrom])
      const frames = stream.frames()
      if (frames.length - targetFrom < (refTo - refFrom) * 0.5) continue
      const m = subsequenceDtw(
        full.slice(refFrom, refTo).map((v) => (found.shift ? rotateRef(v, found.shift) : v)),
        frames.slice(targetFrom),
        { anchored: true },
      )
      if (!m) continue
      const reachedEnd = m.end / fps <= (frames.length - targetFrom) / fps - END_MARGIN_SECONDS
      debug(
        `track: ref ${refFrom}-${refTo} target from ${targetFrom} of ${frames.length}, end ${targetFrom + m.end} cost ${m.cost.toFixed(3)} reached ${reachedEnd}`,
      )
      const available = (frames.length - targetFrom) / fps
      const windowSeconds = (refTo - refFrom) / fps
      if (available > windowSeconds * TRACK_STALL_RATIO) {
        lost = true
        continue
      }
      // Посередній збіг із кінцем біля краю запису — найчастіше еталон «стиснуто» в ще не дограну музику: чекаємо.
      const acceptable = m.cost <= GOOD_COST || (m.cost <= FAIR_COST && available >= windowSeconds * TRACK_PATIENCE_RATIO)
      if (!reachedEnd || !acceptable) continue
      const keep = final ? m.path.length : Math.max(1, m.path.length - TRACK_TAIL_SECONDS * fps)
      for (let i = 1; i < keep; i++) refToTarget[refFrom + i] = targetFrom + m.path[i]
      confirmedTo = refFrom + keep
    }
  } finally {
    recorder.stop()
    player.pauseVideo()
  }

  progress({ phase: 'analyzing', seconds: recorder.seconds, bars: trackedBars(options.bars, confirmedTo, fps) })
  const delta = median(pairs) - (recorder.latencySeconds ?? 0)
  const points = buildPoints(options.bars, refToTarget, lead, confirmedTo, fps, delta, smoothOnsets(stream.onsets()), onsetsFromNotes(options.notes), debug)
  const confidence: Confidence = match.cost <= GOOD_COST ? 'good' : match.cost <= FAIR_COST ? 'fair' : 'poor'
  return {
    offsetMs: points[0]?.millisecondOffset ?? 0,
    points,
    trackedBars: trackedBars(options.bars, confirmedTo, fps),
    confidence,
    shift: match.shift,
    cost: match.cost,
  }
}

function rotateRef(v: Float32Array, shift: number): Float32Array {
  const out = new Float32Array(12)
  for (let i = 0; i < 12; i++) out[(i + shift) % 12] = v[i]
  return out
}

/** Скільки тактів починаються в простеженій частині еталона. */
function trackedBars(bars: readonly BarTime[], confirmedTo: number, fps: number): number {
  let n = 0
  for (const b of bars) if ((b.startMs / 1000) * fps < confirmedTo) n++
  return n
}

/**
 * Мітки alphaTab із простеженого шляху: такт 0 завжди (екстрапольовано назад, якщо таб починається
 * з пауз), далі кожні POINT_EVERY_BARS тактів і останній простежений. Час у відео має зростати.
 * Час кожної мітки уточнюється за атаками: DTW по згладженій хромі точний до 1–3 кадрів (100–300 мс),
 * а атаки нот у записі — до 10 мс, тож шукаємо зсув, за якого ноти відрізка лягають на піки атак.
 */
function buildPoints(
  bars: readonly BarTime[],
  refToTarget: Float64Array,
  lead: number,
  confirmedTo: number,
  fps: number,
  delta: number,
  onsets: readonly Float32Array[],
  noteOnsets: readonly Onset[],
  debug: (message: string) => void,
): FlatSyncPoint[] {
  const videoMs = (targetFrame: number) => (targetFrame / fps + delta) * 1000
  /** Кадр запису (дробовий) для миті табу в мс; NaN поза простеженим. */
  const targetAt = (ms: number) => {
    const f = (ms / 1000) * fps
    const i = Math.floor(f)
    if (i < 0 || i >= refToTarget.length) return Number.NaN
    const a = refToTarget[i]
    const z = refToTarget[Math.min(i + 1, refToTarget.length - 1)]
    if (!Number.isFinite(a)) return Number.NaN
    return Number.isFinite(z) ? a + (z - a) * (f - i) : a
  }
  const inside = bars.filter((b) => {
    const f = (b.startMs / 1000) * fps
    return f >= lead && f < confirmedTo
  })
  const chosen = inside.filter((_, i) => i % POINT_EVERY_BARS === 0 || i === inside.length - 1)
  const points: FlatSyncPoint[] = []
  const first = bars[0]
  if (first && !chosen.some((b) => b.barIndex === first.barIndex && b.barOccurence === first.barOccurence)) {
    // Такт 0 починається з пауз: від першої ноти відняти її відступ у табі, у темпі запису на початку.
    const span = Math.min(2 * fps, confirmedTo - lead - 1)
    const ratio = span > 0 && Number.isFinite(refToTarget[lead + span]) ? (refToTarget[lead + span] - refToTarget[lead]) / span : 1
    const ms = Math.max(0, Math.round(videoMs(refToTarget[lead]) - (lead / fps) * 1000 * ratio))
    points.push({ barIndex: first.barIndex, barPosition: 0, barOccurence: first.barOccurence, millisecondOffset: ms })
  }
  let shifts = 0
  for (let k = 0; k < chosen.length; k++) {
    const b = chosen[k]
    const coarse = targetAt(b.startMs)
    if (!Number.isFinite(coarse)) continue
    const trackedEnd = ((confirmedTo - 1) / fps) * 1000
    const segmentEnd = Math.min(trackedEnd, k + 1 < chosen.length ? chosen[k + 1].startMs : Number.POSITIVE_INFINITY)
    const shift = onsetShift(onsets, noteOnsets, b.startMs, segmentEnd, targetAt, fps)
    if (shift) shifts++
    debug(`point: bar ${b.barIndex} dtw ${Math.round(videoMs(coarse))} ms, onset shift ${(shift * 1000) / ONSET_FPS} ms`)
    const ms = Math.round(videoMs(coarse) + (shift * 1000) / ONSET_FPS)
    const prev = points[points.length - 1]
    if (prev && ms <= prev.millisecondOffset) continue
    points.push({ barIndex: b.barIndex, barPosition: 0, barOccurence: b.barOccurence, millisecondOffset: ms })
  }
  debug(`points: ${points.length}, refined by onsets: ${shifts}`)
  return points
}

/**
 * Зсув (у кадрах атак) від оцінки DTW, за якого атаки нот відрізка [fromMs, toMs) табу найкраще
 * лягають на піки сили атак запису. 0 — піка нема або DTW уже точний.
 */
function onsetShift(
  onsets: readonly Float32Array[],
  noteOnsets: readonly Onset[],
  fromMs: number,
  toMs: number,
  targetAt: (ms: number) => number,
  fps: number,
): number {
  const origin = targetAt(fromMs)
  if (!Number.isFinite(origin)) return 0
  const inside = noteOnsets.filter((o) => o.ms >= fromMs && o.ms < toMs)
  if (inside.length < 2) return 0
  /** Кадрів запису на мс табу за DTW: від попередніх 2 с до останньої атаки відрізка, бо на короткому
   * відрізку й на хвості без нот шлях DTW шумить. */
  const slope = dtwSlope(targetAt, fromMs - ONSET_SLOPE_BACK_MS, inside[inside.length - 1].ms, fromMs) ?? fps / 1000
  const range = Math.round((ONSET_SEARCH_MS / 1000) * ONSET_FPS)
  const scale = ONSET_FPS / fps
  let peak = 0
  let total = 0
  let count = 0
  let best = 0
  let bestValue = Number.NEGATIVE_INFINITY
  // Нахил DTW усередині відрізка теж приблизний, тож перебираємо і невелику поправку темпу.
  for (const r of ONSET_RATIOS) {
    const expected = inside.map((o) => ({ frame: (origin + (o.ms - fromMs) * slope * r) * scale, classes: o.classes }))
    for (let shift = -range; shift <= range; shift++) {
      let sum = 0
      for (const e of expected) {
        const i = Math.round(e.frame + shift)
        if (i < 0 || i >= onsets.length) continue
        for (const pc of e.classes) sum += onsets[i][pc]
      }
      total += sum
      count++
      if (sum > peak) peak = sum
      const v = sum - ONSET_DRIFT_PENALTY * Math.abs(shift) * sum
      if (v > bestValue) {
        bestValue = v
        best = shift
      }
    }
  }
  return peak > (total / count) * ONSET_MIN_PEAK ? best : 0
}

/** Нахил шляху DTW (кадрів запису на мс табу) на [a, b]; коли відрізок закороткий — на ±1 с довкола `around`. */
function dtwSlope(targetAt: (ms: number) => number, a: number, b: number, around: number): number | null {
  const over = (x: number, y: number) => {
    const fx = targetAt(x)
    const fy = targetAt(y)
    return Number.isFinite(fx) && Number.isFinite(fy) && y - x >= ONSET_SLOPE_MIN_MS ? (fy - fx) / (y - x) : null
  }
  return over(a, b) ?? over(around, b) ?? over(around - 1000, around + 1000) ?? over(around - 2000, around) ?? null
}

/** Атаки, згладжені трикутником ±ONSET_SMOOTH кадрів. */
function smoothOnsets(onsets: readonly Float32Array[]): Float32Array[] {
  const out: Float32Array[] = []
  for (let i = 0; i < onsets.length; i++) {
    const v = new Float32Array(12)
    for (let d = -ONSET_SMOOTH; d <= ONSET_SMOOTH; d++) {
      const j = i + d
      if (j < 0 || j >= onsets.length) continue
      const w = ONSET_SMOOTH + 1 - Math.abs(d)
      for (let pc = 0; pc < 12; pc++) v[pc] += onsets[j][pc] * w
    }
    out.push(v)
  }
  return out
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}
