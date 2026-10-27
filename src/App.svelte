<script lang="ts">
  import Player from './lib/player/Player.svelte'
  import Metronome from './lib/metronome/Metronome.svelte'
  import Tuner from './lib/tuner/Tuner.svelte'
  import { session } from './lib/session.svelte'
  import { i18n, LOCALES, setLocale, t, type Key } from './lib/i18n/index.svelte'

  type Mode = 'tab' | 'metronome' | 'tuner'
  let mode = $state<Mode>('tab')

  const modes: { id: Mode; label: Key }[] = [
    { id: 'tab', label: 'mode.tab' },
    { id: 'metronome', label: 'mode.metronome' },
    { id: 'tuner', label: 'mode.tuner' },
  ]
</script>

<header class="topbar">
  <div class="brand">Noodler</div>
  <nav class="modes" aria-label={t('mode.aria')}>
    {#each modes as m (m.id)}
      <button class:active={mode === m.id} onclick={() => (mode = m.id)}>{t(m.label)}</button>
    {/each}
  </nav>
  <div class="lang" role="group" aria-label={t('lang.aria')}>
    {#each LOCALES as l (l.id)}
      <button
        class:active={i18n.locale === l.id}
        aria-pressed={i18n.locale === l.id}
        lang={l.id}
        title={l.name}
        onclick={() => setLocale(l.id)}>{l.label}</button
      >
    {/each}
  </div>
</header>

<main class="content">
  <!-- Плеєр не знищуємо при перемиканні вкладок, щоб не втрачати завантажений файл і SoundFont -->
  <div class="pane" hidden={mode !== 'tab'}>
    <Player active={mode === 'tab'} />
  </div>
  {#if mode === 'metronome'}
    <div class="pane">
      <Metronome />
    </div>
  {:else if mode === 'tuner'}
    <div class="pane">
      <Tuner tabTuning={session.tabTuning} />
    </div>
  {/if}
</main>

<style>
  .topbar {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
    background: var(--panel);
    flex: 0 0 auto;
  }

  .brand {
    font-weight: 700;
    letter-spacing: 0.02em;
  }

  .modes {
    display: flex;
    gap: 6px;
  }

  .lang {
    display: flex;
    margin-left: auto;
  }

  .lang button {
    min-width: 0;
    padding: 4px 10px;
    font-size: 13px;
    font-weight: 600;
    border-radius: 0;
    margin-left: -1px;
  }

  .lang button:first-child {
    border-radius: var(--radius) 0 0 var(--radius);
    margin-left: 0;
  }

  .lang button:last-child {
    border-radius: 0 var(--radius) var(--radius) 0;
  }

  /* На телефоні назва не вміщається поряд із вкладками й перемикачем мови. */
  @media (max-width: 480px) {
    .topbar {
      gap: 8px;
    }

    .brand {
      display: none;
    }

    .modes button {
      padding: 8px 10px;
    }
  }

  .content {
    flex: 1 1 auto;
    min-height: 0;
    position: relative;
  }

  .pane {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
  }

  .pane[hidden] {
    display: none;
  }

</style>
