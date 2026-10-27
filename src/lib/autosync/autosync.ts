// Оркестратор автосинхронізації: програє відео з початку, записує звук вкладки, будує хрому
// запису й табу та через subsequence DTW знаходить, у якій секунді відео звучить такт 1.
// Про alphaTab і UI не знає: ноти приходять готовим списком, плеєр — через YtPlayerLike.

import { audioChroma, CHROMA_FPS, firstSound, lastSound } from './chroma'
import { bestShiftedMatch, type ShiftedMatch } from './dtw'
import { chromaFromNotes, type NoteEvent } from './score'
import type { Recording } from './capture'
import { YtState, type YtPlayerLike } from '../youtube/handler'

/** Скільки секунд табу (від першої ноти) беремо за еталон. */
export const REF_SECONDS = 30
/** Скільки секунд запису понад еталон слухаємо: стільки може тривати інтро, якого немає в табі. */
export const SEARCH_SECONDS = 45
/** Еталон коротший за це — нема з чим зіставляти. */
const MIN_REF_SECONDS = 6
/** Перша спроба зіставити — після стількох секунд запису, далі — кожні STEP секунд. */
const FIRST_TRY_SECONDS = 20
const STEP_SECONDS = 5
/** Збіг із такою вартістю на кадр приймаємо без подальшого прослуховування. */
const GOOD_COST = 0.2
/** Гірше за це — не віримо. */
const FAIR_COST = 0.35
/** Кінець еталона має лежати принаймні за стільки секунд до кінця запису, щоб не «впертися» в край. */
const END_MARGIN_SECONDS = 2

export type Confidence = 'good' | 'fair' | 'poor'

export interface AutoSyncProgress {
  phase: 'starting' | 'listening' | 'analyzing'
  seconds: number
  total: number
}

export interface AutoSyncResult {
  offsetMs: number
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
  readonly seconds: number
  readonly ended: boolean
  start(): void
  stop(): Recording
  /** Поточний запис без зупинки (для проміжних спроб). */
  snapshot(): Recording
}

export interface AutoSyncOptions {
  player: YtPlayerLike
  notes: readonly NoteEvent[]
  recorder: RecorderLike
  onProgress?: (p: AutoSyncProgress) => void
  signal?: AbortSignal
  /** Для тестів: замість setTimeout. */
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export async function autoSyncOffset(options: AutoSyncOptions): Promise<AutoSyncResult> {
  const { player, recorder, signal } = options
  const sleep = options.sleep ?? defaultSleep
  const progress = options.onProgress ?? (() => {})

  // Еталон: перші REF_SECONDS табу від першої ноти, без тиші в кінці (короткий таб).
  const full = chromaFromNotes(options.notes, REF_SECONDS + 60)
  const lead = firstSound(full)
  const ref = full.slice(lead, Math.min(lead + REF_SECONDS * CHROMA_FPS, lastSound(full) + 1))
  if (ref.length < MIN_REF_SECONDS * CHROMA_FPS) throw new NoNotesError()
  const refStartMs = (lead / CHROMA_FPS) * 1000
  const refSeconds = ref.length / CHROMA_FPS

  const duration = player.getDuration()
  const total = Math.max(
    Math.min(refSeconds + STEP_SECONDS, duration || Infinity),
    Math.min(refSeconds + SEARCH_SECONDS, duration > 0 ? duration - 1 : refSeconds + SEARCH_SECONDS),
  )

  progress({ phase: 'starting', seconds: 0, total })
  player.seekTo(0, true)
  player.playVideo()
  for (let waited = 0; player.getPlayerState() !== YtState.PLAYING; waited += 50) {
    if (waited > 10_000) throw new Error('video did not start')
    if (signal?.aborted || recorder.ended) throw new CancelledError()
    await sleep(50)
  }

  // Пари «секунд записано ↔ час відео» для переведення кадрів запису в час відео.
  const pairs: number[] = []
  recorder.start()
  let nextTry = FIRST_TRY_SECONDS
  let match: ShiftedMatch | null = null
  let analyzed = 0
  try {
    while (recorder.seconds < total) {
      await sleep(100)
      const sec = recorder.seconds
      if (sec > 0.5) pairs.push(player.getCurrentTime() - sec)
      progress({ phase: 'listening', seconds: sec, total })
      const stopEarly = signal?.aborted || recorder.ended || player.getPlayerState() !== YtState.PLAYING
      if (stopEarly) {
        if (sec < MIN_REF_SECONDS + STEP_SECONDS) throw new CancelledError()
        break
      }
      if (sec >= nextTry) {
        nextTry += STEP_SECONDS
        const m = analyze(ref, recorder.snapshot())
        analyzed = sec
        if (m && m.cost <= GOOD_COST && m.end / CHROMA_FPS <= sec - END_MARGIN_SECONDS) {
          match = m
          break
        }
      }
    }
  } finally {
    player.pauseVideo()
  }

  progress({ phase: 'analyzing', seconds: recorder.seconds, total })
  const recording = recorder.stop()
  if (!match || analyzed < recorder.seconds - STEP_SECONDS) match = analyze(ref, recording) ?? match
  if (!match) throw new NoNotesError()

  const delta = median(pairs)
  const startSec = match.start / CHROMA_FPS + delta
  const offsetMs = Math.max(0, Math.round(startSec * 1000 - refStartMs))
  const confidence: Confidence = match.cost <= GOOD_COST ? 'good' : match.cost <= FAIR_COST ? 'fair' : 'poor'
  return { offsetMs, confidence, shift: match.shift, cost: match.cost }
}

function analyze(ref: Float32Array[], recording: Recording): ShiftedMatch | null {
  const target = audioChroma(recording.samples, recording.sampleRate)
  return bestShiftedMatch(ref, target)
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}
