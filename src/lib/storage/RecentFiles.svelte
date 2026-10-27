<script lang="ts">
  import { onMount } from 'svelte'
  import { listRecent, loadRecent, removeRecent, clearRecent, type RecentEntry } from './recent'
  import Icon from '../ui/Icon.svelte'
  import { i18n, t } from '../i18n/index.svelte'

  interface Props {
    onopen: (name: string, data: Uint8Array) => void
    /** Зміна значення змушує перечитати список. */
    refreshKey?: number
    /** Назва відкритого зараз файлу — його рядок підсвічується. */
    current?: string | null
    /** aside — у боковій панелі (без списку нічого не показує); page — на стартовому екрані. */
    variant?: 'aside' | 'page'
  }

  let { onopen, refreshKey = 0, current = null, variant = 'page' }: Props = $props()

  let items = $state<RecentEntry[]>([])
  let loaded = $state(false)
  let busy = $state(false)
  let now = $state(Date.now())

  async function refresh() {
    items = await listRecent()
    now = Date.now()
    loaded = true
  }

  onMount(() => {
    const timer = setInterval(() => (now = Date.now()), 60_000)
    return () => clearInterval(timer)
  })

  $effect(() => {
    void refreshKey
    void refresh()
  })

  async function open(entry: RecentEntry) {
    if (busy) return
    busy = true
    try {
      const rec = await loadRecent(entry.id)
      if (!rec) {
        await refresh()
        return
      }
      onopen(rec.name, new Uint8Array(rec.data))
      await refresh()
    } finally {
      busy = false
    }
  }

  async function remove(entry: RecentEntry) {
    await removeRecent(entry.id)
    await refresh()
  }

  async function clearAll() {
    await clearRecent()
    await refresh()
  }

  /** Розширення файлу як бейдж: GP, GP5, GPX… */
  function badge(name: string): string {
    const dot = name.lastIndexOf('.')
    return dot < 0 ? '?' : name.slice(dot + 1, dot + 5).toUpperCase()
  }

  function fmtSize(bytes: number): string {
    return t('recent.kb', { n: Math.max(1, Math.round(bytes / 1024)) })
  }

  const rtf = $derived(new Intl.RelativeTimeFormat(i18n.locale, { numeric: 'auto' }))

  function fmtAgo(ts: number, ref: number): string {
    const sec = Math.round((ts - ref) / 1000)
    const abs = Math.abs(sec)
    if (abs < 60) return t('recent.justNow')
    if (abs < 3600) return rtf.format(Math.round(sec / 60), 'minute')
    if (abs < 86400) return rtf.format(Math.round(sec / 3600), 'hour')
    if (abs < 86400 * 30) return rtf.format(Math.round(sec / 86400), 'day')
    return new Date(ts).toLocaleDateString(i18n.locale)
  }
</script>

{#if variant === 'page' || items.length > 0}
  <section class="recent {variant}">
    <div class="head">
      <h2 class="eyebrow">{t('recent.title')}</h2>
      {#if items.length > 0}
        <button class="clear" onclick={clearAll}>{t('recent.clear')}</button>
      {/if}
    </div>

    {#if items.length === 0}
      <div class="none">
        <Icon name="clock" size={20} />
        <span>{loaded ? t('recent.none') : t('recent.loading')}</span>
      </div>
    {:else}
      <ul>
        {#each items as item (item.id)}
          <li class:current={item.name === current}>
            <button class="open" onclick={() => open(item)} disabled={busy} title="{item.name} · {fmtSize(item.size)}">
              <span class="badge mono">{badge(item.name)}</span>
              <span class="text">
                <span class="name">{item.name}</span>
                <span class="ago">{fmtAgo(item.openedAt, now)}</span>
              </span>
            </button>
            <button class="del" onclick={() => remove(item)} title={t('recent.remove')} aria-label={t('recent.removeAria', { name: item.name })}>
              <Icon name="x" size={14} />
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
{/if}

<style>
  .recent {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .recent.page {
    gap: 12px;
  }

  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 4px;
  }

  .recent.page .head {
    margin-bottom: 0;
  }

  .clear {
    font-size: 12px;
    color: var(--faint);
  }

  .clear:hover {
    color: var(--text);
  }

  .none {
    padding: 20px;
    border-radius: 16px;
    border: 1px solid var(--line);
    display: flex;
    align-items: center;
    gap: 14px;
    color: var(--muted);
  }

  .none :global(svg) {
    flex: none;
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: 50vh;
    overflow-y: auto;
  }

  li {
    position: relative;
    display: flex;
    border-radius: 10px;
  }

  li:hover,
  li.current {
    background: var(--surface-2);
  }

  .open {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 48px;
    padding: 8px 10px;
    display: flex;
    align-items: center;
    gap: 10px;
    text-align: left;
    color: var(--text);
  }

  .badge {
    width: 32px;
    height: 32px;
    flex: none;
    border-radius: 8px;
    background: var(--surface-3);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--muted);
    font-size: 10px;
    font-weight: 700;
  }

  li.current .badge {
    background: var(--accent-soft);
    color: var(--accent-ink);
  }

  .text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }

  .name {
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ago {
    font-size: 12px;
    color: var(--muted-2);
  }

  .del {
    flex: none;
    width: 36px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--faint);
    opacity: 0;
  }

  li:hover .del,
  .del:focus-visible {
    opacity: 1;
  }

  .del:hover {
    color: var(--danger);
  }

  /* На тач-екранах наведення немає, тож хрестик видно завжди. */
  @media (hover: none) {
    .del {
      opacity: 0.7;
    }
  }
</style>
