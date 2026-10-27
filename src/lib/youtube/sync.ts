// Мітки синхронізації табу з записом. Чисті функції над FlatSyncPoint — тим самим форматом,
// який alphaTab приймає через score.applyFlatSyncPoints(). Зсув початку пісні — це просто
// мітка на такті 0; tap-sync додає мітки на інших тактах, і alphaTab інтерполює темп між ними.

export interface FlatSyncPoint {
  barIndex: number
  /** Позиція всередині такту 0..1. Наші мітки завжди на початку такту (0). */
  barPosition: number
  /** Який раз цей такт звучить (повтори): 0 — перший. */
  barOccurence: number
  /** Час у записі, мс. */
  millisecondOffset: number
}

export interface BarRef {
  barIndex: number
  barOccurence: number
}

/** Порядок відтворення: менше число — раніше в пісні. Плеєр будує його з alphaTab tickCache. */
export type PlaybackOrder = (bar: BarRef) => number

/** Простий порядок без урахування повторів: спочатку за проходом, потім за номером такту. */
export const naiveOrder: PlaybackOrder = (b) => b.barOccurence * 1_000_000 + b.barIndex

export function sameBar(a: BarRef, b: BarRef): boolean {
  return a.barIndex === b.barIndex && a.barOccurence === b.barOccurence
}

function isStart(p: FlatSyncPoint): boolean {
  return p.barIndex === 0 && p.barOccurence === 0 && p.barPosition === 0
}

/** Зсув початку пісні у записі (мс) або 0, якщо мітки такту 0 немає. */
export function offsetOf(points: readonly FlatSyncPoint[]): number {
  return points.find(isStart)?.millisecondOffset ?? 0
}

/** Кількість міток, окрім зсуву початку. */
export function tapCount(points: readonly FlatSyncPoint[]): number {
  return points.filter((p) => !isStart(p)).length
}

/**
 * Ставить мітку початку (такт 0) на offsetMs. Мітки, що опинилися б раніше за новий початок,
 * відкидаються: час у записі має зростати разом із позицією в табу.
 */
export function withOffset(points: readonly FlatSyncPoint[], offsetMs: number): FlatSyncPoint[] {
  const ms = Math.max(0, Math.round(offsetMs))
  const rest = points.filter((p) => !isStart(p) && p.millisecondOffset > ms)
  return sortPoints([{ barIndex: 0, barPosition: 0, barOccurence: 0, millisecondOffset: ms }, ...rest], naiveOrder)
}

/**
 * Додає (або замінює) мітку на початку такту `bar` з часом `ms` у записі.
 * Мітки, які суперечать новій (раніше в пісні, але пізніше в записі, і навпаки), прибираються,
 * бо інакше alphaTab отримав би від’ємний темп між ними.
 */
export function withTap(
  points: readonly FlatSyncPoint[],
  bar: BarRef,
  ms: number,
  order: PlaybackOrder = naiveOrder,
): FlatSyncPoint[] {
  const time = Math.max(0, Math.round(ms))
  const pos = order(bar)
  const kept = points.filter((p) => {
    if (sameBar(p, bar)) return false
    const before = order(p) < pos
    return before ? p.millisecondOffset < time : p.millisecondOffset > time
  })
  const tap: FlatSyncPoint = { barIndex: bar.barIndex, barPosition: 0, barOccurence: bar.barOccurence, millisecondOffset: time }
  return sortPoints([...kept, tap], order)
}

/** Прибирає мітку конкретного такту (якщо це такт 0 — зсув стає 0). */
export function withoutBar(points: readonly FlatSyncPoint[], bar: BarRef): FlatSyncPoint[] {
  return points.filter((p) => !sameBar(p, bar))
}

export function sortPoints(points: readonly FlatSyncPoint[], order: PlaybackOrder): FlatSyncPoint[] {
  return [...points].sort((a, b) => order(a) - order(b) || a.barPosition - b.barPosition)
}

/** Плоска копія без проксі/класів — для IndexedDB і alphaTab. */
export function plainPoints(points: readonly FlatSyncPoint[]): FlatSyncPoint[] {
  return points.map((p) => ({
    barIndex: p.barIndex,
    barPosition: p.barPosition,
    barOccurence: p.barOccurence,
    millisecondOffset: p.millisecondOffset,
  }))
}

/** Форматує мс як m:ss.d для поля зсуву. */
export function formatMs(ms: number): string {
  const tenths = Math.round(Math.max(0, ms) / 100)
  const m = Math.floor(tenths / 600)
  const s = (tenths - m * 600) / 10
  return `${m}:${s.toFixed(1).padStart(4, '0')}`
}

/** Розбирає «1:23.4», «83.4», «83» → мс; null, якщо не число. */
export function parseMs(text: string): number | null {
  const t = text.trim().replace(',', '.')
  if (!t) return null
  const m = t.match(/^(?:(\d+):)?(\d+(?:\.\d+)?)$/)
  if (!m) return null
  const minutes = m[1] ? Number(m[1]) : 0
  const seconds = Number(m[2])
  if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) return null
  return Math.round((minutes * 60 + seconds) * 1000)
}
