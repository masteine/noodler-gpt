<script lang="ts">
  import { onDestroy } from 'svelte'
  import { PitchTracker } from './mic'
  import { frequencyToNote, midiToParts, noteToFrequency } from './pitch'
  import type { PitchReading } from './smoother'
  import { ReferenceTone } from './reference-tone'
  import { TUNINGS, nearestString, type Tuning } from './tunings'

  let { tabTuning = null }: { tabTuning?: { name: string; midi: number[] } | null } = $props()

  const A4_MIN = 430
  const A4_MAX = 450
  const IN_TUNE_CENTS = 5
  const KEY_A4 = 'noodler.tuner.a4'
  const KEY_TUNING = 'noodler.tuner.tuning'

  function loadA4(): number {
    try {
      const v = Number(localStorage.getItem(KEY_A4))
      if (Number.isFinite(v) && v >= A4_MIN && v <= A4_MAX) return v
    } catch {
      // сховище недоступне (приватний режим тощо)
    }
    return 440
  }

  function loadTuningId(): string {
    try {
      const v = localStorage.getItem(KEY_TUNING)
      if (v && TUNINGS.some((t) => t.id === v)) return v
    } catch {
      // сховище недоступне
    }
    return 'chromatic'
  }

  function save(key: string, value: string) {
    try {
      localStorage.setItem(key, value)
    } catch {
      // сховище недоступне
    }
  }

  const tracker = new PitchTracker()
  const tone = new ReferenceTone()

  let listening = $state(false)
  let starting = $state(false)
  let error = $state<string | null>(null)
  let reading = $state<PitchReading | null>(null)

  let a4 = $state(loadA4())
  /** 'chromatic' | id пресету | 'tab' (копія строю доріжки табу). */
  let tuningId = $state(loadTuningId())
  let tabCopy = $state<Tuning | null>(null)
  /** Струни, які вже були в строї (лишаються зеленими, поки їх не розстроять). */
  let tuned = $state<boolean[]>([])
  /** Струна, обрана для еталонного тону. */
  let selected = $state<number | null>(null)
  let toneOn = $state(false)

  const tuning = $derived<Tuning | null>(
    tuningId === 'tab' ? tabCopy : (TUNINGS.find((t) => t.id === tuningId) ?? null),
  )

  const view = $derived.by(() => {
    if (!reading) return null
    if (tuning) {
      const m = nearestString(tuning.midi, reading.frequency, a4)
      return { ...midiToParts(m.midi), cents: m.cents, stringIndex: m.index }
    }
    const n = frequencyToNote(reading.frequency, a4)
    return { name: n.name, octave: n.octave, cents: n.cents, stringIndex: -1 }
  })

  const inTune = $derived(view !== null && Math.abs(view.cents) <= IN_TUNE_CENTS)
  const gaugePos = $derived(view ? Math.min(50, Math.max(-50, view.cents)) + 50 : 50)
  const centsText = $derived(
    view ? `${view.cents > 0 ? '+' : ''}${Math.round(view.cents)} ¢` : '',
  )
  const status = $derived(
    !view ? '' : inTune ? 'У строї' : view.cents < 0 ? 'Занизько: підтягніть' : 'Зависоко: послабте',
  )

  /** Що грає кнопка «Еталон»: обрана струна строю або A4. */
  const refTarget = $derived.by(() => {
    if (tuning && selected !== null && selected < tuning.midi.length) {
      const { name, octave } = midiToParts(tuning.midi[selected])
      return { label: `${name}${octave}`, freq: noteToFrequency(tuning.midi[selected], a4) }
    }
    return { label: 'A4', freq: a4 }
  })

  tracker.onReading = (r) => {
    reading = r
    if (!r || r.held || toneOn || !tuning) return
    const m = nearestString(tuning.midi, r.frequency, a4)
    if (Math.abs(m.cents) <= IN_TUNE_CENTS) tuned[m.index] = true
    else if (Math.abs(m.cents) > 15) tuned[m.index] = false
  }
  tracker.onEnded = () => {
    listening = false
    reading = null
    error = 'Мікрофон відключився. Увімкніть його знову.'
  }
  tone.onEnd = () => {
    toneOn = false
  }

  onDestroy(() => {
    tracker.onReading = () => {}
    tracker.onEnded = () => {}
    tracker.stop()
    tone.destroy()
  })

  async function startMic() {
    error = null
    starting = true
    try {
      await tracker.start()
      listening = tracker.active
    } catch (e) {
      error = e instanceof Error ? e.message : 'Не вдалося увімкнути мікрофон.'
    } finally {
      starting = false
    }
  }

  function stopMic() {
    tracker.stop()
    listening = false
    reading = null
  }

  function resetTuning(id: string) {
    tuningId = id
    tuned = []
    selected = null
    tone.stop()
    if (id !== 'tab') save(KEY_TUNING, id)
  }

  function useTabTuning() {
    if (!tabTuning) return
    tabCopy = { id: 'tab', name: tabTuning.name, midi: [...tabTuning.midi] }
    resetTuning('tab')
  }

  function setA4(v: number) {
    a4 = Math.min(A4_MAX, Math.max(A4_MIN, Math.round(v)))
    save(KEY_A4, String(a4))
  }

  function playTone(freq: number) {
    if (toneOn) {
      tone.stop()
    } else {
      tone.play(freq)
      toneOn = true
    }
  }

  function pickString(i: number) {
    if (!tuning) return
    const same = selected === i
    selected = i
    if (toneOn && !same) tone.stop()
    playTone(noteToFrequency(tuning.midi[i], a4))
  }
</script>

<div class="tuner">
  <div class="top">
    {#if listening}
      <button class="mic" onclick={stopMic}>Вимкнути мікрофон</button>
    {:else}
      <button class="primary mic" onclick={startMic} disabled={starting}>
        {starting ? 'Очікуємо дозвіл…' : 'Увімкнути мікрофон'}
      </button>
    {/if}
  </div>

  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}

  <div class="readout" class:ok={inTune} class:held={reading?.held}>
    <div class="note" aria-live="polite">
      {#if view}
        {view.name}<sub>{view.octave}</sub>
      {:else}
        <span class="idle">♪</span>
      {/if}
    </div>
    <div class="freq">
      {reading ? reading.frequency.toFixed(1) : '—'} <span class="unit">Гц</span>
    </div>
  </div>

  <div class="gauge-wrap">
    <div
      class="gauge"
      class:ok={inTune}
      class:held={reading?.held}
      role="meter"
      aria-label="Відхилення в центах"
      aria-valuemin={-50}
      aria-valuemax={50}
      aria-valuenow={view ? Math.round(gaugePos - 50) : 0}
    >
      <div class="zone"></div>
      {#each [-50, -25, 0, 25, 50] as t (t)}
        <span class="tick" class:zero={t === 0} style:left="{t + 50}%"></span>
        <span class="tick-label" style:left="{t + 50}%">{t > 0 ? `+${t}` : t}</span>
      {/each}
      {#if view}
        <div class="needle" style:left="{gaugePos}%"><span class="arrow"></span></div>
      {/if}
    </div>
    <div class="cents" class:ok={inTune}>
      <span class="cents-value">{centsText || ' '}</span>
      <span class="status">{status || ' '}</span>
    </div>
  </div>

  <div class="mode">
    <label>
      <span>Режим</span>
      <select value={tuningId} onchange={(e) => resetTuning((e.currentTarget as HTMLSelectElement).value)}>
        <option value="chromatic">Хроматичний</option>
        {#each TUNINGS as t (t.id)}
          <option value={t.id}>{t.name}</option>
        {/each}
        {#if tabCopy}
          <option value="tab">Із табу: {tabCopy.name}</option>
        {/if}
      </select>
    </label>
    {#if tabTuning}
      <button onclick={useTabTuning} title="Стрій активної доріжки табу">
        Взяти стрій із табу ({tabTuning.name})
      </button>
    {/if}
  </div>

  {#if tuning}
    <div class="strings" role="group" aria-label="Струни строю">
      {#each tuning.midi as m, i (i)}
        {@const p = midiToParts(m)}
        <button
          class="str"
          class:tuned={tuned[i]}
          class:hit={view?.stringIndex === i && !reading?.held}
          class:active={selected === i}
          onclick={() => pickString(i)}
          aria-label="Струна {p.name}{p.octave}{tuned[i] ? ', у строї' : ''}"
          title="Натисніть, щоб почути струну"
        >
          {p.name}<sub>{p.octave}</sub>
        </button>
      {/each}
    </div>
  {/if}

  <div class="extras">
    <button onclick={() => playTone(refTarget.freq)} class:active={toneOn}>
      {toneOn ? '■ Стоп' : '▶ Еталон'}
      {refTarget.label} · {refTarget.freq.toFixed(1)} Гц
    </button>

    <div class="calib">
      <span class="calib-label">A4</span>
      <button class="step" onclick={() => setA4(a4 - 1)} aria-label="A4 нижче" disabled={a4 <= A4_MIN}>−</button>
      <input
        type="range"
        min={A4_MIN}
        max={A4_MAX}
        step="1"
        value={a4}
        aria-label="Калібрування A4, Гц"
        oninput={(e) => setA4(Number((e.currentTarget as HTMLInputElement).value))}
      />
      <button class="step" onclick={() => setA4(a4 + 1)} aria-label="A4 вище" disabled={a4 >= A4_MAX}>+</button>
      <span class="calib-value">{a4} Гц</span>
      <button onclick={() => setA4(440)} disabled={a4 === 440}>440</button>
    </div>
  </div>

  <p class="hint">
    {#if listening}
      Грайте струни по одній і дайте їм дзвеніти. Зелений колір: відхилення не більше {IN_TUNE_CENTS} центів.
    {:else}
      Мікрофон вмикається лише за вашим натисканням; звук не записується й нікуди не надсилається.
    {/if}
  </p>
</div>

<style>
  .tuner {
    --ok: #1a9c4b;
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 18px;
    padding: 20px 16px calc(24px + env(safe-area-inset-bottom));
  }

  @media (prefers-color-scheme: dark) {
    .tuner {
      --ok: #3ddc84;
    }
  }

  .mic {
    min-height: 52px;
    min-width: 220px;
    font-size: 18px;
  }

  .error {
    margin: 0;
    max-width: 520px;
    padding: 10px 14px;
    border: 1px solid var(--danger);
    border-radius: var(--radius);
    color: var(--danger);
    text-align: center;
  }

  .readout {
    display: flex;
    flex-direction: column;
    align-items: center;
    line-height: 1;
    transition: color 0.12s, opacity 0.2s;
  }

  .readout.ok {
    color: var(--ok);
  }

  .readout.held {
    opacity: 0.45;
  }

  .note {
    font-size: clamp(96px, 26vw, 200px);
    font-weight: 700;
    min-height: 1em;
  }

  .note .idle {
    color: var(--border);
    font-weight: 400;
  }

  .note sub {
    font-size: 0.32em;
    font-weight: 600;
    vertical-align: baseline;
    margin-left: 0.05em;
    color: var(--muted);
  }

  .freq {
    margin-top: 6px;
    font-size: 26px;
    font-variant-numeric: tabular-nums;
  }

  .unit {
    color: var(--muted);
    font-size: 16px;
  }

  .gauge-wrap {
    width: min(640px, 100%);
    padding: 0 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .gauge {
    position: relative;
    height: 56px;
    margin: 0 14px 22px;
    border-radius: var(--radius);
    background: var(--panel);
    border: 2px solid var(--border);
    transition: border-color 0.12s;
  }

  .gauge.ok {
    border-color: var(--ok);
  }

  .zone {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 45%;
    width: 10%;
    background: color-mix(in srgb, var(--ok) 28%, transparent);
  }

  .tick {
    position: absolute;
    bottom: 0;
    width: 2px;
    height: 12px;
    margin-left: -1px;
    background: var(--muted);
  }

  .tick.zero {
    height: 100%;
    background: var(--ok);
    opacity: 0.6;
  }

  .tick-label {
    position: absolute;
    top: 100%;
    margin-top: 4px;
    transform: translateX(-50%);
    font-size: 12px;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }

  .needle {
    position: absolute;
    top: -2px;
    bottom: -2px;
    width: 4px;
    margin-left: -2px;
    border-radius: 2px;
    background: var(--accent);
    transition: left 0.12s ease-out, background 0.12s;
  }

  .gauge.ok .needle {
    background: var(--ok);
  }

  .gauge.held .needle {
    opacity: 0.45;
  }

  /* Стрілка над шкалою, що вказує вниз на поточне відхилення. */
  .arrow {
    position: absolute;
    left: 50%;
    top: -14px;
    transform: translateX(-50%);
    border-left: 10px solid transparent;
    border-right: 10px solid transparent;
    border-top: 14px solid var(--accent);
  }

  .gauge.ok .arrow {
    border-top-color: var(--ok);
  }

  .cents {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
  }

  .cents-value {
    font-size: 30px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  .status {
    color: var(--muted);
    font-size: 16px;
  }

  .cents.ok .cents-value,
  .cents.ok .status {
    color: var(--ok);
  }

  .mode,
  .extras {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    align-items: center;
    gap: 10px 14px;
  }

  label {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .strings {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 12px;
  }

  .str {
    width: 64px;
    height: 64px;
    min-height: 64px;
    padding: 0;
    border-radius: 50%;
    border-width: 2px;
    font-size: 20px;
    font-weight: 600;
    transition: background 0.12s, border-color 0.12s, color 0.12s, transform 0.12s;
  }

  .str sub {
    font-size: 0.6em;
    font-weight: 500;
  }

  .str.hit {
    border-color: var(--accent);
    transform: scale(1.12);
  }

  .str.tuned {
    background: var(--ok);
    border-color: var(--ok);
    color: #fff;
  }

  .calib {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .calib-label {
    font-weight: 600;
  }

  .calib input[type='range'] {
    width: 140px;
  }

  .calib-value {
    min-width: 56px;
    font-variant-numeric: tabular-nums;
  }

  .step {
    min-width: 40px;
  }

  .hint {
    margin: 0;
    max-width: 520px;
    text-align: center;
    color: var(--muted);
    font-size: 14px;
  }
</style>
