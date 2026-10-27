// Тест «нещодавніх файлів» без браузера: чиста pickEvictions + recent.ts на in-memory моку IndexedDB.
// Запуск: node --experimental-strip-types scripts/test-recent.mjs
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

const { pickEvictions } = await import('../src/lib/storage/evict.ts')

const MB = 1024 * 1024
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

// --- pickEvictions ---
const lim = { maxCount: 12, maxTotalBytes: 50 * MB }
const mk = (i, size = 1 * MB) => ({ id: `e${i}`, size, openedAt: i })

await test('pickEvictions: до ліміту нічого не видаляє', () => {
  assert.deepEqual(pickEvictions(Array.from({ length: 12 }, (_, i) => mk(i)), lim), [])
})
await test('pickEvictions: ліміт 12 записів, видаляє найстаріші', () => {
  const out = pickEvictions(Array.from({ length: 15 }, (_, i) => mk(i)), lim)
  assert.deepEqual(out.sort(), ['e0', 'e1', 'e2'])
})
await test('pickEvictions: ліміт 50 МБ', () => {
  // 4 x 20 МБ: лишаються 2 найновіші (40 МБ), старіші не вміщуються
  const entries = Array.from({ length: 4 }, (_, i) => mk(i, 20 * MB))
  assert.deepEqual(pickEvictions(entries, lim).sort(), ['e0', 'e1'])
})
await test('pickEvictions: рівно 50 МБ вміщується', () => {
  assert.deepEqual(pickEvictions([mk(1, 25 * MB), mk(2, 25 * MB)], lim), [])
})
await test('pickEvictions: порядок вхідних даних не важливий', () => {
  const entries = [mk(5), mk(1), mk(3)]
  assert.deepEqual(pickEvictions(entries, { maxCount: 2, maxTotalBytes: 50 * MB }), ['e1'])
})
await test('pickEvictions: найновіший не видаляється навіть понад ліміт розміру', () => {
  assert.deepEqual(pickEvictions([mk(1, 60 * MB), mk(0, 1)], lim), ['e0'])
})

// --- recent.ts: відмова IndexedDB (кожен сценарій у свіжому модулі) ---
let n = 0
const fresh = () => import(`../src/lib/storage/recent.ts?${n++}`)
const buf = (size, fill = 1) => new Uint8Array(size).fill(fill).buffer

async function degrades(label, setup) {
  await test(`відмова IndexedDB: ${label}`, async () => {
    setup()
    const r = await fresh()
    assert.deepEqual(await r.listRecent(), [])
    await r.saveRecent('a.gp', buf(10))
    assert.equal(await r.loadRecent('x'), null)
    await r.removeRecent('x')
    await r.clearRecent()
  })
}
await degrades('indexedDB відсутній', () => { delete globalThis.indexedDB })
await degrades('open() кидає виняток', () => {
  globalThis.indexedDB = { open() { throw new Error('SecurityError') } }
})
await degrades('open() завершується помилкою', () => {
  globalThis.indexedDB = {
    open() {
      const req = { error: new Error('denied'), onerror: null }
      setTimeout(() => req.onerror?.(), 0)
      return req
    },
  }
})
await degrades('transaction() кидає виняток', () => {
  globalThis.indexedDB = {
    open() {
      const req = { result: null, error: null, onsuccess: null, onupgradeneeded: null }
      setTimeout(() => {
        req.result = {
          objectStoreNames: { contains: () => true },
          transaction() { throw new Error('InvalidStateError') },
        }
        req.onsuccess?.()
      }, 0)
      return req
    },
  }
})

// --- recent.ts на in-memory моку ---
globalThis.indexedDB = createMockIndexedDB()
const r = await fresh()

await test('save/list/load: основний сценарій', async () => {
  await r.clearRecent()
  assert.deepEqual(await r.listRecent(), [])
  await r.saveRecent('a.gp', buf(100, 7))
  await r.saveRecent('b.gp', buf(200))
  const list = await r.listRecent()
  assert.deepEqual(list.map((e) => e.name), ['b.gp', 'a.gp'])
  assert.deepEqual(list.map((e) => e.size), [200, 100])
  const loaded = await r.loadRecent(list[1].id)
  assert.equal(loaded.name, 'a.gp')
  assert.equal(new Uint8Array(loaded.data)[0], 7)
  // load піднімає запис угору
  assert.deepEqual((await r.listRecent()).map((e) => e.name), ['a.gp', 'b.gp'])
})
await test('upsert за іменем+розміром', async () => {
  await r.clearRecent()
  await r.saveRecent('a.gp', buf(100))
  await r.saveRecent('b.gp', buf(100))
  await r.saveRecent('a.gp', buf(100))
  await r.saveRecent('a.gp', buf(101)) // інший розмір = інший запис
  const list = await r.listRecent()
  assert.deepEqual(list.map((e) => `${e.name}:${e.size}`), ['a.gp:101', 'a.gp:100', 'b.gp:100'])
})
await test('ліміт 12 записів', async () => {
  await r.clearRecent()
  for (let i = 0; i < 15; i++) await r.saveRecent(`f${i}.gp`, buf(10 + i))
  const list = await r.listRecent()
  assert.equal(list.length, 12)
  assert.equal(list[0].name, 'f14.gp')
  assert.equal(list.at(-1).name, 'f3.gp')
  // вміст видалених теж прибрано
  assert.equal(globalThis.indexedDB.stores.get('recent-data').map.size, 12)
})
await test('ліміт сумарного розміру 50 МБ', async () => {
  await r.clearRecent()
  for (let i = 0; i < 4; i++) await r.saveRecent(`big${i}.gp`, buf(15 * MB, i))
  const list = await r.listRecent()
  assert.deepEqual(list.map((e) => e.name), ['big3.gp', 'big2.gp', 'big1.gp'])
  assert.equal(globalThis.indexedDB.stores.get('recent-data').map.size, 3)
})
await test('файли > 20 МБ не зберігаються', async () => {
  await r.clearRecent()
  await r.saveRecent('huge.gp', buf(20 * MB + 1))
  assert.deepEqual(await r.listRecent(), [])
  await r.saveRecent('edge.gp', buf(20 * MB))
  assert.equal((await r.listRecent()).length, 1)
})
await test('removeRecent / clearRecent / loadRecent неіснуючого', async () => {
  await r.clearRecent()
  await r.saveRecent('a.gp', buf(5))
  await r.saveRecent('b.gp', buf(6))
  const [first] = await r.listRecent()
  await r.removeRecent(first.id)
  assert.deepEqual((await r.listRecent()).map((e) => e.name), ['a.gp'])
  assert.equal(await r.loadRecent(first.id), null)
  await r.clearRecent()
  assert.deepEqual(await r.listRecent(), [])
})

if (failed) {
  console.error(`\n${failed} тест(ів) провалено`)
  process.exit(1)
}
console.log('\nУсі тести пройдено')
