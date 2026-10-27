export interface EvictEntry {
  id: string
  size: number
  openedAt: number
}

export interface EvictLimits {
  /** Максимум записів. */
  maxCount: number
  /** Максимум сумарного розміру, байт. */
  maxTotalBytes: number
}

/**
 * Повертає id записів, які треба видалити. Найновіші (за openedAt) мають пріоритет;
 * кожен запис, що вже не вміщується в ліміт кількості чи сумарного розміру, видаляється.
 * Найновіший запис не видаляється ніколи (навіть якщо він сам більший за ліміт).
 */
export function pickEvictions(entries: readonly EvictEntry[], limits: EvictLimits): string[] {
  const sorted = [...entries].sort((a, b) => b.openedAt - a.openedAt)
  const evict: string[] = []
  let count = 0
  let total = 0
  for (const e of sorted) {
    const fits = count < limits.maxCount && total + e.size <= limits.maxTotalBytes
    if (fits || count === 0) {
      count++
      total += e.size
    } else {
      evict.push(e.id)
    }
  }
  return evict
}
