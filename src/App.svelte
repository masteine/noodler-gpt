<script lang="ts">
  import Player from './lib/player/Player.svelte'
  import Metronome from './lib/metronome/Metronome.svelte'
  import Tuner from './lib/tuner/Tuner.svelte'
  import { session } from './lib/session.svelte'

  type Mode = 'tab' | 'metronome' | 'tuner'
  let mode = $state<Mode>('tab')

  const modes: { id: Mode; label: string }[] = [
    { id: 'tab', label: 'Таб' },
    { id: 'metronome', label: 'Метроном' },
    { id: 'tuner', label: 'Тюнер' },
  ]
</script>

<header class="topbar">
  <div class="brand">Noodler</div>
  <nav class="modes" aria-label="Режим">
    {#each modes as m (m.id)}
      <button class:active={mode === m.id} onclick={() => (mode = m.id)}>{m.label}</button>
    {/each}
  </nav>
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
