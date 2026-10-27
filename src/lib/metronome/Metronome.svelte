<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { getAudioContext } from '../audio'
  import { session } from '../session.svelte'
  import { Metronome, TapTempo, BPM_MIN, BPM_MAX, type BeatEvent } from './metronome'

  const signatures = [
    { n: 2, d: 4 },
    { n: 3, d: 4 },
    { n: 4, d: 4 },
    { n: 5, d: 4 },
    { n: 6, d: 8 },
    { n: 7, d: 8 },
    { n: 12, d: 8 },
  ]
  const subdivisions = [
    { v: 1, label: 'Долі' },
    { v: 2, label: 'Восьмі' },
    { v: 3, label: 'Тріолі' },
    { v: 4, label: '16-ті' },
  ]

  // $state.raw: ефект нижче має перезапуститися, коли onMount створить метроном.
  let metro = $state.raw<Metronome>()
  const tapper = new TapTempo()

  // Налаштування живуть у спільному стані, щоб переживати перехід на іншу вкладку.
  const saved = session.metronome
  let bpm = $state(saved.bpm)
  let sigIndex = $state(saved.sigIndex)
  let subdivision = $state(saved.subdivision)
  let accent = $state(saved.accent)
  let volume = $state(saved.volume)
  let running = $state(false)
  let activeBeat = $state(-1)
  let flash = $state(false)

  const sig = $derived(signatures[sigIndex])
  /** Темп табу задано у чвертях; у розмірах із вісімками рахуємо клік на восьму. */
  const tabBpm = $derived(
    session.tabTempo === null ? null : clampBpm(session.tabTempo * (sig.d / 4)),
  )

  function clampBpm(v: number) {
    return Math.min(BPM_MAX, Math.max(BPM_MIN, Math.round(v)))
  }

  $effect(() => {
    session.metronome = { bpm, sigIndex, subdivision, accent, volume }
  })

  // Параметри передаємо у метроном щоразу, коли вони змінюються. Зміни діють з наступного кліку.
  $effect(() => {
    if (!metro) return
    metro.bpm = bpm
    metro.beatsPerBar = sig.n
    metro.beatUnit = sig.d
    metro.subdivision = subdivision
    metro.accentFirstBeat = accent
    metro.volume = volume / 100
  })

  onMount(() => {
    metro = new Metronome(getAudioContext())
    metro.onStateChange = (r) => {
      running = r
      if (!r) activeBeat = -1
    }
    metro.onBeat = (e: BeatEvent) => {
      if (e.sub !== 0) return
      activeBeat = e.beat
      flash = true
      setTimeout(() => (flash = false), 90)
    }
    window.addEventListener('keydown', onKey)
  })

  onDestroy(() => {
    window.removeEventListener('keydown', onKey)
    metro?.destroy()
  })

  function toggle() {
    // AudioContext створюється під час жесту користувача (клік або клавіша).
    metro?.toggle()
  }

  function setBpm(v: number) {
    bpm = clampBpm(v)
  }

  function tap() {
    const v = tapper.tap()
    if (v !== null) bpm = v
  }

  function useTabTempo() {
    if (tabBpm !== null) bpm = tabBpm
  }

  function onKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement | null
    if (t && ['INPUT', 'SELECT', 'TEXTAREA'].includes(t.tagName)) return
    if (e.ctrlKey || e.metaKey || e.altKey) return
    if (e.repeat && (e.code === 'Space' || e.code === 'KeyT')) return
    // Пробіл на сфокусованій кнопці має натискати саму кнопку.
    if (e.code === 'Space' && t?.closest('button, a')) return
    if (e.code === 'Space') {
      e.preventDefault()
      toggle()
    } else if (e.code === 'ArrowUp') {
      e.preventDefault()
      setBpm(bpm + (e.shiftKey ? 5 : 1))
    } else if (e.code === 'ArrowDown') {
      e.preventDefault()
      setBpm(bpm - (e.shiftKey ? 5 : 1))
    } else if (e.code === 'KeyT') {
      tap()
    }
  }
</script>

<div class="metro">
  <div class="beacon" class:flash class:accent={flash && activeBeat === 0 && accent} aria-hidden="true"></div>

  <div class="bpm">
    <button class="step" onclick={() => setBpm(bpm - 5)} aria-label="−5 BPM">−5</button>
    <button class="step" onclick={() => setBpm(bpm - 1)} aria-label="−1 BPM">−</button>
    <div class="value">
      <input
        type="number"
        min={BPM_MIN}
        max={BPM_MAX}
        value={bpm}
        aria-label="BPM"
        onchange={(e) => {
          const el = e.currentTarget as HTMLInputElement
          if (el.value !== '') setBpm(Number(el.value))
          el.value = String(bpm)
        }}
      />
      <span class="unit">BPM</span>
    </div>
    <button class="step" onclick={() => setBpm(bpm + 1)} aria-label="+1 BPM">+</button>
    <button class="step" onclick={() => setBpm(bpm + 5)} aria-label="+5 BPM">+5</button>
  </div>

  <input
    class="slider"
    type="range"
    min={BPM_MIN}
    max={BPM_MAX}
    value={bpm}
    aria-label="Темп"
    oninput={(e) => setBpm(Number((e.currentTarget as HTMLInputElement).value))}
  />

  <div class="dots" aria-hidden="true">
    {#each { length: sig.n } as _, i (i)}
      <span class="dot" class:on={activeBeat === i} class:first={i === 0 && accent}></span>
    {/each}
  </div>

  <div class="actions">
    <button class="primary start" onclick={toggle}>{running ? '⏸ Стоп' : '▶ Старт'}</button>
    <button class="tap" onclick={tap} title="Клавіша T">Tap</button>
    <button onclick={useTabTempo} disabled={tabBpm === null} title={session.tabTitle}>
      {#if tabBpm === null}
        Темп із табу
      {:else}
        Взяти темп із табу ({tabBpm})
      {/if}
    </button>
  </div>

  <div class="options">
    <label>
      <span>Розмір</span>
      <select bind:value={sigIndex}>
        {#each signatures as s, i (i)}
          <option value={i}>{s.n}/{s.d}</option>
        {/each}
      </select>
    </label>

    <div class="seg" role="group" aria-label="Підрозділи">
      {#each subdivisions as s (s.v)}
        <button class:active={subdivision === s.v} aria-pressed={subdivision === s.v} onclick={() => (subdivision = s.v)}>{s.label}</button>
      {/each}
    </div>

    <label class="check">
      <input type="checkbox" bind:checked={accent} />
      <span>Акцент на першу долю</span>
    </label>

    <label class="vol">
      <span>Гучність</span>
      <input type="range" min="0" max="100" bind:value={volume} />
    </label>
  </div>

  <p class="hint muted">Пробіл — старт/стоп · ↑ ↓ — темп (Shift ±5) · T — tap</p>
</div>

<style>
  .metro {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 20px;
    padding: 24px 16px calc(24px + env(safe-area-inset-bottom));
  }

  .beacon {
    width: 120px;
    height: 120px;
    border-radius: 50%;
    border: 3px solid var(--border);
    background: var(--panel);
    transition: background 0.12s, border-color 0.12s;
    flex: 0 0 auto;
  }

  .beacon.flash {
    background: var(--accent);
    border-color: var(--accent);
    transition: none;
  }

  .beacon.accent {
    background: var(--danger);
    border-color: var(--danger);
  }

  .bpm {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .step {
    min-width: 48px;
    min-height: 48px;
    font-size: 18px;
  }

  .value {
    display: flex;
    flex-direction: column;
    align-items: center;
    min-width: 140px;
  }

  .value input {
    width: 140px;
    font: inherit;
    font-size: 64px;
    font-weight: 700;
    line-height: 1;
    text-align: center;
    color: inherit;
    background: transparent;
    border: none;
    outline: none;
    border-radius: var(--radius);
    font-variant-numeric: tabular-nums;
    -moz-appearance: textfield;
    appearance: textfield;
  }

  .value input:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 4px;
  }

  .value input::-webkit-outer-spin-button,
  .value input::-webkit-inner-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }

  .unit {
    color: var(--muted);
    font-size: 13px;
    letter-spacing: 0.1em;
  }

  .slider {
    width: min(480px, 100%);
  }

  .dots {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 10px;
    min-height: 24px;
  }

  .dot {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: var(--border);
  }

  .dot.first {
    outline: 2px solid var(--danger);
    outline-offset: 2px;
  }

  .dot.on {
    background: var(--accent);
  }

  .dot.first.on {
    background: var(--danger);
  }

  .actions,
  .options {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    align-items: center;
    gap: 10px 14px;
  }

  .start {
    min-width: 130px;
    min-height: 52px;
    font-size: 18px;
  }

  .tap {
    min-width: 88px;
    min-height: 52px;
    font-size: 18px;
  }

  label {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .check input {
    width: 20px;
    height: 20px;
    accent-color: var(--accent);
  }

  .seg {
    display: flex;
  }

  .seg button {
    border-radius: 0;
    margin-left: -1px;
  }

  .seg button:first-child {
    border-radius: var(--radius) 0 0 var(--radius);
    margin-left: 0;
  }

  .seg button:last-child {
    border-radius: 0 var(--radius) var(--radius) 0;
  }

  .muted {
    color: var(--muted);
    font-size: 14px;
    margin: 0;
  }
</style>
