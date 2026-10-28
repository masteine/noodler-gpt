import { describe, expect, it } from 'vitest'
import * as alphaTab from '@coderline/alphatab'
import { applyTempoTexts, tempoFromText } from './tempoText'

function load(tex: string) {
  const settings = new alphaTab.Settings()
  const score = alphaTab.importer.ScoreLoader.loadAlphaTex(tex, settings)
  return { score, settings }
}

function barTimes(score: alphaTab.model.Score, settings: alphaTab.Settings): number[] {
  const generator = new alphaTab.midi.MidiFileGenerator(score, settings, new alphaTab.midi.AlphaSynthMidiFileHandler(new alphaTab.midi.MidiFile()))
  generator.generate()
  const out: number[] = []
  let ms = 0
  for (const e of generator.tickLookup.masterBars) {
    out.push(ms)
    const changes = e.tempoChanges.length ? e.tempoChanges : [{ tick: e.start, tempo: e.tempo }]
    let pos = e.start
    let tempo = changes[0].tempo
    for (const c of changes) {
      if (c.tick > pos) {
        ms += ((c.tick - pos) * 60000) / (tempo * 960)
        pos = c.tick
      }
      tempo = c.tempo
    }
    ms += ((e.end - pos) * 60000) / (tempo * 960)
  }
  return out
}

describe('tempoFromText', () => {
  it('розпізнає поширені написи', () => {
    expect(tempoFromText('132 bpm')).toBe(132)
    expect(tempoFromText('164bpm')).toBe(164)
    expect(tempoFromText('Tempo = 90')).toBe(90)
    expect(tempoFromText('♩ = 120')).toBe(120)
    expect(tempoFromText('bpm: 100')).toBe(100)
  })

  it('не плутає з іншим текстом', () => {
    expect(tempoFromText('Palm muting on this figure')).toBeNull()
    expect(tempoFromText('5 bpm')).toBeNull()
    expect(tempoFromText('')).toBeNull()
    expect(tempoFromText(null)).toBeNull()
  })
})

describe('applyTempoTexts', () => {
  it('«132 bpm» у такті 1 замінює темп файлу, «164 bpm» у такті 3 повертає його', () => {
    const { score, settings } = load(`\\tempo 164 . 0.6{txt "132 bpm"} 0.6 0.6 0.6 | 0.6 0.6 0.6 0.6 | 0.6{txt "164 bpm"} 0.6 0.6 0.6 | 0.6 0.6 0.6 0.6`)
    expect(barTimes(score, settings)[1]).toBeCloseTo((4 * 60000) / 164, 0)
    expect(applyTempoTexts(score)).toBe(2)
    const times = barTimes(score, settings)
    expect(times[1]).toBeCloseTo((4 * 60000) / 132, 0)
    expect(times[2]).toBeCloseTo((8 * 60000) / 132, 0)
    expect(times[3]).toBeCloseTo((8 * 60000) / 132 + (4 * 60000) / 164, 0)
    expect(score.masterBars[0].tempoAutomations[0].value).toBe(132)
  })

  it('напис посеред такту діє з цієї долі, повторний виклик нічого не додає', () => {
    const { score, settings } = load(`\\tempo 120 . 0.6 0.6 0.6{txt "60 bpm"} 0.6 | 0.6 0.6 0.6 0.6`)
    expect(applyTempoTexts(score)).toBe(1)
    expect(applyTempoTexts(score)).toBe(0)
    const times = barTimes(score, settings)
    expect(times[1]).toBeCloseTo((2 * 60000) / 120 + (2 * 60000) / 60, 0)
  })

  it('без написів нічого не змінює', () => {
    const { score } = load(`\\tempo 100 . 0.6 0.6 0.6 0.6`)
    expect(applyTempoTexts(score)).toBe(0)
  })
})
