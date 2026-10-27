<script lang="ts">
  import { onMount } from 'svelte'
  import { listRecent, loadRecent, removeRecent, clearRecent, type RecentEntry } from './recent'

  interface Props {
    onopen: (name: string, data: Uint8Array) => void
    /** Зміна значення змушує перечитати список. */
    refreshKey?: number
    /** Компактний режим для тулбара: список ховається у випадне меню. */
    compact?: boolean
  }

  let { onopen, refreshKey = 0, compact = false }: Props = $props()

  let items = $state<RecentEntry[]>([])
  let loaded = $state(false)
  let busy = $state(false)
  let now = $state(Date.now())
  let menu = $state<HTMLDetailsElement>()

  async function refresh() {
    items = await listRecent()
    now = Date.now()
    loaded = true
  }

  onMount(() => {
    const t = setInterval(() => (now = Date.now()), 60_000)
    return () => clearInterval(t)
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
      if (menu) menu.open = false
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

  function fmtSize(bytes: number): string {
    return `${Math.max(1, Math.round(bytes / 1024))} КБ`
  }

  const rtf = new Intl.RelativeTimeFormat('uk', { numeric: 'auto' })

  function fmtAgo(ts: number, ref: number): string {
    const sec = Math.round((ts - ref) / 1000)
    const abs = Math.abs(sec)
    if (abs < 60) return 'щойно'
    if (abs < 3600) return rtf.format(Math.round(sec / 60), 'minute')
    if (abs < 86400) return rtf.format(Math.round(sec / 3600), 'hour')
    if (abs < 86400 * 30) return rtf.format(Math.round(sec / 86400), 'day')
    return new Date(ts).toLocaleDateString('uk')
  }
</script>

{#snippet list()}
  {#if items.length === 0}
    <p class="none muted">{loaded ? 'Нещодавніх файлів ще немає.' : 'Завантаження…'}</p>
  {:else}
    <ul>
      {#each items as item (item.id)}
        <li>
          <button class="open" onclick={() => open(item)} disabled={busy} title={item.name}>
            <span class="name">{item.name}</span>
            <span class="meta muted">{fmtSize(item.size)} · {fmtAgo(item.openedAt, now)}</span>
          </button>
          <button class="del" onclick={() => remove(item)} title="Видалити зі списку" aria-label="Видалити «{item.name}» зі списку">✕</button>
        </li>
      {/each}
    </ul>
    <button class="clear" onclick={clearAll}>Очистити все</button>
  {/if}
{/snippet}

{#if compact}
  <details class="recent compact" bind:this={menu}>
    <summary>Нещодавні{items.length ? ` (${items.length})` : ''}</summary>
    <div class="panel">{@render list()}</div>
  </details>
{:else}
  <section class="recent">
    <h3>Нещодавні</h3>
    {@render list()}
  </section>
{/if}

<style>
  .recent {
    pointer-events: auto;
    text-align: left;
    width: min(420px, 100%);
    color: var(--text);
  }

  h3 {
    margin: 0 0 8px;
    font-size: 0.95rem;
    color: var(--muted);
    font-weight: 600;
  }

  .muted {
    color: var(--muted);
  }

  .none {
    margin: 0;
    font-size: 0.9rem;
  }

  ul {
    list-style: none;
    margin: 0 0 8px;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-height: 50vh;
    overflow-y: auto;
  }

  li {
    display: flex;
    gap: 4px;
  }

  .open {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    text-align: left;
  }

  .name {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .meta {
    font-size: 0.8rem;
  }

  .del {
    flex: 0 0 auto;
    padding: 8px 12px;
  }

  .del:hover {
    color: var(--danger);
    border-color: var(--danger);
  }

  .clear {
    font-size: 0.85rem;
    min-height: 32px;
    padding: 4px 12px;
  }

  .compact {
    position: relative;
    width: auto;
  }

  summary {
    list-style: none;
    cursor: pointer;
    user-select: none;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 8px 14px;
    min-height: 40px;
    display: inline-flex;
    align-items: center;
    touch-action: manipulation;
  }

  summary::-webkit-details-marker {
    display: none;
  }

  summary:hover,
  .compact[open] summary {
    border-color: var(--accent);
  }

  .panel {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    z-index: 20;
    width: min(360px, calc(100vw - 24px));
    padding: 10px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: 0 6px 24px rgb(0 0 0 / 0.2);
  }
</style>
