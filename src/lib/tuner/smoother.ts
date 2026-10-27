// Згладжування показів тюнера: медіана з останніх N вимірів + утримання ноти після зникнення сигналу.
// Без залежностей від DOM, тому тестується в Node.

import type { PitchResult } from './pitch'

export interface PitchReading {
  frequency: number
  clarity: number
  /** true — сигналу вже нема, показуємо останнє значення (утримання). */
  held: boolean
}

export class PitchSmoother {
  private readonly size: number
  private readonly holdMs: number
  /** Історія в log2(Гц): медіана в лог-шкалі дорівнює медіані в центах. */
  private history: number[] = []
  private lastValidAt = -Infinity
  private last: PitchReading | null = null

  constructor(size = 5, holdMs = 400) {
    this.size = size
    this.holdMs = holdMs
  }

  /** `pitch` — свіжий вимір або null (тиша), `now` — час у мс. Повертає значення для показу. */
  push(pitch: PitchResult | null, now: number): PitchReading | null {
    if (pitch) {
      this.history.push(Math.log2(pitch.frequency))
      if (this.history.length > this.size) this.history.shift()
      this.lastValidAt = now
      this.last = { frequency: 2 ** median(this.history), clarity: pitch.clarity, held: false }
      return this.last
    }
    if (this.last && now - this.lastValidAt <= this.holdMs) {
      return { ...this.last, held: true }
    }
    this.reset()
    return null
  }

  reset() {
    this.history = []
    this.last = null
    this.lastValidAt = -Infinity
  }
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}
