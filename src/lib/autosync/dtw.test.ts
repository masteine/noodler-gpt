import { describe, expect, it } from 'vitest'
import { rotate, unit } from './chroma'
import { bestShiftedMatch, subsequenceDtw } from './dtw'

/** Детермінований «випадковий» вектор, схожий на хрому акорду: три активні класи висот. */
function vec(seed: number): Float32Array {
  const v = new Float32Array(12)
  let x = seed * 9301 + 49297
  for (let k = 0; k < 3; k++) {
    x = (x * 1103515245 + 12345) % 2147483648
    v[x % 12] = 0.5 + (x % 1000) / 2000
  }
  return unit(v)
}

/** Розтягує послідовність у `ratio` разів (ratio > 1 — повільніше), повторюючи кадри. */
function stretch(frames: Float32Array[], ratio: number): Float32Array[] {
  const out: Float32Array[] = []
  const n = Math.round(frames.length * ratio)
  for (let i = 0; i < n; i++) out.push(frames[Math.min(frames.length - 1, Math.floor(i / ratio))])
  return out
}

describe('subsequenceDtw', () => {
  const ref = Array.from({ length: 60 }, (_, i) => vec(i + 1))

  it('знаходить еталон усередині шуму з тим самим темпом', () => {
    const noise = (k: number) => Array.from({ length: k }, (_, i) => vec(1000 + i))
    const target = [...noise(37), ...ref, ...noise(50)]
    const m = subsequenceDtw(ref, target)!
    expect(m.start).toBe(37)
    expect(m.end).toBe(37 + 59)
    expect(m.cost).toBeLessThan(0.05)
  })

  it('знаходить початок, коли запис повільніший на 15 %', () => {
    const noise = Array.from({ length: 80 }, (_, i) => vec(2000 + i))
    const target = [...noise, ...stretch(ref, 1.15), ...noise]
    const m = subsequenceDtw(ref, target)!
    expect(Math.abs(m.start - 80)).toBeLessThanOrEqual(1)
    expect(m.cost).toBeLessThan(0.1)
    for (let i = 1; i < m.path.length; i++) expect(m.path[i]).toBeGreaterThanOrEqual(m.path[i - 1])
  })

  it('випадковий збіг коштує помітно дорожче', () => {
    const target = Array.from({ length: 300 }, (_, i) => vec(5000 + i))
    const m = subsequenceDtw(ref, target)!
    expect(m.cost).toBeGreaterThan(0.3)
  })

  it('bestShiftedMatch знаходить транспозицію', () => {
    const noise = Array.from({ length: 20 }, (_, i) => vec(3000 + i))
    const target = [...noise, ...ref.map((v) => rotate(v, 3)), ...noise]
    const m = bestShiftedMatch(ref, target)!
    expect(m.shift).toBe(3)
    expect(m.start).toBe(20)
  })
})
