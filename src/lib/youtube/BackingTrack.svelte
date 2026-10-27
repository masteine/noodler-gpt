<script lang="ts">
  // Вікно бектреку: відео YouTube, перемикач запис / синтезатор, пошук, посилання,
  // зсув і мітки синхронізації. Про alphaTab нічого не знає: усе робить через колбеки.
  // Десктоп — плаваюча панель, яку можна тягати; телефон — нижній аркуш, що згортається в міні-плеєр.
  import { onMount } from 'svelte'
  import { createPlayer, describeError } from './iframe'
  import { parseVideoId } from './parse'
  import { youtubeSearchUrl, type YtResult } from './search'
  import { getApiKey, setApiKey } from './settings'
  import { formatMs, parseMs } from './sync'
  import type { Source } from './handler'
  import Icon from '../ui/Icon.svelte'
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
  let ytPlayer: YT.Player | null = null
  let volume = $state(100)

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
        ytPlayer = p
        p.setVolume(volume)
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
        ytPlayer = null
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

  function setVolume(v: number) {
    volume = v
    ytPlayer?.setVolume(v)
  }

  // --- вікно: згортання і перетягування ---
  let collapsed = $state(false)
  let dx = $state(0)
  let dy = $state(0)
  let mobile = $state(false)

  onMount(() => {
    const mq = matchMedia('(max-width: 720px)')
    mobile = mq.matches
    const onChange = (e: MediaQueryListEvent) => (mobile = e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  })

  function startDrag(e: PointerEvent) {
    if (mobile || (e.target as HTMLElement).closest('button, input, a, select')) return
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


{#if mobile && !collapsed}
  <div class="backdrop" role="presentation" onclick={() => (collapsed = true)}></div>
{/if}

<div
  class="backing"
  class:collapsed
  class:mobile
  style:transform={mobile ? undefined : `translate(${dx}px, ${dy}px)`}
  role="dialog"
  aria-label={t('bt.aria')}
>
  <div class="head" role="toolbar" tabindex="-1" aria-label={t('bt.controls')} onpointerdown={startDrag}>
    {#if mobile && !collapsed}
      <span class="handle" aria-hidden="true"></span>
    {/if}
    <span class="grip" aria-hidden="true"><Icon name="grip" size={16} /></span>
    <span class="head-icon" aria-hidden="true"><Icon name="headphones" size={mobile && !collapsed ? 20 : 18} /></span>
    <div class="titles">
      <h2>{t('bt.title')}</h2>
      {#if mobile && !collapsed}<div class="sub">{t('bt.subtitle')}</div>{/if}
    </div>
    <button
      class="hbtn"
      onclick={() => (collapsed = !collapsed)}
      aria-label={collapsed ? t('bt.expand') : t('bt.collapse')}
      title={collapsed ? t('bt.expand') : t('bt.collapse')}
    >
      <Icon name={collapsed ? 'chevron-up' : 'chevron-down'} />
    </button>
    <button class="hbtn" onclick={onclose} aria-label={t('bt.hide')} title={t('bt.hide')}>
      <Icon name="x" />
    </button>
  </div>

  {#if videoId}
    <div class="video">
      {#key videoId}
        <div class="host" bind:this={videoHost}></div>
      {/key}
      {#if loadingPlayer}
        <div class="overlay">{t('bt.loadingPlayer')}</div>
      {/if}
    </div>
    {#if playerError}
      <div class="error-box small">{playerError}</div>
    {/if}
  {/if}

  {#if !collapsed}
    <div class="content">
      <div class="seg fill" role="group" aria-label={t('bt.source')}>
        <button
          aria-pressed={source === 'youtube'}
          disabled={!canSwitch}
          onclick={() => onsource('youtube')}
          title={canSwitch ? t('bt.origTitle') : t('bt.pickFirst')}
        >
          {t('bt.sourceYoutube')}
        </button>
        <button aria-pressed={source === 'synth'} onclick={() => onsource('synth')} title={t('bt.synth')}>{t('bt.sourceSynth')}</button>
      </div>

      {#if showSearch}
        <form class="row" onsubmit={submitSearch}>
          <label class="field">
            <Icon name="search" size={16} />
            <span class="sr-only">{t('bt.searchAria')}</span>
            <input type="search" bind:value={q} placeholder={t('bt.searchPlaceholder')} />
          </label>
          <button class="btn primary" type="submit" disabled={searching || !q.trim()}>
            {searching ? '…' : t('bt.search')}
          </button>
        </form>
        <form class="row tight" onsubmit={submitLink}>
          <label class="field">
            <Icon name="link" size={16} />
            <span class="sr-only">{t('bt.linkAria')}</span>
            <input type="url" bind:value={link} placeholder={t('bt.linkPlaceholder')} />
          </label>
          <button class="btn" type="submit" disabled={!link.trim()}>OK</button>
        </form>
        {#if linkError}
          <div class="error-box small">{linkError}</div>
        {/if}

        {#if searchUnavailable}
          <div class="unavailable">
            <p>{t('bt.unavailable')}</p>
            <a class="btn" href={youtubeSearchUrl(q)} target="_blank" rel="noopener noreferrer">{t('bt.openYoutube')}</a>
            <details>
              <summary>{t('bt.ownKey')}</summary>
              <div class="row">
                <label class="field">
                  <span class="sr-only">{t('bt.apiKeyAria')}</span>
                  <input type="password" bind:value={apiKey} placeholder="AIza…" autocomplete="off" />
                </label>
                <button class="btn" type="button" onclick={saveKey}>{t('bt.save')}</button>
              </div>
              <p class="hint">{t('bt.keyHint')}</p>
            </details>
          </div>
        {:else if searchError}
          <div class="error-box small">{searchError}</div>
        {/if}

        {#if results.length > 0}
          <ul class="results">
            {#each results as r (r.videoId)}
              {@const chosen = r.videoId === videoId}
              <li>
                <button class="result" class:chosen aria-pressed={chosen} onclick={() => pick(r.videoId)} title={t('bt.useAsBacking')}>
                  <span class="thumb">
                    {#if r.thumbnail}<img src={r.thumbnail} alt="" loading="lazy" />{:else}<Icon name="play" />{/if}
                  </span>
                  <span class="meta">
                    <span class="rtitle">{r.title}</span>
                    <span class="rsub">{r.channel}{#if r.durationSec !== null} · {fmtDuration(r.durationSec)}{/if}</span>
                  </span>
                  {#if chosen}<span class="check"><Icon name="check" size={20} stroke={2.4} /></span>{/if}
                </button>
              </li>
            {/each}
          </ul>
        {/if}

        {#if changeVideo}
          <button class="btn back" type="button" onclick={() => (changeVideo = false)}>{t('bt.back')}</button>
        {/if}
      {:else}
        <div class="row">
          <button class="btn" onclick={() => (changeVideo = true)}>
            <Icon name="search" size={16} />
            {t('bt.otherVideo')}
          </button>
          <button class="btn" onclick={onunlink} title={t('bt.unlinkTitle')}>{t('bt.unlink')}</button>
        </div>
      {/if}
    </div>

    {#if videoId && !changeVideo}
      <div class="foot">
        <div class="frow">
          <span class="flabel">{t('bt.offset')}</span>
          <button class="step" onclick={() => nudge(-100)} aria-label={t('bt.minus')} title={t('bt.minus')}>
            <Icon name="minus" size={14} />
          </button>
          <input
            class="offset mono"
            type="text"
            inputmode="decimal"
            bind:value={offsetText}
            onchange={commitOffset}
            onkeydown={(e) => e.key === 'Enter' && commitOffset()}
            aria-label={t('bt.offsetAria')}
          />
          <button class="step" onclick={() => nudge(100)} aria-label={t('bt.plus')} title={t('bt.plus')}>
            <Icon name="plus" size={14} />
          </button>
          <button class="btn sm" onclick={onoffsetnow} disabled={!canSwitch} title={t('bt.nowTitle')}>{t('bt.now')}</button>
        </div>
        <div class="frow">
          <button class="btn sm" onclick={ontap} disabled={!canTap} title={t('bt.tapTitle')}>
            {t('bt.tap')}{#if taps > 0}<span class="badge mono">{taps}</span>{/if}
          </button>
          <button class="btn sm" onclick={onresetsync} disabled={offsetMs === 0 && taps === 0}>{t('bt.reset')}</button>
        </div>
        <label class="frow">
          <span class="flabel narrow">{t('bt.volume')}</span>
          <input type="range" min="0" max="100" value={volume} oninput={(e) => setVolume(Number((e.currentTarget as HTMLInputElement).value))} />
        </label>
        <p class="hint">{t('bt.syncHint')}</p>
      </div>
    {/if}
  {/if}
</div>

<style>
  .backing {
    position: fixed;
    right: 24px;
    bottom: 104px;
    z-index: 20;
    width: min(440px, calc(100vw - 32px));
    max-height: calc(100vh - 200px);
    overflow-y: auto;
    border-radius: 20px;
    background: var(--surface);
    border: 1px solid var(--line-2);
    box-shadow: var(--shadow);
    display: flex;
    flex-direction: column;
  }

  .backing.collapsed {
    width: 280px;
  }

  .head {
    min-height: 56px;
    flex: none;
    padding: 0 8px 0 12px;
    display: flex;
    align-items: center;
    gap: 10px;
    border-bottom: 1px solid var(--line);
    cursor: move;
    user-select: none;
    touch-action: none;
  }

  .grip {
    display: inline-flex;
    color: var(--dim);
  }

  .head-icon {
    display: inline-flex;
    color: var(--accent-ink);
  }

  .titles {
    flex: 1;
    min-width: 0;
  }

  h2 {
    margin: 0;
    font-size: 15px;
    font-weight: 700;
  }

  .sub {
    font-size: 12px;
    color: var(--muted-2);
  }

  .hbtn {
    width: 36px;
    height: 36px;
    flex: none;
    border-radius: 9px;
    color: var(--muted);
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  .hbtn:hover {
    color: var(--text);
    background: var(--surface-3);
  }

  .video {
    position: relative;
    aspect-ratio: 16 / 9;
    background: #000;
    flex: none;
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

  .content {
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .content > .seg {
    border: 0;
    background: var(--input);
    border-radius: 11px;
  }

  .content > .seg > button {
    font-size: 13px;
  }

  .row {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }

  .row.tight {
    margin-top: -6px;
  }

  .field {
    flex: 1 1 160px;
    min-width: 0;
    height: 42px;
    padding: 0 12px;
    border-radius: 10px;
    background: var(--input);
    border: 1px solid var(--line-2);
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--faint);
  }

  .field:focus-within {
    border-color: var(--accent);
  }

  .field input {
    flex: 1;
    min-width: 0;
    height: 36px;
    border: 0;
    background: transparent;
    color: var(--text);
    outline: none;
  }

  .row .btn {
    height: 42px;
  }

  .back {
    align-self: flex-start;
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
    width: 100%;
    padding: 8px;
    border-radius: 12px;
    border: 1px solid transparent;
    display: flex;
    align-items: center;
    gap: 12px;
    text-align: left;
    color: var(--text);
  }

  .result:hover {
    background: var(--surface-2);
  }

  .result.chosen {
    border-color: var(--accent-line);
    background: var(--accent-soft);
  }

  .thumb {
    width: 96px;
    height: 54px;
    flex: none;
    border-radius: 8px;
    overflow: hidden;
    background: var(--surface-3);
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--dim);
  }

  .thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .meta {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }

  .rtitle {
    font-weight: 500;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .chosen .rtitle {
    font-weight: 600;
  }

  .rsub {
    font-size: 12px;
    color: var(--muted-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .check {
    display: inline-flex;
    color: var(--accent-ink);
  }

  .foot {
    flex: none;
    padding: 14px 16px 16px;
    background: var(--footer);
    border-top: 1px solid var(--line);
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .frow {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    color: var(--muted);
  }

  .flabel {
    flex: 1;
  }

  .flabel.narrow {
    flex: 0 0 92px;
  }

  .frow input[type='range'] {
    flex: 1;
    min-width: 0;
    margin: 0;
  }

  .offset {
    width: 76px;
    height: 34px;
    text-align: center;
    border-radius: 9px;
    border: 1px solid var(--line-2);
    background: var(--input);
    color: var(--text);
    font-size: 13px;
    font-weight: 700;
  }

  .btn.sm {
    height: 34px;
    padding: 0 12px;
    font-size: 13px;
  }

  .badge {
    padding: 0 6px;
    border-radius: 999px;
    background: var(--accent);
    color: var(--on-accent);
    font-size: 11px;
    line-height: 16px;
  }

  .hint {
    margin: 0;
    font-size: 12px;
    line-height: 1.4;
    color: var(--faint);
  }

  .unavailable {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
    font-size: 13px;
    color: var(--muted);
  }

  .unavailable p {
    margin: 0;
  }

  .unavailable a {
    text-decoration: none;
  }

  details {
    align-self: stretch;
  }

  summary {
    cursor: pointer;
    margin-bottom: 8px;
  }

  .error-box.small {
    margin: 0;
    padding: 6px 10px;
    font-size: 13px;
  }

  .video + .error-box.small {
    margin: 8px 16px 0;
  }

  /* --- телефон --- */
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 19;
    background: #000000b3;
  }

  .handle,
  .backing:not(.mobile) .handle {
    display: none;
  }

  .backing.mobile {
    right: 0;
    left: 0;
    bottom: 0;
    width: auto;
    max-height: 85vh;
    border-radius: 24px 24px 0 0;
    border-width: 1px 0 0;
    padding-bottom: env(safe-area-inset-bottom);
    box-shadow: none;
  }

  .backing.mobile .head {
    position: relative;
    min-height: 0;
    padding: 21px 16px 12px;
    border-bottom: 0;
    cursor: default;
  }

  .backing.mobile .handle {
    display: block;
    position: absolute;
    top: 8px;
    left: 50%;
    margin-left: -20px;
    width: 40px;
    height: 5px;
    border-radius: 3px;
    background: var(--line-3);
  }

  .backing.mobile .grip {
    display: none;
  }

  .backing.mobile:not(.collapsed) .head-icon {
    width: 40px;
    height: 40px;
    border-radius: 12px;
    background: var(--accent-soft);
    align-items: center;
    justify-content: center;
  }

  .backing.mobile:not(.collapsed) h2 {
    font-size: 18px;
  }

  .backing.mobile:not(.collapsed) .hbtn {
    width: 44px;
    height: 44px;
    border-radius: 12px;
    background: var(--surface-3);
    color: var(--text-2);
  }

  .backing.mobile .content {
    padding-top: 4px;
  }

  .backing.mobile .field,
  .backing.mobile .row .btn {
    height: 48px;
  }

  .backing.mobile .thumb {
    width: 88px;
    height: 50px;
  }

  .backing.mobile .foot {
    margin: 0 16px 16px;
    border-radius: 16px;
    border: 1px solid var(--line);
    background: var(--input);
  }

  /* Згорнутий на телефоні: міні-плеєр над транспортом, ноти лишаються видимими. */
  .backing.mobile.collapsed {
    left: auto;
    right: 12px;
    bottom: calc(200px + env(safe-area-inset-bottom));
    width: 220px;
    border-radius: 16px;
    border-width: 1px;
    padding-bottom: 0;
    box-shadow: var(--shadow);
  }

  .backing.mobile.collapsed .head {
    padding: 4px 4px 4px 12px;
  }

  .backing.mobile.collapsed h2 {
    font-size: 13px;
  }
</style>
