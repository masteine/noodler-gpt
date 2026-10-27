// Пресети строїв. MIDI-ноти йдуть від найтовстішої струни до найтоншої.

import { noteToFrequency } from './pitch'

export interface Tuning {
  id: string
  name: string
  midi: number[]
}

export const TUNINGS: Tuning[] = [
  { id: 'standard', name: 'Standard (E A D G B E)', midi: [40, 45, 50, 55, 59, 64] },
  { id: 'drop-d', name: 'Drop D', midi: [38, 45, 50, 55, 59, 64] },
  { id: 'eb', name: 'Eb Standard', midi: [39, 44, 49, 54, 58, 63] },
  { id: 'd-standard', name: 'D Standard', midi: [38, 43, 48, 53, 57, 62] },
  { id: 'drop-c', name: 'Drop C', midi: [36, 43, 48, 53, 57, 62] },
  { id: 'open-g', name: 'Open G', midi: [38, 43, 50, 55, 59, 62] },
  { id: 'dadgad', name: 'DADGAD', midi: [38, 45, 50, 55, 57, 62] },
  { id: 'bass4', name: 'Бас 4 струни', midi: [28, 33, 38, 43] },
  { id: 'bass5', name: 'Бас 5 струн', midi: [23, 28, 33, 38, 43] },
]

export interface StringMatch {
  /** Індекс у масиві midi (0 — найтовща струна). */
  index: number
  midi: number
  /** Відхилення від цієї струни в центах: мінус — нижче, плюс — вище. Може виходити за ±50. */
  cents: number
}

/** Найближча (за відстанню в центах) струна строю до виміряної частоти. */
export function nearestString(midi: number[], freq: number, a4 = 440): StringMatch {
  let best = 0
  let bestCents = Infinity
  for (let i = 0; i < midi.length; i++) {
    const cents = 1200 * Math.log2(freq / noteToFrequency(midi[i], a4))
    if (Math.abs(cents) < Math.abs(bestCents)) {
      best = i
      bestCents = cents
    }
  }
  return { index: best, midi: midi[best], cents: bestCents }
}
