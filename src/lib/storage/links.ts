// Звʼязки «файл Guitar Pro → відео YouTube + точки синхронізації» в IndexedDB.
// Як і в recent.ts, усі функції безпечно деградують: помилки ковтаються.
// alphaTab тут не імпортуємо: використовуємо структурний тип.
import { openDb, resetDb, wrap, txDone, LINKS } from './db'

export interface FlatSyncPointLike {
  barIndex: number
  barPosition: number
  barOccurence: number
  millisecondOffset: number
}

export interface BackingLink {
  videoId: string
  syncPoints: FlatSyncPointLike[]
  updatedAt: number
}

interface LinkRow extends BackingLink {
  key: string
}

export const MAX_LINKS = 200

/** Ідентичність файлу така сама, як у «нещодавніх»: імʼя + розмір. */
export function linkKey(name: string, size: number): string {
  return `${size}:${name}`
}

/** Копія у прості обʼєкти: проксі Svelte та класи alphaTab не можна класти в IndexedDB. */
function plain(points: FlatSyncPointLike[]): FlatSyncPointLike[] {
  return points.map((p) => ({
    barIndex: p.barIndex,
    barPosition: p.barPosition,
    barOccurence: p.barOccurence,
    millisecondOffset: p.millisecondOffset,
  }))
}

export async function getLink(name: string, size: number): Promise<BackingLink | null> {
  try {
    const db = await openDb()
    const row = await wrap<LinkRow | undefined>(db.transaction(LINKS).objectStore(LINKS).get(linkKey(name, size)))
    if (!row) return null
    return { videoId: row.videoId, syncPoints: plain(row.syncPoints ?? []), updatedAt: row.updatedAt }
  } catch {
    resetDb()
    return null
  }
}

/** Зберігає (upsert) звʼязок і прибирає найстаріші понад MAX_LINKS. */
export async function saveLink(
  name: string,
  size: number,
  link: { videoId: string; syncPoints: FlatSyncPointLike[] },
): Promise<void> {
  try {
    const key = linkKey(name, size)
    const row: LinkRow = { key, videoId: String(link.videoId), syncPoints: plain(link.syncPoints), updatedAt: Date.now() }
    const db = await openDb()
    const tx = db.transaction(LINKS, 'readwrite')
    const done = txDone(tx)
    done.catch(() => {}) // відхилення обробляє await done нижче
    const store = tx.objectStore(LINKS)
    store.put(row)
    const all = await wrap<LinkRow[]>(store.getAll())
    const rest = all.filter((r) => r.key !== key)
    if (rest.length + 1 > MAX_LINKS) {
      rest.sort((a, b) => a.updatedAt - b.updatedAt)
      for (const old of rest.slice(0, rest.length + 1 - MAX_LINKS)) store.delete(old.key)
    }
    await done
  } catch {
    resetDb()
    // IndexedDB недоступний або квоту вичерпано: звʼязки просто не запамʼятовуються.
  }
}

export async function removeLink(name: string, size: number): Promise<void> {
  try {
    const db = await openDb()
    const tx = db.transaction(LINKS, 'readwrite')
    tx.objectStore(LINKS).delete(linkKey(name, size))
    await txDone(tx)
  } catch {
    resetDb()
    // ігноруємо
  }
}
