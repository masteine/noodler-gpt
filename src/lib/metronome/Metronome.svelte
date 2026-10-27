<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { getAudioContext } from '../audio'
  import { session } from '../session.svelte'
  import { Metronome, TapTempo, BPM_MIN, BPM_MAX, type BeatEvent } from './metronome'
  import Icon from '../ui/Icon.svelte'
  import { t, type Key } from '../i18n/index.svelte'

  const signatures = [
    { n: 2, d: 4 },
    { n: 3, d: 4 },
    { n: 4, d: 4 },
    { n: 5, d: 4 },
    { n: 6, d: 8 },
    { n: 7, d: 8 },
    { n: 12, d: 8 },
  ]
  const subdivisions: { v: number; label: Key }[] = [
    { v: 1, label: 'metro.sub.1' },
    { v: 2, label: 'metro.sub.2' },
    { v: 3, label: 'metro.sub.3' },
    { v: 4, label: 'metro.sub.4' },
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

  const sig = $derived(signatures[sigIndex])
  /** Темп табу задано у чвертях; у розмірах із вісімками рахуємо клік на восьму. */
  const tabBpm = $derived(
    session.tabTempo === null ? null : clampBpm(session.tabTempo * (sig.d / 4)),
  )

  /** Класичні позначки темпу; назви італійські в усіх мовах. */
  const TEMPO_MARKS = [
    { name: 'Largo', from: 0 },
    { name: 'Adagio', from: 66 },
    { name: 'Andante', from: 76 },
    { name: 'Moderato', from: 108 },
    { name: 'Allegro', from: 120 },
    { name: 'Presto', from: 168 },
  ]
  const tempoMark = $derived(TEMPO_MARKS.findLast((m) => bpm >= m.from)?.name ?? 'Largo')

  const shortcuts: [string, Key][] = [
    ['keys.space', 'keys.startStop'],
    ['↑ ↓', 'keys.tempo1'],
    ['Shift + ↑ ↓', 'keys.tempo5'],
    ['T', 'keys.tapTempo'],
  ]

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
  <header class="m-head">
    <h1>{t('mode.metronome')}</h1>
    {#if tabBpm !== null}
      <button class="btn from-tab" onclick={useTabTempo} title={session.tabTitle}>
        <Icon name="music" size={16} />
        {t('metro.fromTab')} · <span class="mono accent">{tabBpm}</span>
      </button>
    {/if}
  </header>

  <div class="layout">
    <section class="main-card" aria-label={t('metro.tempo')}>
      <div
        class="beats"
        class:many={sig.n > 6}
        style:grid-template-columns="repeat({sig.n}, minmax(0, 1fr))"
        aria-label={activeBeat >= 0 ? t('metro.beatOf', { n: activeBeat + 1, total: sig.n }) : undefined}
      >
        {#each { length: sig.n } as _, i (i)}
          <div class="beat mono" class:on={activeBeat === i} class:first={i === 0 && accent}>{i + 1}</div>
        {/each}
      </div>

      <div class="tempo-row">
        <button class="small-step mono d-only" onclick={() => setBpm(bpm - 5)} aria-label={t('metro.minus', { n: 5 })}>−5</button>
        <button class="round" onclick={() => setBpm(bpm - 1)} aria-label={t('metro.minus', { n: 1 })}>
          <Icon name="minus" size={24} stroke={2.2} />
        </button>
        <div class="value">
          <input
            class="mono"
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
          <div class="unit"><span class="mono">BPM</span> · {tempoMark}</div>
        </div>
        <button class="round" onclick={() => setBpm(bpm + 1)} aria-label={t('metro.plus', { n: 1 })}>
          <Icon name="plus" size={24} stroke={2.2} />
        </button>
        <button class="small-step mono d-only" onclick={() => setBpm(bpm + 5)} aria-label={t('metro.plus', { n: 5 })}>+5</button>
      </div>

      <div class="slider-block">
        <div class="slider-row">
          <button class="small-step mono m-only" onclick={() => setBpm(bpm - 5)} aria-label={t('metro.minus', { n: 5 })}>−5</button>
          <label class="slider">
            <span class="sr-only">{t('metro.tempo')}</span>
            <input
              type="range"
              min={BPM_MIN}
              max={BPM_MAX}
              value={bpm}
              oninput={(e) => setBpm(Number((e.currentTarget as HTMLInputElement).value))}
            />
          </label>
          <button class="small-step mono m-only" onclick={() => setBpm(bpm + 5)} aria-label={t('metro.plus', { n: 5 })}>+5</button>
        </div>
        <div class="marks d-only" aria-hidden="true">
          {#each TEMPO_MARKS as m (m.name)}
            <span class:current={m.name === tempoMark}>{m.name}</span>
          {/each}
        </div>
      </div>

      <div class="actions">
        <button class="start" onclick={toggle}>
          <Icon name={running ? 'stop' : 'play'} size={20} />
          {running ? t('metro.stop') : t('metro.start')}
        </button>
        <button class="tap" onclick={tap} title={t('metro.tapTitle')}>
          Tap
          <span>{t('metro.tapHint')}</span>
        </button>
      </div>
    </section>

    <div class="side">
      <div class="panel tab-tempo d-only">
        <div class="tile"><Icon name="music" size={20} /></div>
        <div class="tab-text">
          <div class="tab-label">{t('metro.tabTempoLabel')}</div>
          {#if tabBpm !== null}
            <div class="tab-value">{session.tabTitle} · <span class="mono">♩ {tabBpm}</span></div>
          {:else}
            <div class="tab-none">{t('metro.noTab')}</div>
          {/if}
        </div>
        {#if tabBpm !== null}
          <button class="btn" onclick={useTabTempo}>{t('metro.take')}</button>
        {/if}
      </div>

      <div class="panel settings">
        <div class="group">
          <span class="glabel">{t('metro.signature')}</span>
          <div class="chips" role="group" aria-label={t('metro.signature')}>
            {#each signatures as s, i (i)}
              <button class="chip mono" aria-pressed={sigIndex === i} onclick={() => (sigIndex = i)}>{s.n}/{s.d}</button>
            {/each}
          </div>
        </div>
        <div class="group">
          <span class="glabel">{t('metro.subdivisions')}</span>
          <div class="seg fill" role="group" aria-label={t('metro.subdivisions')}>
            {#each subdivisions as s (s.v)}
              <button aria-pressed={subdivision === s.v} onclick={() => (subdivision = s.v)}>{t(s.label)}</button>
            {/each}
          </div>
        </div>
        <div class="line">
          <span id="metro-accent" class="grow">{t('metro.accent')}</span>
          <button class="switch" role="switch" aria-checked={accent} aria-labelledby="metro-accent" onclick={() => (accent = !accent)}></button>
        </div>
        <label class="line">
          <span>{t('metro.volume')}</span>
          <input type="range" min="0" max="100" bind:value={volume} />
        </label>
      </div>

      <div class="panel keys d-only">
        {#each shortcuts as [k, label] (k)}
          <div class="key-row"><span>{t(label)}</span><kbd>{k.startsWith('keys.') ? t(k as Key) : k}</kbd></div>
        {/each}
      </div>
    </div>
  </div>
</div>

<style>
  .metro {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding: 32px 24px 40px;
  }

  .m-head,
  .m-only {
    display: none;
  }

  .layout {
    max-width: 1240px;
    margin: 0 auto;
    display: flex;
    flex-wrap: wrap;
    gap: 24px;
    align-items: flex-start;
  }

  .main-card {
    flex: 2 1 560px;
    min-width: 0;
    padding: 40px 32px;
    border-radius: 24px;
    background: var(--card);
    border: 1px solid var(--line);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 32px;
  }

  .beats {
    width: 100%;
    max-width: 520px;
    display: grid;
    gap: 14px;
  }

  .beats.many {
    max-width: 640px;
    gap: 8px;
  }

  .beat {
    height: 76px;
    border-radius: 18px;
    background: var(--surface-2);
    border: 1px solid var(--line-2);
    color: var(--faint);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 24px;
    font-weight: 700;
    transition: background 0.06s, box-shadow 0.06s;
  }

  .beats.many .beat {
    height: 60px;
    border-radius: 12px;
    font-size: 16px;
  }

  .beat.first {
    color: var(--accent-ink);
  }

  .beat.on {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--on-accent);
    transition: none;
  }

  .beat.first.on {
    box-shadow: 0 0 0 6px color-mix(in srgb, var(--accent) 15%, transparent);
  }

  .tempo-row {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 16px;
    flex-wrap: wrap;
  }

  .small-step {
    width: 56px;
    height: 48px;
    flex: none;
    border-radius: 12px;
    background: var(--surface-3);
    color: var(--text-2);
    font-size: 15px;
  }

  .round {
    width: 64px;
    height: 64px;
    flex: none;
    border-radius: 50%;
    border: 1px solid var(--line-2);
    background: var(--surface-2);
    color: var(--text);
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  .value {
    min-width: 300px;
    text-align: center;
  }

  .value input {
    width: 3.3ch;
    padding: 0;
    font-size: 168px;
    font-weight: 700;
    line-height: 1;
    letter-spacing: -0.06em;
    text-align: center;
    color: var(--text);
    background: transparent;
    border: none;
    border-radius: 12px;
    -moz-appearance: textfield;
    appearance: textfield;
  }

  .value input::-webkit-outer-spin-button,
  .value input::-webkit-inner-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }

  .unit {
    margin-top: 8px;
    font-size: 15px;
    color: var(--muted);
  }

  .slider-block {
    width: 100%;
    max-width: 620px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .slider-row {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .slider {
    flex: 1;
    display: flex;
  }

  .slider input {
    width: 100%;
    margin: 0;
  }

  .marks {
    display: flex;
    justify-content: space-between;
    font-size: 12px;
    color: var(--faint);
  }

  .marks .current {
    color: var(--accent-ink);
    font-weight: 600;
  }

  .actions {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
    justify-content: center;
  }

  .start {
    width: 240px;
    height: 60px;
    border-radius: 16px;
    background: var(--accent);
    color: var(--on-accent);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    font-size: 17px;
    font-weight: 700;
  }

  .tap {
    width: 160px;
    height: 60px;
    border-radius: 16px;
    border: 1px solid var(--line-2);
    background: var(--surface-2);
    color: var(--text);
    display: inline-flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
    font-size: 16px;
    font-weight: 600;
  }

  .tap span {
    font-size: 11px;
    font-weight: 500;
    color: var(--faint);
  }

  .tap:active {
    background: var(--accent-soft);
  }

  .side {
    flex: 1 1 340px;
    max-width: 420px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .tab-tempo {
    padding: 16px;
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .tile {
    width: 40px;
    height: 40px;
    flex: none;
    border-radius: 10px;
    background: var(--surface-3);
    color: var(--accent-ink);
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .tab-text {
    flex: 1;
    min-width: 0;
  }

  .tab-label {
    font-size: 12px;
    color: var(--faint);
  }

  .tab-value {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tab-none {
    font-size: 13px;
    color: var(--muted);
  }

  .settings {
    display: flex;
    flex-direction: column;
  }

  .group {
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    border-bottom: 1px solid var(--line);
  }

  .glabel {
    font-size: 13px;
    color: var(--muted);
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .chip {
    height: 36px;
    padding: 0 10px;
    border-radius: 9px;
    border: 1px solid var(--line-2);
    color: var(--text-2);
    font-size: 13px;
  }

  .chip[aria-pressed='true'] {
    border-color: var(--accent);
    background: var(--accent-soft);
    color: var(--accent-ink);
    font-weight: 700;
  }

  .group .seg {
    border: 0;
    background: var(--input);
  }

  .group .seg > button {
    font-size: 13px;
  }

  .line {
    padding: 8px 16px;
    min-height: 56px;
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .line + .line {
    border-top: 1px solid var(--line);
  }

  .line input {
    flex: 1;
    min-width: 0;
    margin: 0;
  }

  .grow {
    flex: 1;
  }

  .keys {
    padding: 16px;
    background: transparent;
    display: flex;
    flex-direction: column;
    gap: 10px;
    font-size: 13px;
    color: var(--muted);
  }

  .key-row {
    display: flex;
    justify-content: space-between;
    gap: 12px;
  }

  /* Підписи в словнику з малої літери (їх вставляють і в речення), тут — як заголовок. */
  .key-row > span::first-letter {
    text-transform: uppercase;
  }

  /* Телефон: свій заголовок, кнопки ±5 біля слайдера, без підказок клавіатури. */
  @media (max-width: 720px) {
    .metro {
      padding: 0 16px 16px;
    }

    .d-only {
      display: none;
    }

    .m-only {
      display: inline-block;
    }

    .m-head {
      height: 60px;
      display: flex;
      align-items: center;
      gap: 10px;
    }

    h1 {
      flex: 1;
      margin: 0;
      font-size: 22px;
      font-weight: 700;
      letter-spacing: -0.02em;
    }

    .from-tab {
      border-radius: 12px;
      font-size: 13px;
      color: var(--text-2);
    }

    .accent {
      color: var(--accent-ink);
    }

    /* nowrap: інакше рядок флексу розтягується під ряд кнопок розміру й вилазить за екран. */
    .layout {
      flex-direction: column;
      flex-wrap: nowrap;
      align-items: stretch;
      gap: 20px;
    }

    .main-card {
      flex: none;
      padding: 12px 0 0;
      border: 0;
      background: transparent;
      gap: 20px;
      align-items: stretch;
    }

    .beats {
      gap: 10px;
    }

    .beat {
      height: 52px;
      border-radius: 14px;
      font-size: 18px;
    }

    .beats.many .beat {
      height: 44px;
      border-radius: 10px;
      font-size: 13px;
    }

    .beat.first.on {
      box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 20%, transparent);
    }

    .tempo-row {
      justify-content: space-between;
      flex-wrap: nowrap;
      gap: 8px;
    }

    .round {
      width: 56px;
      height: 56px;
    }

    .value {
      min-width: 0;
    }

    .value input {
      font-size: 104px;
      letter-spacing: -0.05em;
    }

    .unit {
      margin-top: 6px;
      font-size: 13px;
    }

    .small-step {
      width: 48px;
      height: 40px;
      border-radius: 10px;
      font-size: 13px;
    }

    .actions {
      flex-wrap: nowrap;
      gap: 10px;
    }

    .start {
      flex: 1;
      width: auto;
    }

    .tap {
      width: 104px;
      font-size: 15px;
    }

    .side {
      max-width: none;
      min-width: 0;
      flex: none;
    }

    .chips {
      flex-wrap: nowrap;
      overflow-x: auto;
      scrollbar-width: none;
    }

    .chip {
      flex: none;
    }

    .group {
      padding: 12px 14px;
    }

    .line {
      padding: 8px 14px;
      min-height: 52px;
    }
  }
</style>
