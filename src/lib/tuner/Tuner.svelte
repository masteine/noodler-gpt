<script lang="ts">
  import { onDestroy } from 'svelte'
  import { MicError, PitchTracker } from './mic'
  import { frequencyToNote, midiToParts, noteToFrequency } from './pitch'
  import type { PitchReading } from './smoother'
  import { ReferenceTone } from './reference-tone'
  import { TUNINGS, nearestString, type Tuning } from './tunings'
  import Icon from '../ui/Icon.svelte'
  import { t, type Key } from '../i18n/index.svelte'

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
  /** Ключ повідомлення, а не готовий текст: при зміні мови помилка перекладається. */
  let error = $state<{ key: Key; detail?: string } | null>(null)
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
  /** ±50 центів розкладено на дугу ±80°. */
  const DEG_PER_CENT = 1.6
  const needleAngle = $derived(view ? Math.min(50, Math.max(-50, view.cents)) * DEG_PER_CENT : 0)
  const centsText = (c: number) => t('tuner.cents', { c: `${c > 0 ? '+' : c < 0 ? '−' : ''}${Math.abs(Math.round(c))}` })
  const status = $derived.by(() => {
    if (!view) return ''
    const c = view.cents
    if (inTune) return t('tuner.inTune')
    if (Math.abs(c) <= 15) return c < 0 ? t('tuner.slightlyLow') : t('tuner.slightlyHigh')
    return c < 0 ? t('tuner.low') : t('tuner.high')
  })
  const pill = $derived(
    view ? `${centsText(view.cents)} · ${status}` : listening ? t('tuner.playString') : t('tuner.idle'),
  )

  /** Точка на дузі шкали (центр 150,150) під кутом deg від вертикалі. */
  function arcPoint(deg: number, r: number): [number, number] {
    const a = (deg * Math.PI) / 180
    return [150 + r * Math.sin(a), 150 - r * Math.cos(a)]
  }
  const arc = (from: number, to: number, r: number) => {
    const [x1, y1] = arcPoint(from, r)
    const [x2, y2] = arcPoint(to, r)
    return `M${x1.toFixed(1)} ${y1.toFixed(1)} A${r} ${r} 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)}`
  }
  const TICKS = [-80, -64, -48, -32, -16, 16, 32, 48, 64, 80].map((d) => [arcPoint(d, 118), arcPoint(d, 106)])

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
    error = { key: 'mic.ended' }
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
      if (e instanceof MicError && e.code !== 'unknown') error = { key: `mic.${e.code}` }
      else if (e instanceof Error && e.message) error = { key: 'mic.unknownDetail', detail: e.message }
      else error = { key: 'mic.unknown' }
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

  const freqOf = (m: number) => noteToFrequency(m, a4).toFixed(2)

  /** Пресети з перекладною назвою (басові); решта — загальноприйняті англійські назви строїв. */
  const tuningNames: Record<string, Key> = { bass4: 'tuner.bass4', bass5: 'tuner.bass5' }
  const tuningName = (x: Tuning) => (tuningNames[x.id] ? t(tuningNames[x.id]) : x.name)

  function pickString(i: number) {
    if (!tuning) return
    const same = selected === i
    selected = i
    if (toneOn && !same) tone.stop()
    playTone(noteToFrequency(tuning.midi[i], a4))
  }
</script>

{#snippet tuningSelect(mobileRow: boolean)}
  <label class="tuning" class:mobile-row={mobileRow}>
    <span>{t('tuner.mode')}</span>
    <select value={tuningId} onchange={(e) => resetTuning((e.currentTarget as HTMLSelectElement).value)}>
      <option value="chromatic">{t('tuner.chromatic')}</option>
      {#each TUNINGS as preset (preset.id)}
        <option value={preset.id}>{tuningName(preset)}</option>
      {/each}
      {#if tabCopy}
        <option value="tab">{t('tuner.fromTab', { name: tabCopy.name })}</option>
      {/if}
    </select>
  </label>
{/snippet}

{#snippet refRow(iconOnly: boolean)}
  <div class="panel ref">
    <span class="ref-label">{t('tuner.ref')}</span>
    <button class="step" onclick={() => setA4(a4 - 1)} aria-label={t('tuner.a4Lower')} disabled={a4 <= A4_MIN}>
      <Icon name="minus" size={16} />
    </button>
    <button class="ref-value mono" onclick={() => setA4(440)} title="440 {t('tuner.hz')}" aria-label={t('tuner.a4Aria')}>{a4} {t('tuner.hz')}</button>
    <button class="step" onclick={() => setA4(a4 + 1)} aria-label={t('tuner.a4Higher')} disabled={a4 >= A4_MAX}>
      <Icon name="plus" size={16} />
    </button>
    <button
      class="step tone"
      class:wide={!iconOnly}
      aria-pressed={toneOn}
      onclick={() => playTone(refTarget.freq)}
      aria-label={t('tuner.playTone', { note: refTarget.label })}
      title={t('tuner.playTone', { note: refTarget.label })}
    >
      <Icon name={toneOn ? 'stop' : 'play'} size={12} />
      {#if !iconOnly}{t('tuner.tone')}{/if}
    </button>
  </div>
{/snippet}

{#snippet micButton()}
  {#if listening}
    <button class="mic" onclick={stopMic}>
      <Icon name="mic" />
      {t('tuner.micOff')}
    </button>
  {:else}
    <button class="mic on" onclick={startMic} disabled={starting}>
      <Icon name="mic" />
      {starting ? t('tuner.waiting') : t('tuner.micOn')}
    </button>
  {/if}
{/snippet}

<div class="tuner">
  <header class="m-head">
    <h1>{t('mode.tuner')}</h1>
    {#if listening}
      <span class="live"><span class="live-dot"></span>{t('tuner.listening')}</span>
    {/if}
  </header>

  <div class="layout">
    <section class="main-card" aria-label={t('tuner.pitchAria')}>
      <div class="m-only">{@render tuningSelect(true)}</div>

      {#if error}
        <p class="error-box" role="alert">{t(error.key, { detail: error.detail ?? '' })}</p>
      {/if}

      <div class="readout" class:held={reading?.held}>
        <div class="note" aria-live="polite">
          {#if view}
            <span class="letter">{view.name}</span><span class="octave mono">{view.octave}</span>
          {:else}
            <span class="letter idle">—</span>
          {/if}
        </div>
        <div class="pill-row">
          <span class="pill" class:ok={inTune} class:neutral={!view}>{pill}</span>
          {#if reading}<span class="freq mono">{reading.frequency.toFixed(1)} {t('tuner.hz')}</span>{/if}
        </div>
      </div>

      <svg
        class="gauge"
        class:ok={inTune}
        class:idle={!view}
        class:held={reading?.held}
        viewBox="0 0 300 160"
        role="meter"
        aria-label={t('tuner.centsAria')}
        aria-valuemin={-50}
        aria-valuemax={50}
        aria-valuenow={view ? Math.round(view.cents) : 0}
      >
        <path d={arc(-80, 80, 112)} class="track" />
        <path d={arc(-IN_TUNE_CENTS * DEG_PER_CENT, IN_TUNE_CENTS * DEG_PER_CENT, 112)} class="zone" />
        <g class="ticks">
          {#each TICKS as [[x1, y1], [x2, y2]], i (i)}
            <line {x1} {y1} {x2} {y2} />
          {/each}
        </g>
        <line x1="150" y1="30" x2="150" y2="46" class="zero" />
        <text x="26" y="152" class="lbl mono">−50</text>
        <text x="150" y="21" class="lbl mono" text-anchor="middle">0</text>
        <text x="274" y="152" class="lbl mono" text-anchor="end">+50</text>
        <text x="96" y="130" class="lbl side" text-anchor="middle">{t('tuner.flat')}</text>
        <text x="204" y="130" class="lbl side" text-anchor="middle">{t('tuner.sharp')}</text>
        <g class="needle" style:transform="rotate({needleAngle}deg)">
          <line x1="150" y1="150" x2="150" y2="50" />
        </g>
        <circle cx="150" cy="150" r="7" class="hub" />
        <circle cx="150" cy="150" r="2.5" class="hub-in" />
      </svg>

      <div class="m-only m-stack">
        {#if tuning}
          <div class="str-grid" role="group" aria-label={t('tuner.stringsAria')} style:grid-template-columns="repeat({tuning.midi.length}, minmax(0, 1fr))">
            {#each tuning.midi as m, i (i)}
              {@const p = midiToParts(m)}
              {@const n = tuning.midi.length - i}
              <button
                class="str-tile"
                class:tuned={tuned[i]}
                class:hit={view?.stringIndex === i && !reading?.held}
                aria-pressed={selected === i}
                onclick={() => pickString(i)}
                aria-label={t(tuned[i] ? 'tuner.stringInTune' : 'tuner.stringAria', { n, note: `${p.name}${p.octave}` })}
              >
                <span class="tile-note">{p.name}</span>
                <span class="tile-num mono">{n}{tuned[i] ? ' ✓' : ''}</span>
              </button>
            {/each}
          </div>
        {/if}
        {@render refRow(true)}
        {@render micButton()}
        <p class="tiny">{t('tuner.privacyShort')}</p>
      </div>
    </section>

    <div class="side d-only">
      <div class="panel strings-panel">
        <div class="strings-head">{@render tuningSelect(false)}</div>
        {#if tuning}
          <div class="str-list" role="group" aria-label={t('tuner.stringsAria')}>
            {#each tuning.midi as m, i (i)}
              {@const p = midiToParts(m)}
              {@const n = tuning.midi.length - i}
              {@const hit = view?.stringIndex === i && !reading?.held}
              <button
                class="str-row"
                class:hit
                class:tuned={tuned[i]}
                aria-pressed={selected === i}
                onclick={() => pickString(i)}
                aria-label={t(tuned[i] ? 'tuner.stringInTune' : 'tuner.stringAria', { n, note: `${p.name}${p.octave}` })}
                title={t('tuner.stringTitle')}
              >
                <span class="row-num mono">{n}</span>
                <span class="row-note">{p.name}{p.octave}</span>
                <span class="row-freq mono">{freqOf(m)} {t('tuner.hz')}</span>
                {#if hit && view}
                  <span class="row-state" class:ok={inTune}>{inTune ? t('tuner.stringOk') : centsText(view.cents)}</span>
                {:else if tuned[i]}
                  <span class="row-state ok">{t('tuner.stringOk')}</span>
                {/if}
              </button>
            {/each}
          </div>
        {/if}
        {#if tabTuning}
          <div class="tab-btn">
            <button class="btn" onclick={useTabTuning} title={t('tuner.tabTuningTitle')}>
              <Icon name="music" size={16} />
              {t('tuner.useTabTuning', { name: tabTuning.name })}
            </button>
          </div>
        {/if}
      </div>

      {@render refRow(false)}
      {@render micButton()}
      <p class="note-line"><Icon name="lock" size={16} />{listening ? t('tuner.hintListening', { cents: IN_TUNE_CENTS }) : t('tuner.hintIdle')}</p>
    </div>
  </div>
</div>

<style>
  .tuner {
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
    padding: 40px 32px 32px;
    border-radius: 24px;
    background: var(--card);
    border: 1px solid var(--line);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
  }

  .main-card .error-box {
    margin: 0 0 12px;
    max-width: 520px;
    text-align: center;
  }

  .readout {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    transition: opacity 0.2s;
  }

  .readout.held {
    opacity: 0.5;
  }

  .note {
    display: flex;
    align-items: flex-start;
    line-height: 1;
    min-height: 168px;
  }

  .letter {
    font-size: 168px;
    font-weight: 700;
    letter-spacing: -0.04em;
  }

  .letter.idle {
    color: var(--line-3);
  }

  .octave {
    margin-top: 22px;
    font-size: 34px;
    color: var(--faint);
  }

  .pill-row {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    justify-content: center;
  }

  .pill {
    height: 32px;
    padding: 0 12px;
    border-radius: 16px;
    background: var(--accent-soft);
    color: var(--accent-ink);
    display: inline-flex;
    align-items: center;
    font-size: 14px;
    font-weight: 600;
  }

  .pill.ok {
    background: color-mix(in srgb, var(--ok) 14%, transparent);
    color: var(--ok-text);
  }

  .pill.neutral {
    background: var(--surface-3);
    color: var(--muted);
    font-weight: 500;
  }

  .freq {
    font-size: 14px;
    color: var(--muted);
  }

  .gauge {
    display: block;
    width: 100%;
    max-width: 600px;
    margin-top: 12px;
  }

  .gauge .track {
    fill: none;
    stroke: var(--surface-3);
    stroke-width: 14;
    stroke-linecap: round;
  }

  .gauge .zone {
    fill: none;
    stroke: var(--ok);
    stroke-opacity: 0.55;
    stroke-width: 14;
  }

  .gauge .ticks line {
    stroke: var(--dim);
    stroke-width: 1.5;
    stroke-linecap: round;
  }

  .gauge .zero {
    stroke: var(--ok);
    stroke-width: 2.5;
    stroke-linecap: round;
  }

  .gauge .lbl {
    fill: var(--faint);
    font-size: 9px;
  }

  .gauge .lbl.side {
    font-size: 8px;
    font-family: var(--font);
  }

  .needle {
    transform-origin: 150px 150px;
    transition: transform 0.12s ease-out;
  }

  .needle line {
    stroke: var(--accent);
    stroke-width: 3;
    stroke-linecap: round;
  }

  .hub {
    fill: var(--accent);
  }

  .hub-in {
    fill: var(--card);
  }

  .gauge.ok .needle line {
    stroke: var(--ok);
  }

  .gauge.ok .hub {
    fill: var(--ok);
  }

  .gauge.idle .needle line,
  .gauge.idle .hub {
    stroke: var(--dim);
    fill: var(--dim);
  }

  .gauge.held .needle {
    opacity: 0.45;
  }

  .side {
    flex: 1 1 340px;
    max-width: 420px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .strings-panel {
    display: flex;
    flex-direction: column;
  }

  .strings-head {
    padding: 12px 12px 12px 16px;
    border-bottom: 1px solid var(--line);
  }

  .tuning {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .tuning > span {
    font-size: 13px;
    color: var(--muted);
  }

  .tuning select {
    flex: 1;
    min-width: 0;
    height: 40px;
    padding: 0 8px;
    border-radius: 10px;
    border: 1px solid var(--line-2);
    background: var(--input);
    color: var(--text);
    font-size: 14px;
    font-weight: 600;
  }

  .str-list {
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .str-row {
    height: 48px;
    padding: 0 12px;
    border-radius: 10px;
    border: 1px solid transparent;
    display: flex;
    align-items: center;
    gap: 12px;
    text-align: left;
    color: var(--text);
  }

  .str-row:hover {
    background: var(--surface-2);
  }

  .str-row.hit,
  .str-row[aria-pressed='true'] {
    border-color: var(--accent-line);
    background: var(--accent-soft);
  }

  .row-num {
    width: 22px;
    font-size: 12px;
    color: var(--faint);
  }

  .row-note {
    width: 40px;
    font-size: 16px;
    font-weight: 700;
  }

  .str-row.hit .row-num,
  .str-row.hit .row-note {
    color: var(--accent-ink);
  }

  .row-freq {
    flex: 1;
    font-size: 12px;
    color: var(--faint);
  }

  .row-state {
    font-size: 12px;
    color: var(--accent-ink);
  }

  .row-state.ok {
    color: var(--ok-text);
  }

  .tab-btn {
    padding: 0 16px 16px;
  }

  .tab-btn .btn {
    width: 100%;
    background: var(--surface-3);
    white-space: normal;
  }

  .ref {
    padding: 8px 8px 8px 16px;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .ref-label {
    flex: 1;
    font-size: 13px;
    color: var(--muted);
  }

  .ref-value {
    min-width: 64px;
    text-align: center;
    font-size: 14px;
    font-weight: 700;
  }

  .tone {
    color: var(--accent-ink);
    gap: 6px;
    font-size: 13px;
    font-weight: 600;
  }

  .tone.wide {
    width: auto;
    padding: 0 12px;
  }

  .tone[aria-pressed='true'] {
    background: var(--accent);
    color: var(--on-accent);
  }

  .mic {
    height: 48px;
    border-radius: 14px;
    border: 1px solid var(--line-2);
    color: var(--text);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    font-weight: 600;
  }

  .mic.on {
    border-color: var(--accent);
    background: var(--accent);
    color: var(--on-accent);
  }

  /* Телефон */
  @media (max-width: 720px) {
    .tuner {
      padding: 0 16px 12px;
    }

    .d-only {
      display: none;
    }

    .m-only {
      display: block;
      width: 100%;
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

    .live {
      height: 32px;
      padding: 0 12px;
      border-radius: 16px;
      background: color-mix(in srgb, var(--ok) 10%, transparent);
      border: 1px solid color-mix(in srgb, var(--ok) 33%, transparent);
      color: var(--ok-text);
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      font-weight: 500;
    }

    .live-dot {
      width: 8px;
      height: 8px;
      border-radius: 4px;
      background: var(--ok);
    }

    .layout {
      display: block;
    }

    .main-card {
      padding: 4px 0 0;
      border: 0;
      background: transparent;
      gap: 14px;
    }

    .tuning.mobile-row {
      height: 48px;
      padding: 0 6px 0 14px;
      border-radius: 14px;
      background: var(--surface);
      border: 1px solid var(--line);
    }

    .tuning.mobile-row select {
      border: 0;
      background: transparent;
      font-size: 15px;
    }

    .note {
      min-height: 112px;
    }

    .letter {
      font-size: 112px;
    }

    .octave {
      margin-top: 14px;
      font-size: 24px;
    }

    .pill {
      height: 28px;
      padding: 0 10px;
      font-size: 13px;
    }

    .freq {
      font-size: 13px;
    }

    .gauge {
      margin-top: 0;
    }

    .gauge .lbl {
      font-size: 11px;
    }

    .gauge .lbl.side {
      display: none;
    }

    .m-stack {
      display: flex;
      flex-direction: column;
      gap: 14px;
    }

    .str-grid {
      display: grid;
      gap: 8px;
    }

    .str-tile {
      height: 52px;
      border-radius: 14px;
      border: 1px solid var(--line-2);
      background: var(--surface);
      color: var(--text-2);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 1px;
    }

    .tile-note {
      font-size: 16px;
      font-weight: 700;
    }

    .tile-num {
      font-size: 10px;
      color: var(--faint);
    }

    .str-tile.tuned {
      border-color: color-mix(in srgb, var(--ok) 33%, transparent);
      background: color-mix(in srgb, var(--ok) 8%, transparent);
      color: var(--ok-text);
    }

    .str-tile.tuned .tile-num {
      color: inherit;
    }

    .str-tile.hit,
    .str-tile[aria-pressed='true'] {
      border: 1.5px solid var(--accent);
      background: var(--accent-soft);
      color: var(--accent-ink);
    }

    .str-tile.hit .tile-num,
    .str-tile[aria-pressed='true'] .tile-num {
      color: inherit;
    }

    .ref {
      padding: 6px 6px 6px 14px;
      border-radius: 14px;
    }

    .mic {
      width: 100%;
    }

    .tiny {
      margin: -4px 0 0;
      text-align: center;
      font-size: 11px;
      line-height: 1.4;
      color: var(--faint);
    }
  }
</style>
