// Тест детекції висоти тону на синтетичних сигналах (без браузера і мікрофона).
// Запуск: node --experimental-strip-types scripts/test-pitch.mjs
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

// Код застосунку імпортує модулі без розширення; дописуємо .ts для Node.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.(ts|js|mjs|json)(\?.*)?$/.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context)
    }
    return nextResolve(specifier, context)
  },
})

const { detectPitch, frequencyToNote, noteToFrequency, midiToName } = await import('../src/lib/tuner/pitch.ts')
const { TUNINGS, nearestString } = await import('../src/lib/tuner/tunings.ts')
const { PitchSmoother } = await import('../src/lib/tuner/smoother.ts')

const N = 8192
const FREQS = [41.2, 82.4, 110, 196, 329.6, 440]
const RATES = [44100, 48000]

// Детермінований генератор випадкових чисел (mulberry32), щоб тест був повторюваним.
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Сума гармонік amps[k-1]·sin(2π k f t + φ), обмежена частотою Найквіста. */
function harmonic(freq, rate, amps, phase = 0.3, n = N) {
  const out = new Float32Array(n)
  for (let k = 1; k <= amps.length; k++) {
    if (k * freq >= rate / 2) break
    const w = (2 * Math.PI * k * freq) / rate
    for (let i = 0; i < n; i++) out[i] += amps[k - 1] * Math.sin(w * i + phase * k)
  }
  return out
}

const sine = (f, r) => harmonic(f, r, [0.5])
const saw = (f, r) => harmonic(f, r, Array.from({ length: 12 }, (_, i) => 0.5 / (i + 1)))
// Гітароподібний спектр: гармоніки спадають експоненційно, друга сильніша за основну.
const guitar = (f, r) => harmonic(f, r, [0.25, 0.4, 0.3, 0.15, 0.1, 0.05])

function addNoise(sig, amplitude, seed) {
  const rand = rng(seed)
  const out = new Float32Array(sig.length)
  for (let i = 0; i < sig.length; i++) out[i] = sig[i] + (rand() * 2 - 1) * amplitude
  return out
}

const centsOff = (got, want) => 1200 * Math.log2(got / want)

let failed = 0
let passed = 0
function test(name, fn) {
  try {
    fn()
    passed++
    console.log('ok   ', name)
  } catch (e) {
    failed++
    console.error('FAIL ', name, '\n    ', e.message)
  }
}

function expectPitch(buf, rate, want, tol) {
  const r = detectPitch(buf, rate)
  assert.ok(r, `не знайдено тон (очікувалось ${want} Гц)`)
  const c = centsOff(r.frequency, want)
  assert.ok(Math.abs(c) <= tol, `${r.frequency.toFixed(3)} Гц замість ${want} (${c.toFixed(2)} ц, допуск ±${tol}), clarity ${r.clarity.toFixed(3)}`)
}

// --- Чисті сигнали: ±2 цента ---
for (const rate of RATES) {
  for (const f of FREQS) {
    test(`sine ${f} Гц @${rate}`, () => expectPitch(sine(f, rate), rate, f, 2))
    test(`saw ${f} Гц @${rate}`, () => expectPitch(saw(f, rate), rate, f, 2))
    test(`guitar-like ${f} Гц @${rate}`, () => expectPitch(guitar(f, rate), rate, f, 2))
  }
}

// --- З шумом: допуск ширший (±5 центів) ---
for (const rate of RATES) {
  for (const f of FREQS) {
    // Шум 0.05 при сигналі ~0.5 амплітуди: приблизно 15–20 дБ SNR.
    test(`saw+noise ${f} Гц @${rate}`, () => expectPitch(addNoise(saw(f, rate), 0.1, f * 7), rate, f, 5))
    test(`sine+noise ${f} Гц @${rate}`, () => expectPitch(addNoise(sine(f, rate), 0.1, f * 3), rate, f, 5))
  }
}

// --- Межі діапазону ---
for (const rate of RATES) {
  test(`B0 30.87 Гц sine @${rate}`, () => expectPitch(sine(30.87, rate), rate, 30.87, 3))
  test(`B0 30.87 Гц saw @${rate}`, () => expectPitch(saw(30.87, rate), rate, 30.87, 3))
  test(`1000 Гц sine @${rate}`, () => expectPitch(sine(1000, rate), rate, 1000, 3))
  test(`1174.7 Гц (D6) saw @${rate}`, () => expectPitch(saw(1174.7, rate), rate, 1174.7, 3))
  test(`слабка основна 82.4 Гц @${rate}`, () =>
    expectPitch(harmonic(82.4, rate, [0.15, 0.5, 0.4, 0.3, 0.2]), rate, 82.4, 3))
  test(`DC-зсув не заважає 110 Гц @${rate}`, () => {
    const s = saw(110, rate)
    for (let i = 0; i < s.length; i++) s[i] += 0.2
    expectPitch(s, rate, 110, 2)
  })
  test(`тихий сигнал (амплітуда 0.02) 196 Гц @${rate}`, () => {
    const s = sine(196, rate).map((v) => v * 0.04)
    expectPitch(s, rate, 196, 2)
  })
}

// --- Тиша і шум -> null ---
for (const rate of RATES) {
  test(`тиша @${rate}`, () => assert.equal(detectPitch(new Float32Array(N), rate), null))
  test(`ледь чутний шум @${rate}`, () => assert.equal(detectPitch(addNoise(new Float32Array(N), 0.004, 1), rate), null))
  for (const amp of [0.05, 0.3, 1]) {
    for (const seed of [1, 2, 3, 4, 5]) {
      test(`білий шум amp ${amp} seed ${seed} @${rate}`, () =>
        assert.equal(detectPitch(addNoise(new Float32Array(N), amp, seed * 100 + amp * 10), rate), null))
    }
  }
}

// --- Ноти ---
test('frequencyToNote: A4 = 440', () => {
  const n = frequencyToNote(440)
  assert.equal(n.name, 'A')
  assert.equal(n.octave, 4)
  assert.equal(n.midi, 69)
  assert.ok(Math.abs(n.cents) < 1e-9)
  assert.equal(n.targetFreq, 440)
})
test('frequencyToNote: E2 82.41, B0 30.87, drop C', () => {
  assert.equal(frequencyToNote(82.41).name + frequencyToNote(82.41).octave, 'E2')
  assert.equal(frequencyToNote(30.87).name + frequencyToNote(30.87).octave, 'B0')
  assert.equal(midiToName(36), 'C2')
})
test('frequencyToNote: відхилення у центах і калібрування A4', () => {
  const sharp = frequencyToNote(440 * 2 ** (20 / 1200))
  assert.ok(Math.abs(sharp.cents - 20) < 1e-6)
  const flat = frequencyToNote(440 * 2 ** (-30 / 1200))
  assert.ok(Math.abs(flat.cents + 30) < 1e-6)
  const cal = frequencyToNote(432, 432)
  assert.equal(cal.name, 'A')
  assert.ok(Math.abs(cal.cents) < 1e-9)
  assert.ok(Math.abs(noteToFrequency(69, 432) - 432) < 1e-9)
  assert.ok(Math.abs(noteToFrequency(40) - 82.4069) < 1e-3)
})

// --- Строї ---
test('nearestString: Standard', () => {
  const std = TUNINGS.find((t) => t.id === 'standard')
  assert.deepEqual(std.midi, [40, 45, 50, 55, 59, 64])
  const r = nearestString(std.midi, 110.5)
  assert.equal(r.index, 1)
  assert.equal(r.midi, 45)
  assert.ok(r.cents > 0 && r.cents < 15)
  assert.equal(nearestString(std.midi, 329.6).index, 5)
  // Піввідстані між A2 і D3 нижче середини -> A2.
  assert.equal(nearestString(std.midi, 120).index, 1)
})
test('nearestString: порівняння на шкалі центів, а не герців', () => {
  const std = TUNINGS.find((t) => t.id === 'standard')
  // 100 Гц ближче до A2 (110) за відношенням, ніж до E2 (82.4)? 100/82.4 = 3.7 пів-тону, 110/100 = 1.65.
  assert.equal(nearestString(std.midi, 100).index, 1)
})
test('пресети: усі потрібні строї на місці', () => {
  const ids = TUNINGS.map((t) => t.id)
  for (const id of ['standard', 'drop-d', 'eb', 'd-standard', 'drop-c', 'open-g', 'dadgad', 'bass4', 'bass5']) {
    assert.ok(ids.includes(id), id)
  }
  assert.deepEqual(TUNINGS.find((t) => t.id === 'bass5').midi, [23, 28, 33, 38, 43])
  assert.deepEqual(TUNINGS.find((t) => t.id === 'drop-c').midi, [36, 43, 48, 53, 57, 62])
})

// --- Згладжування ---
const hit = (f) => ({ frequency: f, clarity: 0.95 })
test('smoother: медіана відсікає поодинокий викид (октавна помилка)', () => {
  const sm = new PitchSmoother(5, 400)
  let out
  for (const [i, f] of [110, 110.2, 220, 109.9, 110.1].entries()) out = sm.push(hit(f), i * 33)
  assert.ok(Math.abs(centsOff(out.frequency, 110)) < 5, String(out.frequency))
  assert.equal(out.held, false)
})
test('smoother: утримує ноту ~400 мс, потім скидає', () => {
  const sm = new PitchSmoother(5, 400)
  sm.push(hit(82.4), 0)
  const held = sm.push(null, 300)
  assert.equal(held.held, true)
  assert.ok(Math.abs(held.frequency - 82.4) < 1e-6)
  assert.equal(sm.push(null, 500), null)
  // Після скидання історія порожня: нова нота не змішується зі старою.
  const fresh = sm.push(hit(440), 600)
  assert.ok(Math.abs(fresh.frequency - 440) < 1e-6)
})
test('smoother: перехід на нову ноту за 3 виміри', () => {
  const sm = new PitchSmoother(5, 400)
  let out
  for (let i = 0; i < 5; i++) out = sm.push(hit(110), i * 33)
  for (let i = 0; i < 3; i++) out = sm.push(hit(146.8), 200 + i * 33)
  assert.ok(Math.abs(centsOff(out.frequency, 146.8)) < 1)
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
