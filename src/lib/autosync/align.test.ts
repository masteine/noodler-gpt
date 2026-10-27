// Наскрізна перевірка: ноти «табу» → еталонна хрома; ті самі ноти, синтезовані як звук із тишею
// на початку й трохи іншим темпом → хрома запису; DTW має знайти, де в «записі» починається такт 1.
import { describe, expect, it } from 'vitest'
import { audioChroma, CHROMA_FPS, firstSound } from './chroma'
import { bestShiftedMatch } from './dtw'
import { chromaFromNotes, type NoteEvent } from './score'
import { mix, tone } from './chroma.test'

const SR = 22050

/** Простий риф: E5 → G → A → C, по 4 чверті при 120 BPM, плюс бас. */
function riff(bars: number): NoteEvent[] {
  const notes: NoteEvent[] = []
  const chords = [
    [40, 47, 52],
    [43, 50, 55],
    [45, 52, 57],
    [48, 55, 60],
  ]
  for (let bar = 0; bar < bars; bar++) {
    const chord = chords[bar % chords.length]
    for (let beat = 0; beat < 4; beat++) {
      const onsetMs = (bar * 4 + beat) * 500
      for (const midi of chord) notes.push({ onsetMs, durationMs: 450, midi })
      // мелодійна нота на слабких долях, щоб такти різнилися
      if (beat % 2 === 1) notes.push({ onsetMs: onsetMs + 250, durationMs: 200, midi: 64 + ((bar * 3 + beat) % 7) })
    }
  }
  return notes
}

function render(notes: NoteEvent[], leadInSec: number, tempoRatio: number, transpose = 0): Float32Array {
  const total = leadInSec + ((notes.at(-1)!.onsetMs + 2000) / 1000) * tempoRatio
  const audio = new Float32Array(Math.round(total * SR))
  for (const n of notes) {
    const at = Math.round((leadInSec + (n.onsetMs / 1000) * tempoRatio) * SR)
    mix(audio, tone(n.midi + transpose, Math.max(0.3, n.durationMs / 1000) * 1.5), at)
  }
  return audio
}

describe('вирівнювання табу із записом', () => {
  const notes = riff(8) // 16 с музики
  const ref = chromaFromNotes(notes, 16)

  it('еталон починається зі звуку', () => {
    expect(firstSound(ref)).toBe(0)
    expect(ref.length).toBe(160)
  })

  it('знаходить початок при тиші 7.3 с і темпі 0.95', () => {
    const audio = render(notes, 7.3, 0.95)
    const target = audioChroma(audio, SR)
    const m = bestShiftedMatch(ref, target)!
    const foundSec = m.start / CHROMA_FPS
    expect(Math.abs(foundSec - 7.3)).toBeLessThan(0.25)
    expect(m.shift).toBe(0)
    expect(m.cost).toBeLessThan(0.35)
  })

  it('знаходить початок і транспозицію, коли запис на півтон нижче', () => {
    const audio = render(notes, 3, 1.05, -1)
    const target = audioChroma(audio, SR)
    const m = bestShiftedMatch(ref, target)!
    expect(Math.abs(m.start / CHROMA_FPS - 3)).toBeLessThan(0.25)
    expect(m.shift).toBe(11)
  })

  it('не знаходить впевненого збігу у сторонньому матеріалі', () => {
    // Інша пісня: той самий ритм, але випадкові (детерміновано) висоти.
    let x = 12345
    const other = riff(8).map((n) => {
      x = (x * 1103515245 + 12345) % 2147483648
      return { ...n, midi: 40 + (x % 24) }
    })
    const audio = render(other, 2, 1)
    const m = bestShiftedMatch(ref, audioChroma(audio, SR))!
    expect(m.cost).toBeGreaterThan(0.3)
  })
})
