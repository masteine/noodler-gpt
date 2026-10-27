// Спільне зʼєднання з IndexedDB для всіх сховищ застосунку («нещодавні», звʼязки з відео).
// Помилки тут НЕ ковтаються: це роблять споживачі, щоб безпечно деградувати.

export const DB_NAME = 'noodler'
export const DB_VERSION = 2
/** Метадані й вміст «нещодавніх» у різних сховищах, щоб список читався без завантаження файлів. */
export const RECENT_META = 'recent-meta'
export const RECENT_BLOBS = 'recent-data'
/** Звʼязки «файл Guitar Pro → відео YouTube + точки синхронізації». */
export const LINKS = 'yt-links'

let dbPromise: Promise<IDBDatabase> | null = null

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  const p = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    // Створюємо лише відсутні сховища: так працюють і чиста інсталяція, і оновлення v1 → v2.
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(RECENT_META)) db.createObjectStore(RECENT_META, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(RECENT_BLOBS)) db.createObjectStore(RECENT_BLOBS)
      if (!db.objectStoreNames.contains(LINKS)) db.createObjectStore(LINKS, { keyPath: 'key' })
    }
    req.onsuccess = () => {
      const db = req.result
      db.onversionchange = () => {
        db.close()
        dbPromise = null
      }
      resolve(db)
    }
    req.onerror = () => reject(req.error)
    req.onblocked = () => reject(new Error('IndexedDB заблоковано'))
  })
  dbPromise = p
  p.catch(() => {
    if (dbPromise === p) dbPromise = null
  })
  return p
}

/** Скидає кешоване зʼєднання (після збою, напр. закрите зʼєднання): наступний виклик відкриє нове. */
export function resetDb(): void {
  dbPromise = null
}

export function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error ?? new Error('Транзакцію скасовано'))
  })
}
