// Оркестратор автосинхронізації: програє відео з початку, записує звук вкладки, будує хрому
// запису й табу та через subsequence DTW знаходить, у якій секунді відео звучить такт 1.
// Далі слухає далі й вікнами веде таб уздовж запису: з цього виходять мітки темпу по тактах,
// бо темп запису майже ніколи не збігається з табом (а в gp3 темп узагалі один на весь файл).
// Про alphaTab і UI не знає: ноти й такти приходять готовими списками, плеєр — через YtPlayerLike.

import { CHROMA_FPS, ChromaStream, firstSound, lastSound } from './chroma'
import { bestShiftedMatch, subsequenceDtw, type ShiftedMatch } from './dtw'
import { chromaFromNotes, type BarTime, type NoteEvent } from './score'
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
  const last = lastSound(full) + 1
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
  const delta = median(pairs)
  const points = buildPoints(options.bars, refToTarget, lead, confirmedTo, fps, delta)
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
 */
function buildPoints(
  bars: readonly BarTime[],
  refToTarget: Float64Array,
  lead: number,
  confirmedTo: number,
  fps: number,
  delta: number,
): FlatSyncPoint[] {
  const videoMs = (targetFrame: number) => (targetFrame / fps + delta) * 1000
  const inside = bars.filter((b) => {
    const f = (b.startMs / 1000) * fps
    return f >= lead && f < confirmedTo
  })
  const chosen = inside.filter((_, i) => i % POINT_EVERY_BARS === 0 || i === inside.length - 1)
  const points: FlatSyncPoint[] = []
  const first = bars[0]
  if (first) {
    // Такт 0: від моменту першої ноти відняти її відступ у табі.
    const ms = Math.max(0, Math.round(videoMs(refToTarget[lead]) - (lead / fps) * 1000))
    points.push({ barIndex: first.barIndex, barPosition: 0, barOccurence: first.barOccurence, millisecondOffset: ms })
  }
  for (const b of chosen) {
    if (points.some((p) => p.barIndex === b.barIndex && p.barOccurence === b.barOccurence)) continue
    const f = (b.startMs / 1000) * fps
    const i = Math.floor(f)
    const a = refToTarget[i]
    const z = refToTarget[Math.min(i + 1, refToTarget.length - 1)]
    if (!Number.isFinite(a)) continue
    const frac = Number.isFinite(z) ? a + (z - a) * (f - i) : a
    const ms = Math.round(videoMs(frac))
    const prev = points[points.length - 1]
    if (prev && ms <= prev.millisecondOffset) continue
    points.push({ barIndex: b.barIndex, barPosition: 0, barOccurence: b.barOccurence, millisecondOffset: ms })
  }
  return points
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}
