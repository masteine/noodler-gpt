// Еталонна хрома з нот табу. Синтезувати звук не треба: з нот відомо, які класи висот звучать
// у кожну мить. Кожній ноті додаємо трохи енергії на квінту й терцію, бо так звучать обертони
// гітари в реальному записі, і загасання, як у защипнутої струни.

import type * as alphaTab from '@coderline/alphatab'
import { CHROMA_FPS, finishChroma } from './chroma'

/** Нота в часі синтезатора alphaTab (мс від такту 1). */
export interface NoteEvent {
  onsetMs: number
  durationMs: number
  /** MIDI-номер. */
  midi: number
}

/** Тіків на чверть у alphaTab (MidiUtils.QuarterTime). */
const QUARTER_TICKS = 960

/** Відносна енергія обертонів: сама нота, квінта (3-й обертон), велика терція (5-й обертон). */
const HARMONICS: readonly [number, number][] = [
  [0, 1],
  [7, 0.4],
  [4, 0.2],
]

/** Стала загасання: за секунду нота втрачає ~63 % енергії, як струна. */
const DECAY_S = 1

/**
 * Витягує ноти з перших `maxMs` мілісекунд табу в порядку відтворення (з повторами).
 * Ударні доріжки пропускаємо: у них немає висоти.
 */
export function notesFromScore(score: alphaTab.model.Score, tickCache: alphaTab.midi.MidiTickLookup, maxMs: number): NoteEvent[] {
  const events: NoteEvent[] = []
  let ms = 0
  for (const entry of tickCache.masterBars) {
    if (ms > maxMs) break
    const toMs = tickToMs(entry, ms)
    const index = entry.masterBar.index
    for (const track of score.tracks) {
      if (track.isPercussion) continue
      for (const staff of track.staves) {
        if (staff.isPercussion) continue
        const bar = staff.bars[index]
        if (!bar) continue
        for (const voice of bar.voices) {
          for (const beat of voice.beats) {
            if (beat.isRest || beat.isEmpty) continue
            const startTick = entry.start + beat.playbackStart
            const endTick = startTick + beat.playbackDuration
            const onsetMs = toMs(startTick)
            const durationMs = Math.max(0, toMs(endTick) - onsetMs)
            for (const note of beat.notes) {
              if (note.isDead || note.isTieDestination) continue
              events.push({ onsetMs, durationMs, midi: note.realValue })
            }
          }
        }
      }
    }
    ms = toMs(entry.end)
  }
  return events.filter((e) => e.onsetMs <= maxMs).sort((a, b) => a.onsetMs - b.onsetMs)
}

/** Такт у порядку відтворення: індекс, котрий раз звучить, час початку в табі (мс). */
export interface BarTime {
  barIndex: number
  barOccurence: number
  startMs: number
}

/** Такти в порядку відтворення (з повторами) і їхній час у синтезаторі. */
export function barsFromTickCache(tickCache: alphaTab.midi.MidiTickLookup): BarTime[] {
  const bars: BarTime[] = []
  const seen = new Map<number, number>()
  let ms = 0
  for (const entry of tickCache.masterBars) {
    const index = entry.masterBar.index
    const occurrence = seen.get(index) ?? 0
    seen.set(index, occurrence + 1)
    bars.push({ barIndex: index, barOccurence: occurrence, startMs: ms })
    ms = tickToMs(entry, ms)(entry.end)
  }
  return bars
}

/** Функція тік → мс для одного такту з урахуванням змін темпу всередині нього. */
function tickToMs(entry: alphaTab.midi.MasterBarTickLookup, barStartMs: number): (tick: number) => number {
  const changes = entry.tempoChanges.length ? entry.tempoChanges : [{ tick: entry.start, tempo: entry.tempo }]
  return (tick) => {
    let ms = barStartMs
    let pos = entry.start
    let tempo = changes[0].tempo
    for (const c of changes) {
      if (c.tick > tick) break
      ms += msPerTick(tempo) * (Math.max(c.tick, pos) - pos)
      pos = Math.max(c.tick, pos)
      tempo = c.tempo
    }
    return ms + msPerTick(tempo) * (tick - pos)
  }
}

function msPerTick(bpm: number): number {
  return 60000 / (Math.max(1, bpm) * QUARTER_TICKS)
}

/**
 * Хрома з нот: кадри по 1/fps с від 0 до `seconds`. Ті самі нормалізації, що й для звуку,
 * тож вектори можна порівнювати косинусною відстанню.
 */
export function chromaFromNotes(notes: readonly NoteEvent[], seconds: number, fps = CHROMA_FPS): Float32Array[] {
  const count = Math.max(0, Math.ceil(seconds * fps))
  const raw: Float32Array[] = []
  for (let f = 0; f < count; f++) raw.push(new Float32Array(12))
  for (const n of notes) {
    const first = Math.max(0, Math.floor((n.onsetMs / 1000) * fps))
    const last = Math.min(count - 1, Math.floor(((n.onsetMs + Math.max(n.durationMs, 250)) / 1000) * fps))
    const pc = ((n.midi % 12) + 12) % 12
    for (let f = first; f <= last; f++) {
      const age = (f / fps - n.onsetMs / 1000) / DECAY_S
      const energy = Math.exp(-Math.max(0, age))
      for (const [interval, weight] of HARMONICS) raw[f][(pc + interval) % 12] += energy * weight
    }
  }
  return finishChroma(raw)
}
