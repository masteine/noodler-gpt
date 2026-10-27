// Subsequence DTW: шукає, де всередині довгої послідовності (запис) найкраще вкладається коротка
// (еталон із табу), дозволяючи темпу «плисти». Кроки (1,1), (1,2), (2,1) тримають темп у межах
// 0.5–2× еталонного і не дають шляху «зависати» на одному кадрі. Кожен крок платить за всі
// клітинки, які проходить, плюс невелика надбавка за недіагональні кроки: так шлях не може
// «з’їсти» погано збіжний початок еталона, стиснувши його вдвічі задарма.
// Початок у записі вільний (будь-який кадр), кінець — найдешевший серед усіх.

import { cosineDistance, rotate } from './chroma'

export interface DtwMatch {
  /** Кадр запису, у якому починається еталон. */
  start: number
  /** Кадр запису, у якому еталон закінчується. */
  end: number
  /** Середня відстань на кадр еталона: 0 — ідеальний збіг, ~0.6+ — випадковий. */
  cost: number
  /** Для кожного кадру еталона — кадр запису (монотонно). */
  path: Int32Array
}

/** Надбавка за крок, що змінює темп (у одиницях відстані). */
const TEMPO_PENALTY = 0.05

export function subsequenceDtw(ref: readonly Float32Array[], target: readonly Float32Array[]): DtwMatch | null {
  const n = ref.length
  const m = target.length
  if (n < 2 || m < 2) return null

  // Матриця накопичених вартостей і напрямок кроку для зворотного проходу.
  const D = new Float64Array(n * m).fill(Number.POSITIVE_INFINITY)
  const step = new Uint8Array(n * m) // 0 — старт, 1 — (1,1), 2 — (1,2), 3 — (2,1)
  const C = (i: number, j: number) => cosineDistance(ref[i], target[j])
  for (let j = 0; j < m; j++) D[j] = C(0, j)

  for (let i = 1; i < n; i++) {
    const row = i * m
    const prev = row - m
    const prev2 = row - 2 * m
    for (let j = 1; j < m; j++) {
      const c = C(i, j)
      let best = D[prev + j - 1] + c
      let s = 1
      if (j >= 2) {
        const v = D[prev + j - 2] + C(i, j - 1) + c + TEMPO_PENALTY
        if (v < best) {
          best = v
          s = 2
        }
      }
      if (i >= 2) {
        const v = D[prev2 + j - 1] + C(i - 1, j) + c + TEMPO_PENALTY
        if (v < best) {
          best = v
          s = 3
        }
      }
      if (best === Number.POSITIVE_INFINITY) continue
      D[row + j] = best
      step[row + j] = s
    }
  }

  const last = (n - 1) * m
  let end = -1
  let bestCost = Number.POSITIVE_INFINITY
  for (let j = 0; j < m; j++) {
    if (D[last + j] < bestCost) {
      bestCost = D[last + j]
      end = j
    }
  }
  if (end < 0) return null

  // Зворотний прохід: від кінця до рядка 0. Пропущені рядки (крок (2,1)) добудовуємо середнім.
  const path = new Int32Array(n).fill(-1)
  let i = n - 1
  let j = end
  while (i > 0) {
    path[i] = j
    const s = step[i * m + j]
    if (s === 1) {
      i -= 1
      j -= 1
    } else if (s === 2) {
      i -= 1
      j -= 2
    } else {
      i -= 2
      j -= 1
    }
  }
  path[0] = j
  for (let k = 1; k < n; k++) if (path[k] < 0) path[k] = Math.round((path[k - 1] + path[k + 1]) / 2)

  return { start: path[0], end, cost: bestCost / n, path }
}

export interface ShiftedMatch extends DtwMatch {
  /** На скільки півтонів угору треба зсунути еталон, щоб він збігся із записом (0 — строї збігаються). */
  shift: number
}

/**
 * Те саме, але еталон пробується в усіх 12 транспозиціях: тюнінг табу й запису може не збігатися
 * (Eb-стрій, транспонований запис). Повертає найдешевший збіг.
 */
export function bestShiftedMatch(
  ref: readonly Float32Array[],
  target: readonly Float32Array[],
  shifts: readonly number[] = [0, 1, 11, 2, 10, 3, 9, 4, 8, 5, 7, 6],
): ShiftedMatch | null {
  let best: ShiftedMatch | null = null
  for (const shift of shifts) {
    const shifted = shift === 0 ? ref : ref.map((v) => rotate(v, shift))
    const match = subsequenceDtw(shifted, target)
    if (match && (!best || match.cost < best.cost)) best = { ...match, shift }
  }
  return best
}
