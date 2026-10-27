<script lang="ts">
  import Player from './lib/player/Player.svelte'
  import Metronome from './lib/metronome/Metronome.svelte'
  import Tuner from './lib/tuner/Tuner.svelte'
  import Icon, { type IconName } from './lib/ui/Icon.svelte'
  import Logo from './lib/ui/Logo.svelte'
  import Prefs from './lib/ui/Prefs.svelte'
  import { session } from './lib/session.svelte'
  import { t, type Key } from './lib/i18n/index.svelte'

  type Mode = 'tab' | 'metronome' | 'tuner'
  let mode = $state<Mode>('tab')

  const modes: { id: Mode; label: Key; icon: IconName }[] = [
    { id: 'tab', label: 'mode.tab', icon: 'music' },
    { id: 'metronome', label: 'mode.metronome', icon: 'metronome' },
    { id: 'tuner', label: 'mode.tuner', icon: 'tuner' },
  ]

  const shortcuts: { title: Key; rows: [string, Key][] }[] = [
    {
      title: 'mode.tab',
      rows: [
        ['keys.space', 'keys.playPause'],
        ['Esc', 'keys.stop'],
        ['← →', 'keys.bars'],
        ['L', 'keys.loop'],
        ['B', 'keys.backing'],
        ['M', 'keys.syncTap'],
      ],
    },
    {
      title: 'mode.metronome',
      rows: [
        ['keys.space', 'keys.startStop'],
        ['↑ ↓', 'keys.tempo1'],
        ['Shift + ↑ ↓', 'keys.tempo5'],
        ['T', 'keys.tapTempo'],
      ],
    },
  ]

  /** Підписи клавіш, що перекладаються (пробіл), беремо зі словника; решта — як є. */
  const keyLabel = (k: string) => (k.startsWith('keys.') ? t(k as Key) : k)
</script>

<header class="topbar">
  <div class="brand">
    <Logo />
    <span>Noodler</span>
  </div>
  <nav class="seg modes" aria-label={t('mode.aria')}>
    {#each modes as m (m.id)}
      <button aria-current={mode === m.id ? 'page' : undefined} aria-pressed={mode === m.id} onclick={() => (mode = m.id)}>
        <span class="mode-icon"><Icon name={m.icon} /></span>
        {t(m.label)}
      </button>
    {/each}
  </nav>
  <div class="spacer"></div>
  <Prefs />
  <button class="icon-btn" popovertarget="shortcuts" aria-label={t('app.shortcuts')} title={t('app.shortcuts')}>
    <Icon name="keyboard" />
  </button>
</header>

<div id="shortcuts" popover>
  <h2 class="pop-title">{t('app.shortcuts')}</h2>
  {#each shortcuts as group (group.title)}
    <section class="keys">
      <h3 class="eyebrow">{t(group.title)}</h3>
      {#each group.rows as [k, label] (k + label)}
        <div class="key-row"><span>{t(label)}</span><kbd>{keyLabel(k)}</kbd></div>
      {/each}
    </section>
  {/each}
</div>

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

<nav class="tabbar" aria-label={t('mode.aria')}>
  {#each modes as m (m.id)}
    <button aria-current={mode === m.id ? 'page' : undefined} onclick={() => (mode = m.id)}>
      <Icon name={m.icon} size={22} />
      {t(m.label)}
    </button>
  {/each}
</nav>

<style>
  .topbar {
    min-height: 64px;
    padding: 10px 24px;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px 28px;
    border-bottom: 1px solid var(--line);
    background: var(--bg);
    flex: 0 0 auto;
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 19px;
    font-weight: 700;
    letter-spacing: -0.02em;
  }

  .modes {
    gap: 4px;
    padding: 4px;
    border-radius: 12px;
  }

  .modes > button {
    height: 36px;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    border-radius: 9px;
  }

  .modes > button[aria-pressed='true'] .mode-icon {
    color: var(--accent-ink);
  }

  .mode-icon {
    display: inline-flex;
  }

  .spacer {
    flex: 1;
  }

  #shortcuts {
    position: fixed;
    inset: 72px 24px auto auto;
    width: 300px;
  }

  .pop-title {
    margin: 0 0 12px;
    font-size: 15px;
    font-weight: 700;
  }

  .keys {
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-size: 13px;
    color: var(--muted);
  }

  .keys + .keys {
    margin-top: 16px;
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

  .tabbar {
    display: none;
  }

  /* На телефоні верхню шапку замінює нижня навігація, як у нативних застосунках. */
  @media (max-width: 720px) {
    .topbar {
      display: none;
    }

    .tabbar {
      flex: none;
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 8px;
      height: calc(64px + env(safe-area-inset-bottom));
      padding: 6px 16px calc(6px + env(safe-area-inset-bottom));
      background: var(--card);
      border-top: 1px solid var(--line);
    }

    .tabbar > button {
      border-radius: 12px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 3px;
      font-size: 11px;
      font-weight: 500;
      color: var(--faint);
    }

    .tabbar > button[aria-current='page'] {
      color: var(--accent-ink);
      font-weight: 600;
    }
  }
</style>
