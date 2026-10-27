// notesFromScore на справжньому score alphaTab: демо-риф через alphaTex і MidiFileGenerator.
import { describe, expect, it } from 'vitest'
import * as alphaTab from '@coderline/alphatab'
import { demoTex } from '../player/demo'
import { chromaFromNotes, notesFromScore } from './score'
import { firstSound } from './chroma'

function loadDemo() {
  const settings = new alphaTab.Settings()
  const score = alphaTab.importer.ScoreLoader.loadAlphaTex(demoTex({ title: 'Demo', guitar: 'Guitar', bass: 'Bass' }), settings)
  const generator = new alphaTab.midi.MidiFileGenerator(score, settings, new alphaTab.midi.AlphaSynthMidiFileHandler(new alphaTab.midi.MidiFile()))
  generator.generate()
  return { score, tickCache: generator.tickLookup }
}

describe('notesFromScore', () => {
  const { score, tickCache } = loadDemo()

  it('дістає ноти обох доріжок у мс за темпом 110', () => {
    const notes = notesFromScore(score, tickCache, 60_000)
    expect(notes.length).toBeGreaterThan(40)
    expect(notes[0].onsetMs).toBe(0)
    // Гітара (струна 6, лад 0) і бас на першій долі: обидві ноти — E, октава для хроми не важить.
    expect(notes.filter((n) => n.onsetMs === 0).map((n) => n.midi % 12)).toEqual([4, 4])
    // Восьма при 110 BPM ≈ 272.7 мс.
    const second = notes.find((n) => n.onsetMs > 0)!
    expect(Math.abs(second.onsetMs - 60000 / 110 / 2)).toBeLessThan(1)
    // Такт 3 (2 такти по 4 чверті) починається на 4363.6 мс: там акорд.
    const bar3 = notes.filter((n) => Math.abs(n.onsetMs - (8 * 60000) / 110) < 1).map((n) => n.midi)
    expect(bar3.length).toBeGreaterThanOrEqual(3)
  })

  it('обмежує за часом і будує хрому без тиші на початку', () => {
    const notes = notesFromScore(score, tickCache, 3000)
    expect(notes.every((n) => n.onsetMs <= 3000)).toBe(true)
    const ref = chromaFromNotes(notesFromScore(score, tickCache, 60_000), 10)
    expect(firstSound(ref)).toBe(0)
  })
})
