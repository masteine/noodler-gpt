// Старі таби (особливо .gp3, де темп один на весь файл) часто несуть зміни темпу як текст біля ноти:
// «132 bpm», «Tempo 164», «♩ = 120». alphaTab показує такий текст, але темп із нього не бере.
// Тут ці написи стають справжніми змінами темпу, щоб синтезатор і курсор грали як задумав автор.

import * as alphaTab from '@coderline/alphatab'

/** Темп у тексті: «132 bpm», «132bpm», «bpm 132», «tempo 132», «♩ = 132», «q=132». */
const PATTERNS = [/(\d{2,3})\s*bpm\b/i, /\bbpm\s*[=:]?\s*(\d{2,3})/i, /\btempo\s*[=:]?\s*(\d{2,3})/i, /(?:♩|[♪𝅘𝅥]|\bq)\s*=\s*(\d{2,3})/i]

const MIN_BPM = 20
const MAX_BPM = 400

/** Темп із тексту або null, якщо текст не схожий на позначку темпу. */
export function tempoFromText(text: string | null | undefined): number | null {
  if (!text) return null
  for (const re of PATTERNS) {
    const m = re.exec(text)
    if (!m) continue
    const bpm = Number(m[1])
    if (bpm >= MIN_BPM && bpm <= MAX_BPM) return bpm
  }
  return null
}

/**
 * Додає в score зміни темпу з текстових написів. Повертає, скільки змін додано.
 * Напис діє з початку своєї долі; якщо в такті вже є зміна темпу на тому ж місці з тим самим
 * значенням, нічого не змінюємо, інакше текст має пріоритет (у gp3 «справжній» темп один і часто
 * відповідає лише основній частині пісні).
 */
export function applyTempoTexts(score: alphaTab.model.Score): number {
  let added = 0
  for (const masterBar of score.masterBars) {
    const found = findTempoText(score, masterBar.index)
    if (!found) continue
    const { bpm, ratio } = found
    const same = masterBar.tempoAutomations.filter((a) => Math.abs(a.ratioPosition - ratio) < 1e-6)
    if (same.length && same.every((a) => a.value === bpm)) continue
    // gp3 кладе в такт 1 дві однакові зміни на позиції 0; прибираємо всі на цьому місці, лишаємо одну.
    const rest = masterBar.tempoAutomations.filter((a) => !same.includes(a))
    rest.push(alphaTab.model.Automation.buildTempoAutomation(false, ratio, bpm, 0, false))
    rest.sort((a, b) => a.ratioPosition - b.ratioPosition)
    masterBar.tempoAutomations = rest
    added++
  }
  return added
}

/** Перший (за позицією в такті) напис темпу серед усіх доріжок такту. */
function findTempoText(score: alphaTab.model.Score, barIndex: number): { bpm: number; ratio: number } | null {
  let best: { bpm: number; ratio: number } | null = null
  for (const track of score.tracks) {
    for (const staff of track.staves) {
      const bar = staff.bars[barIndex]
      if (!bar) continue
      const duration = bar.calculateDuration()
      for (const voice of bar.voices) {
        for (const beat of voice.beats) {
          const bpm = tempoFromText(beat.text)
          if (bpm === null) continue
          const ratio = duration > 0 ? Math.min(1, Math.max(0, beat.playbackStart / duration)) : 0
          if (!best || ratio < best.ratio) best = { bpm, ratio }
        }
      }
    }
  }
  return best
}
