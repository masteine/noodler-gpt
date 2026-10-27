import { describe, expect, it } from 'vitest'
import { audioChroma, cosineDistance, fft, firstSound, rotate, unit } from './chroma'

const SR = 22050

/** Тон із трьома обертонами, як спрощена струна. */
export function tone(midi: number, seconds: number, sr = SR): Float32Array {
  const f = 440 * 2 ** ((midi - 69) / 12)
  const out = new Float32Array(Math.round(seconds * sr))
  for (let i = 0; i < out.length; i++) {
    const t = i / sr
    const env = Math.exp(-t / 1.2)
    out[i] = env * (Math.sin(2 * Math.PI * f * t) + 0.5 * Math.sin(4 * Math.PI * f * t) + 0.3 * Math.sin(6 * Math.PI * f * t))
  }
  return out
}

export function mix(into: Float32Array, src: Float32Array, atSample: number) {
  for (let i = 0; i < src.length && atSample + i < into.length; i++) into[atSample + i] += src[i]
}

function argmax(v: Float32Array): number {
  let best = 0
  for (let i = 1; i < v.length; i++) if (v[i] > v[best]) best = i
  return best
}

describe('fft', () => {
  it('знаходить пік на частоті синусоїди', () => {
    const n = 1024
    const re = new Float32Array(n)
    const im = new Float32Array(n)
    for (let i = 0; i < n; i++) re[i] = Math.sin((2 * Math.PI * 64 * i) / n)
    fft(re, im)
    const mags = new Float32Array(n / 2)
    for (let k = 0; k < n / 2; k++) mags[k] = re[k] * re[k] + im[k] * im[k]
    expect(argmax(mags)).toBe(64)
  })
})

describe('audioChroma', () => {
  it('A4 дає клас висоти A (9)', () => {
    const frames = audioChroma(tone(69, 2), SR)
    expect(frames.length).toBe(20)
    expect(argmax(frames[5])).toBe(9)
  })

  it('тиша дає нульові вектори, а firstSound знаходить перший звук', () => {
    const audio = new Float32Array(SR * 3)
    mix(audio, tone(64, 1), SR * 2)
    const frames = audioChroma(audio, SR)
    expect(firstSound(frames)).toBeGreaterThanOrEqual(15)
    expect(firstSound(frames)).toBeLessThanOrEqual(20)
    expect(cosineDistance(frames[0], frames[25])).toBe(1)
  })

  it('акорд E-мажор підсвічує E, G#, B', () => {
    const audio = new Float32Array(SR * 2)
    for (const m of [40, 47, 52, 56, 59, 64]) mix(audio, tone(m, 2), 0)
    const c = audioChroma(audio, SR)[8]
    const sorted = [...c.keys()].sort((a, b) => c[b] - c[a]).slice(0, 3)
    expect(new Set(sorted)).toEqual(new Set([4, 8, 11]))
  })
})

describe('rotate / unit', () => {
  it('зсув на 12 — тотожність, на 1 — переносить C у C#', () => {
    const v = unit(new Float32Array([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))
    expect(rotate(v, 12)).toEqual(v)
    expect(argmax(rotate(v, 1))).toBe(1)
    expect(argmax(rotate(v, -1))).toBe(11)
  })
})
