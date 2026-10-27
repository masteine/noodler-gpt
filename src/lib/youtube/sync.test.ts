import { describe, expect, it } from 'vitest'
import { formatMs, offsetOf, parseMs, tapCount, withOffset, withTap, withoutBar, type FlatSyncPoint } from './sync'

const p = (barIndex: number, millisecondOffset: number, barOccurence = 0): FlatSyncPoint => ({
  barIndex,
  barPosition: 0,
  barOccurence,
  millisecondOffset,
})

describe('withOffset / offsetOf', () => {
  it('порожній список → одна мітка на такті 0', () => {
    expect(withOffset([], 7000)).toEqual([p(0, 7000)])
    expect(offsetOf(withOffset([], 7000))).toBe(7000)
  })

  it('замінює наявну мітку такту 0, інші лишає', () => {
    const pts = withOffset([p(0, 1000), p(8, 20_000)], 3000)
    expect(pts).toEqual([p(0, 3000), p(8, 20_000)])
  })

  it('відкидає мітки, що опинилися раніше нового початку', () => {
    const pts = withOffset([p(0, 1000), p(4, 2500), p(8, 20_000)], 3000)
    expect(pts).toEqual([p(0, 3000), p(8, 20_000)])
  })

  it('від’ємний і дробовий зсув нормалізуються', () => {
    expect(offsetOf(withOffset([], -5))).toBe(0)
    expect(offsetOf(withOffset([], 1234.6))).toBe(1235)
  })

  it('offsetOf без мітки такту 0 = 0', () => {
    expect(offsetOf([p(4, 9000)])).toBe(0)
  })
})

describe('withTap', () => {
  it('додає мітку й сортує за порядком відтворення', () => {
    const pts = withTap([p(0, 1000), p(8, 20_000)], { barIndex: 4, barOccurence: 0 }, 10_000)
    expect(pts).toEqual([p(0, 1000), p(4, 10_000), p(8, 20_000)])
    expect(tapCount(pts)).toBe(2)
  })

  it('замінює мітку того самого такту', () => {
    const pts = withTap([p(0, 1000), p(4, 10_000)], { barIndex: 4, barOccurence: 0 }, 11_000)
    expect(pts).toEqual([p(0, 1000), p(4, 11_000)])
  })

  it('прибирає суперечливі мітки: ранішій такт із пізнішим часом', () => {
    const pts = withTap([p(0, 1000), p(4, 12_000), p(8, 20_000)], { barIndex: 6, barOccurence: 0 }, 11_000)
    expect(pts).toEqual([p(0, 1000), p(6, 11_000), p(8, 20_000)])
  })

  it('прибирає суперечливі мітки: пізніший такт із ранішим часом', () => {
    const pts = withTap([p(0, 1000), p(8, 9000)], { barIndex: 4, barOccurence: 0 }, 10_000)
    expect(pts).toEqual([p(0, 1000), p(4, 10_000)])
  })

  it('повтори: другий прохід такту йде після першого за замовчуванням', () => {
    const pts = withTap([p(0, 0), p(2, 4000)], { barIndex: 1, barOccurence: 1 }, 9000)
    expect(pts.map((x) => [x.barIndex, x.barOccurence])).toEqual([
      [0, 0],
      [2, 0],
      [1, 1],
    ])
  })

  it('власний порядок відтворення', () => {
    // порядок: такт 9 (прохід 0) грає ПІСЛЯ такту 5 у другому проході
    const order = (b: { barIndex: number; barOccurence: number }) =>
      b.barIndex === 9 ? 100 : b.barOccurence * 10 + b.barIndex
    const pts = withTap([p(0, 0), p(9, 60_000)], { barIndex: 5, barOccurence: 1 }, 30_000, order)
    expect(pts).toEqual([p(0, 0), p(5, 30_000, 1), p(9, 60_000)])
  })

  it('withoutBar прибирає мітку', () => {
    expect(withoutBar([p(0, 0), p(4, 5000)], { barIndex: 4, barOccurence: 0 })).toEqual([p(0, 0)])
  })
})

describe('formatMs / parseMs', () => {
  it('форматує', () => {
    expect(formatMs(0)).toBe('0:00.0')
    expect(formatMs(7350)).toBe('0:07.4')
    expect(formatMs(83_400)).toBe('1:23.4')
    expect(formatMs(-5)).toBe('0:00.0')
  })

  it('розбирає', () => {
    expect(parseMs('1:23.4')).toBe(83_400)
    expect(parseMs('83.4')).toBe(83_400)
    expect(parseMs('83')).toBe(83_000)
    expect(parseMs(' 0:07,5 ')).toBe(7500)
    expect(parseMs('')).toBeNull()
    expect(parseMs('abc')).toBeNull()
    expect(parseMs('1:2:3')).toBeNull()
  })
})
