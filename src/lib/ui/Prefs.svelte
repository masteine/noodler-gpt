<script lang="ts">
  // Перемикачі мови й теми. На десктопі живуть у шапці, на телефоні — на стартовому екрані.
  import Icon from './Icon.svelte'
  import { i18n, LOCALES, setLocale, t } from '../i18n/index.svelte'
  import { currentTheme, toggleTheme } from '../theme.svelte'

  const dark = $derived(currentTheme() === 'dark')
</script>

<div class="prefs">
  <div class="seg lang" role="group" aria-label={t('lang.aria')}>
    {#each LOCALES as l (l.id)}
      <button aria-pressed={i18n.locale === l.id} lang={l.id} title={l.name} onclick={() => setLocale(l.id)}>{l.label}</button>
    {/each}
  </div>
  <button
    class="icon-btn"
    onclick={toggleTheme}
    aria-label={dark ? t('theme.light') : t('theme.dark')}
    title={dark ? t('theme.light') : t('theme.dark')}
  >
    <Icon name={dark ? 'sun' : 'moon'} />
  </button>
</div>

<style>
  .prefs {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .lang > button {
    height: 32px;
    padding: 0 10px;
    font-size: 12px;
    font-weight: 600;
    font-family: var(--mono);
  }
</style>
