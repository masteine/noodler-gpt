<script lang="ts">
  // Плаваюче міні-вікно бектреку: відео YouTube, перемикач ORIG / SYNTH, пошук, посилання,
  // зсув і мітки синхронізації. Про alphaTab нічого не знає: усе робить через колбеки.
  import { createPlayer, describeError } from './iframe'
  import { parseVideoId } from './parse'
  import { youtubeSearchUrl, type YtResult } from './search'
  import { getApiKey, setApiKey } from './settings'
  import { formatMs, parseMs } from './sync'
  import type { Source } from './handler'
  import { t } from '../i18n/index.svelte'

  interface Props {
    videoId: string | null
    source: Source
    /** Пошуковий запит за замовчуванням («виконавець назва»). */
    query: string
    results: YtResult[]
    searching: boolean
    searchError: string | null
    /** Немає ні серверного пошуку, ні ключа: показуємо «Відкрити YouTube» і поле ключа. */
    searchUnavailable: boolean
    offsetMs: number
    taps: number
    /** Плеєр YouTube готовий — можна перемикати ORIG. */
    canSwitch: boolean
    /** Зараз грає в ORIG — можна ставити мітки. */
    canTap: boolean
    onplayer: (player: YT.Player | null) => void
    onstatechange: (state: number) => void
    onratechange: (rate: number) => void
    onsource: (source: Source) => void
    onsearch: (query: string) => void
    onpick: (videoId: string) => void
    onunlink: () => void
    onoffset: (ms: number) => void
    onoffsetnow: () => void
    ontap: () => void
    onresetsync: () => void
    onclose: () => void
  }

  let {
    videoId,
    source,
    query,
    results,
    searching,
    searchError,
    searchUnavailable,
    offsetMs,
    taps,
    canSwitch,
    canTap,
    onplayer,
    onstatechange,
    onratechange,
    onsource,
    onsearch,
    onpick,
    onunlink,
    onoffset,
    onoffsetnow,
    ontap,
    onresetsync,
    onclose,
  }: Props = $props()

  // --- плеєр YouTube ---
  let videoHost = $state<HTMLDivElement>()
  let playerError = $state<string | null>(null)
  let loadingPlayer = $state(false)

  // YT.Player підміняє переданий елемент на iframe, тому host обгорнуто в {#key videoId}:
  // на нове відео Svelte створює свіжий елемент, а ефект нижче — новий плеєр.
  $effect(() => {
    const id = videoId
    const host = videoHost
    if (!id || !host) return
    let cancelled = false
    let player: YT.Player | null = null
    loadingPlayer = true
    playerError = null
    createPlayer(host, id, {
      onStateChange: (s) => onstatechange(s),
      onPlaybackRateChange: (r) => onratechange(r),
      onError: (code) => (playerError = describeError(code)),
    })
      .then((p) => {
        if (cancelled) {
          p.destroy()
          return
        }
        player = p
        loadingPlayer = false
        onplayer(p)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        loadingPlayer = false
        playerError = e instanceof Error ? e.message : String(e)
      })
    return () => {
      cancelled = true
      if (player) {
        onplayer(null)
        player.destroy()
        player = null
      }
    }
  })

  // --- пошук і посилання ---
  let q = $state('')
  $effect(() => {
    q = query
  })
  let link = $state('')
  let linkError = $state<string | null>(null)
  let apiKey = $state(getApiKey() ?? '')
  let changeVideo = $state(false)

  function submitSearch(e: SubmitEvent) {
    e.preventDefault()
    if (q.trim()) onsearch(q.trim())
  }

  function submitLink(e: SubmitEvent) {
    e.preventDefault()
    const id = parseVideoId(link)
    if (!id) {
      linkError = t('bt.badLink')
      return
    }
    linkError = null
    link = ''
    changeVideo = false
    onpick(id)
  }

  function pick(id: string) {
    changeVideo = false
    onpick(id)
  }

  function saveKey() {
    setApiKey(apiKey)
    if (q.trim()) onsearch(q.trim())
  }

  // --- зсув ---
  let offsetText = $state('')
  $effect(() => {
    offsetText = formatMs(offsetMs)
  })

  function commitOffset() {
    const ms = parseMs(offsetText)
    if (ms === null) {
      offsetText = formatMs(offsetMs)
      return
    }
    onoffset(ms)
  }

  function nudge(deltaMs: number) {
    onoffset(Math.max(0, offsetMs + deltaMs))
  }

  // --- вікно: згортання і перетягування ---
  let collapsed = $state(false)
  let dx = $state(0)
  let dy = $state(0)

  function startDrag(e: PointerEvent) {
    if ((e.target as HTMLElement).closest('button, input, a, select')) return
    const el = e.currentTarget as HTMLElement
    const sx = e.clientX - dx
    const sy = e.clientY - dy
    const move = (ev: PointerEvent) => {
      dx = ev.clientX - sx
      dy = ev.clientY - sy
    }
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
    }
    el.setPointerCapture(e.pointerId)
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }

  function fmtDuration(sec: number | null): string {
    if (sec === null) return ''
    const m = Math.floor(sec / 60)
    return `${m}:${String(sec % 60).padStart(2, '0')}`
  }

  const showSearch = $derived(!videoId || changeVideo)
</script>

<div
  class="backing"
  class:collapsed
  style:transform={`translate(${dx}px, ${dy}px)`}
  role="dialog"
  aria-label={t('bt.aria')}
>
  <div class="head" role="toolbar" tabindex="-1" aria-label={t('bt.controls')} onpointerdown={startDrag}>
    <span class="grip" aria-hidden="true">⋮⋮</span>
    <span class="title">{t('bt.title')}</span>
    <div class="seg" role="group" aria-label={t('bt.source')}>
      <button
        class:active={source === 'youtube'}
        disabled={!canSwitch}
        onclick={() => onsource('youtube')}
        title={canSwitch ? t('bt.origTitle') : t('bt.pickFirst')}
      >
        ORIG
      </button>
      <button class:active={source === 'synth'} onclick={() => onsource('synth')} title={t('bt.synth')}>SYNTH</button>
    </div>
    <button class="icon" onclick={() => (collapsed = !collapsed)} title={collapsed ? t('bt.expand') : t('bt.collapse')}>
      {collapsed ? '▴' : '▾'}
    </button>
    <button class="icon" onclick={onclose} title={t('bt.hide')}>✕</button>
  </div>

  {#if videoId}
    <div class="video">
      {#key videoId}
        <div class="host" bind:this={videoHost}></div>
      {/key}
      {#if loadingPlayer}
        <div class="overlay muted">{t('bt.loadingPlayer')}</div>
      {/if}
    </div>
    {#if playerError}
      <div class="error">{playerError}</div>
    {/if}
  {/if}

  {#if !collapsed}
    {#if videoId && !changeVideo}
      <div class="sync">
        <div class="row">
          <span class="label">{t('bt.start')}</span>
          <button class="small" onclick={() => nudge(-100)} title={t('bt.minus')}>−</button>
          <input
            class="offset"
            type="text"
            inputmode="decimal"
            bind:value={offsetText}
            onchange={commitOffset}
            onkeydown={(e) => e.key === 'Enter' && commitOffset()}
            aria-label={t('bt.offsetAria')}
          />
          <button class="small" onclick={() => nudge(100)} title={t('bt.plus')}>+</button>
          <button class="small" onclick={onoffsetnow} disabled={!canSwitch} title={t('bt.nowTitle')}>{t('bt.now')}</button>
        </div>
        <div class="row">
          <button class="small" onclick={ontap} disabled={!canTap} title={t('bt.tapTitle')}>
            {t('bt.tap')}{#if taps > 0}<span class="badge">{taps}</span>{/if}
          </button>
          <button class="small" onclick={onresetsync} disabled={offsetMs === 0 && taps === 0}>{t('bt.reset')}</button>
          <span class="spacer"></span>
          <button class="small" onclick={() => (changeVideo = true)}>{t('bt.otherVideo')}</button>
          <button class="small" onclick={onunlink} title={t('bt.unlinkTitle')}>{t('bt.unlink')}</button>
        </div>
        <p class="hint muted">{t('bt.syncHint')}</p>
      </div>
    {/if}

    {#if showSearch}
      <div class="search">
        <form class="row" onsubmit={submitSearch}>
          <input type="search" bind:value={q} placeholder={t('bt.searchPlaceholder')} aria-label={t('bt.searchAria')} />
          <button class="small primary" type="submit" disabled={searching || !q.trim()}>
            {searching ? '…' : t('bt.search')}
          </button>
          {#if changeVideo}
            <button class="small" type="button" onclick={() => (changeVideo = false)}>{t('bt.back')}</button>
          {/if}
        </form>

        {#if searchUnavailable}
          <div class="unavailable">
            <p class="muted">{t('bt.unavailable')}</p>
            <a class="button-like" href={youtubeSearchUrl(q)} target="_blank" rel="noopener noreferrer">
              {t('bt.openYoutube')}
            </a>
            <details>
              <summary class="muted">{t('bt.ownKey')}</summary>
              <div class="row">
                <input type="password" bind:value={apiKey} placeholder="AIza…" aria-label={t('bt.apiKeyAria')} autocomplete="off" />
                <button class="small" type="button" onclick={saveKey}>{t('bt.save')}</button>
              </div>
              <p class="hint muted">{t('bt.keyHint')}</p>
            </details>
          </div>
        {:else if searchError}
          <div class="error">{searchError}</div>
        {/if}

        {#if results.length > 0}
          <ul class="results">
            {#each results as r (r.videoId)}
              <li>
                <button class="result" onclick={() => pick(r.videoId)} title={t('bt.useAsBacking')}>
                  {#if r.thumbnail}<img src={r.thumbnail} alt="" loading="lazy" />{/if}
                  <span class="meta">
                    <span class="rtitle">{r.title}</span>
                    <span class="muted">{r.channel}{#if r.durationSec !== null} · {fmtDuration(r.durationSec)}{/if}</span>
                  </span>
                </button>
              </li>
            {/each}
          </ul>
        {/if}

        <form class="row" onsubmit={submitLink}>
          <input type="url" bind:value={link} placeholder={t('bt.linkPlaceholder')} aria-label={t('bt.linkAria')} />
          <button class="small" type="submit" disabled={!link.trim()}>OK</button>
        </form>
        {#if linkError}
          <div class="error">{linkError}</div>
        {/if}
      </div>
    {/if}
  {/if}
</div>

<style>
  .backing {
    position: fixed;
    right: 12px;
    bottom: calc(var(--transport-h) + 12px + env(safe-area-inset-bottom));
    width: min(360px, calc(100vw - 24px));
    max-height: calc(100vh - var(--transport-h) - 80px);
    overflow: auto;
    z-index: 20;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.25);
    display: flex;
    flex-direction: column;
    font-size: 14px;
  }

  .backing.collapsed {
    width: 240px;
  }

  .head {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 8px;
    border-bottom: 1px solid var(--border);
    cursor: grab;
    user-select: none;
    touch-action: none;
  }

  .grip {
    color: var(--muted);
    letter-spacing: -2px;
  }

  .title {
    font-weight: 600;
    flex: 1 1 auto;
  }

  .seg {
    display: flex;
  }

  .seg button {
    min-height: 32px;
    padding: 4px 10px;
    border-radius: 0;
    margin-left: -1px;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.04em;
  }

  .seg button:first-child {
    border-radius: var(--radius) 0 0 var(--radius);
    margin-left: 0;
  }

  .seg button:last-child {
    border-radius: 0 var(--radius) var(--radius) 0;
  }

  .icon {
    min-height: 32px;
    min-width: 32px;
    padding: 0;
  }

  .video {
    position: relative;
    aspect-ratio: 16 / 9;
    background: #000;
    flex: 0 0 auto;
  }

  /* iframe, яким YT.Player підміняє .host */
  .video :global(iframe),
  .host {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    border: 0;
  }

  .overlay {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    color: #ccc;
    pointer-events: none;
  }

  .sync,
  .search {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 8px;
  }

  .search {
    border-top: 1px solid var(--border);
  }

  .row {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }

  .row input {
    flex: 1 1 120px;
    min-width: 0;
    font: inherit;
    color: inherit;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 6px 10px;
    min-height: 32px;
  }

  .offset {
    flex: 0 0 72px !important;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }

  .label {
    color: var(--muted);
    min-width: 56px;
  }

  .spacer {
    flex: 1 1 auto;
  }

  button.small {
    min-height: 32px;
    padding: 4px 10px;
    font-size: 13px;
  }

  .badge {
    display: inline-block;
    margin-left: 6px;
    padding: 0 6px;
    border-radius: 999px;
    background: var(--accent);
    color: var(--accent-text);
    font-size: 11px;
    line-height: 16px;
  }

  .hint {
    margin: 0;
    font-size: 12px;
    line-height: 1.35;
  }

  .unavailable {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .unavailable p {
    margin: 0;
  }

  .button-like {
    align-self: flex-start;
    display: inline-block;
    padding: 6px 12px;
    border: 1px solid var(--accent);
    border-radius: var(--radius);
    color: var(--accent);
    text-decoration: none;
  }

  details summary {
    cursor: pointer;
    font-size: 13px;
  }

  .results {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .result {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    text-align: left;
    padding: 4px;
    min-height: 0;
  }

  .result img {
    width: 80px;
    height: 45px;
    object-fit: cover;
    border-radius: 6px;
    flex: 0 0 auto;
  }

  .meta {
    display: flex;
    flex-direction: column;
    min-width: 0;
    font-size: 13px;
  }

  .rtitle {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .meta .muted {
    font-size: 12px;
  }

  .error {
    padding: 6px 8px;
    border-radius: var(--radius);
    background: color-mix(in srgb, var(--danger) 12%, var(--panel));
    color: var(--danger);
    font-size: 13px;
  }

  .muted {
    color: var(--muted);
  }

  /* На телефоні транспорт переноситься на два рядки, тому вікно чіпляємо до верху під тулбаром,
     а не до низу, щоб не перекривати play/стоп. */
  @media (max-width: 640px) {
    .backing {
      right: 8px;
      left: 8px;
      width: auto;
      top: calc(112px + env(safe-area-inset-top));
      bottom: auto;
      max-height: 55vh;
    }

    .backing.collapsed {
      left: auto;
      width: 200px;
    }
  }
</style>
