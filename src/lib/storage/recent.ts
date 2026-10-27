// Нещодавні файли в IndexedDB. Усі функції безпечно деградують: якщо IndexedDB недоступний
// (приватне вікно Safari, заблоковані дані, квота), помилки ковтаються, а результат порожній.
import { pickEvictions } from './evict'
import { openDb, resetDb, wrap, txDone, RECENT_META as META, RECENT_BLOBS as BLOBS } from './db'

export interface RecentEntry {
  id: string
  name: string
  size: number
  /** Час останнього відкриття, мс з епохи. */
  openedAt: number
}

export const MAX_ENTRIES = 12
export const MAX_TOTAL_BYTES = 50 * 1024 * 1024
export const MAX_FILE_BYTES = 20 * 1024 * 1024

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** Список за спаданням часу відкриття. */
export async function listRecent(): Promise<RecentEntry[]> {
  try {
    const db = await openDb()
    const rows = await wrap<RecentEntry[]>(db.transaction(META).objectStore(META).getAll())
    return rows
      .map(({ id, name, size, openedAt }) => ({ id, name, size, openedAt }))
      .sort((a, b) => b.openedAt - a.openedAt)
  } catch {
    resetDb()
    return []
  }
}

/** Зберігає (або оновлює за іменем+розміром) файл і прибирає найстаріші понад ліміти. */
export async function saveRecent(name: string, data: ArrayBuffer): Promise<void> {
  try {
    const size = data.byteLength
    if (size === 0 || size > MAX_FILE_BYTES) return
    const db = await openDb()
    const tx = db.transaction([META, BLOBS], 'readwrite')
    const done = txDone(tx)
    done.catch(() => {}) // відхилення обробляє await done нижче
    const meta = tx.objectStore(META)
    const blobs = tx.objectStore(BLOBS)

    const existing = await wrap<RecentEntry[]>(meta.getAll())
    const same = existing.find((e) => e.name === name && e.size === size)
    const id = same?.id ?? newId()
    const openedAt = Math.max(Date.now(), ...existing.map((e) => e.openedAt + 1))
    const entry: RecentEntry = { id, name, size, openedAt }
    meta.put(entry)
    blobs.put(data, id)

    const all = [...existing.filter((e) => e.id !== id), entry]
    for (const evictId of pickEvictions(all, { maxCount: MAX_ENTRIES, maxTotalBytes: MAX_TOTAL_BYTES })) {
      meta.delete(evictId)
      blobs.delete(evictId)
    }
    await done
  } catch {
    resetDb()
    // IndexedDB недоступний або квоту вичерпано: «нещодавні» просто не працюють.
  }
}

/** Повертає вміст і піднімає запис угору списку. */
export async function loadRecent(id: string): Promise<{ name: string; data: ArrayBuffer } | null> {
  try {
    const db = await openDb()
    const tx = db.transaction([META, BLOBS], 'readwrite')
    const done = txDone(tx)
    done.catch(() => {})
    const meta = tx.objectStore(META)
    const entry = await wrap<RecentEntry | undefined>(meta.get(id))
    const data = await wrap<ArrayBuffer | undefined>(tx.objectStore(BLOBS).get(id))
    if (!entry || !data) {
      await done
      return null
    }
    meta.put({ ...entry, openedAt: Date.now() })
    await done
    return { name: entry.name, data }
  } catch {
    resetDb()
    return null
  }
}

export async function removeRecent(id: string): Promise<void> {
  try {
    const db = await openDb()
    const tx = db.transaction([META, BLOBS], 'readwrite')
    tx.objectStore(META).delete(id)
    tx.objectStore(BLOBS).delete(id)
    await txDone(tx)
  } catch {
    resetDb()
    // ігноруємо
  }
}

export async function clearRecent(): Promise<void> {
  try {
    const db = await openDb()
    const tx = db.transaction([META, BLOBS], 'readwrite')
    tx.objectStore(META).clear()
    tx.objectStore(BLOBS).clear()
    await txDone(tx)
  } catch {
    resetDb()
    // ігноруємо
  }
}
