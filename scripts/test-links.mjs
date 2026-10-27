// Тест звʼязків «файл → відео YouTube» (links.ts) без браузера, на in-memory моку IndexedDB.
// Запуск: node --experimental-strip-types scripts/test-links.mjs
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

// Код застосунку імпортує модулі без розширення (як вимагає tsconfig); дописуємо .ts для Node.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.(ts|js|mjs|json)(\?.*)?$/.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context)
    }
    return nextResolve(specifier, context)
  },
})

let failed = 0
async function test(name, fn) {
  try {
    await fn()
    console.log('ok   ', name)
  } catch (e) {
    failed++
    console.error('FAIL ', name, '\n', e)
  }
}

// --- мінімальний мок IndexedDB (лише те, що використовує recent.ts) ---
function createMockIndexedDB() {
  const stores = new Map() // name -> {keyPath, map}
  let version = 0
  const tick = (fn) => queueMicrotask(fn)
  function makeTx(names) {
    const tx = { oncomplete: null, onerror: null, onabort: null, error: null }
    let pending = 0
    const settle = () => {
      if (pending === 0) {
        setTimeout(() => {
          if (pending === 0) tx.oncomplete?.()
        }, 0)
      }
    }
    const request = (work) => {
      const req = { result: undefined, error: null, onsuccess: null, onerror: null }
      pending++
      tick(() => {
        req.result = work()
        req.onsuccess?.()
        pending--
        settle()
      })
      return req
    }
    tx.objectStore = (name) => {
      if (!names.includes(name)) throw new Error('NotFoundError')
      const s = stores.get(name)
      const keyOf = (v, k) => (s.keyPath ? v[s.keyPath] : k)
      return {
        get: (k) => request(() => s.map.get(k)),
        getAll: () => request(() => [...s.map.values()]),
        put: (v, k) => request(() => (s.map.set(keyOf(v, k), v), keyOf(v, k))),
        delete: (k) => request(() => void s.map.delete(k)),
        clear: () => request(() => void s.map.clear()),
      }
    }
    // порожня транзакція теж завершується
    settle()
    return tx
  }
  return {
    stores,
    open() {
      const req = { result: null, error: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null }
      setTimeout(() => {
        const db = {
          objectStoreNames: { contains: (n) => stores.has(n) },
          createObjectStore: (n, opts) => stores.set(n, { keyPath: opts?.keyPath, map: new Map() }),
          transaction: (names) => makeTx(Array.isArray(names) ? names : [names]),
          close() {},
          onversionchange: null,
        }
        req.result = db
        if (version === 0) {
          version = 1
          req.onupgradeneeded?.()
        }
        req.onsuccess?.()
      }, 0)
      return req
    },
  }
}

let n = 0
const fresh = () => import(`../src/lib/storage/links.ts?${n++}`)
const sp = (i) => ({ barIndex: i, barPosition: 0.5, barOccurence: 0, millisecondOffset: i * 1000 })

// --- відмова IndexedDB ---
async function degrades(label, setup) {
  await test(`відмова IndexedDB: ${label}`, async () => {
    setup()
    const l = await fresh()
    assert.equal(await l.getLink('a.gp', 10), null)
    await l.saveLink('a.gp', 10, { videoId: 'v', syncPoints: [sp(0)] })
    await l.removeLink('a.gp', 10)
  })
}
await degrades('indexedDB відсутній', () => { delete globalThis.indexedDB })
await degrades('open() кидає виняток', () => {
  globalThis.indexedDB = { open() { throw new Error('SecurityError') } }
})

// --- на in-memory моку (з монотонним Date.now, щоб updatedAt були різні) ---
globalThis.indexedDB = createMockIndexedDB()
let clock = 1_000_000
Date.now = () => ++clock
const l = await fresh()
const rows = () => globalThis.indexedDB.stores.get('yt-links').map

await test('linkKey: розмір + імʼя', () => {
  assert.equal(l.linkKey('a.gp', 10), '10:a.gp')
})
await test('getLink невідомого → null', async () => {
  assert.equal(await l.getLink('nope.gp', 1), null)
})
await test('save + get: круговий обхід', async () => {
  const points = [sp(0), sp(3)]
  await l.saveLink('a.gp', 10, { videoId: 'abc', syncPoints: points })
  const got = await l.getLink('a.gp', 10)
  assert.equal(got.videoId, 'abc')
  assert.deepEqual(got.syncPoints, points)
  assert.equal(typeof got.updatedAt, 'number')
  assert.deepEqual(Object.keys(rows().get('10:a.gp')).sort(), ['key', 'syncPoints', 'updatedAt', 'videoId'])
})
await test('синхроточки копіюються у прості обʼєкти', async () => {
  class Fake { constructor(i) { Object.assign(this, sp(i)); this.extra = () => 1 } }
  await l.saveLink('cls.gp', 5, { videoId: 'x', syncPoints: [new Fake(2)] })
  const stored = rows().get('5:cls.gp').syncPoints[0]
  assert.equal(Object.getPrototypeOf(stored), Object.prototype)
  assert.deepEqual(stored, sp(2))
})
await test('upsert за імʼям+розміром замінює й піднімає updatedAt', async () => {
  await l.saveLink('u.gp', 7, { videoId: 'one', syncPoints: [sp(0)] })
  const first = await l.getLink('u.gp', 7)
  const before = rows().size
  await l.saveLink('u.gp', 7, { videoId: 'two', syncPoints: [] })
  const second = await l.getLink('u.gp', 7)
  assert.equal(rows().size, before)
  assert.equal(second.videoId, 'two')
  assert.deepEqual(second.syncPoints, [])
  assert.ok(second.updatedAt > first.updatedAt)
})
await test('інший розмір = інший ключ', async () => {
  await l.saveLink('s.gp', 1, { videoId: 'v1', syncPoints: [] })
  await l.saveLink('s.gp', 2, { videoId: 'v2', syncPoints: [] })
  assert.equal((await l.getLink('s.gp', 1)).videoId, 'v1')
  assert.equal((await l.getLink('s.gp', 2)).videoId, 'v2')
})
await test('removeLink', async () => {
  await l.saveLink('r.gp', 3, { videoId: 'v', syncPoints: [] })
  await l.removeLink('r.gp', 3)
  assert.equal(await l.getLink('r.gp', 3), null)
  await l.removeLink('r.gp', 3) // повторне видалення не падає
})
await test('MAX_LINKS: видаляє найстаріші', async () => {
  rows().clear()
  const total = l.MAX_LINKS + 3
  for (let i = 0; i < total; i++) await l.saveLink(`f${i}.gp`, i, { videoId: `v${i}`, syncPoints: [] })
  assert.equal(rows().size, l.MAX_LINKS)
  for (let i = 0; i < 3; i++) assert.equal(await l.getLink(`f${i}.gp`, i), null)
  assert.equal((await l.getLink('f3.gp', 3)).videoId, 'v3')
  assert.equal((await l.getLink(`f${total - 1}.gp`, total - 1)).videoId, `v${total - 1}`)
})

if (failed) {
  console.error(`\n${failed} тест(ів) провалено`)
  process.exit(1)
}
console.log('\nУсі тести пройдено')
