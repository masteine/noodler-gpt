<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import * as alphaTab from '@coderline/alphatab'
  import { demoTex } from './demo'
  import { session } from '../session.svelte'
  import { saveRecent } from '../storage'
  import RecentFiles from '../storage/RecentFiles.svelte'
  import { getLink, saveLink, removeLink } from '../storage'
  import BackingTrack from '../youtube/BackingTrack.svelte'
  import { YouTubeMediaHandler, type Source, type SyncTarget } from '../youtube/handler'
  import { SearchUnavailableError, buildQuery, searchYouTube, type YtResult } from '../youtube/search'
  import { getApiKey } from '../youtube/settings'
  import { offsetOf, plainPoints, tapCount, withOffset, withTap, type BarRef, type FlatSyncPoint } from '../youtube/sync'
  // Ресурси alphaTab беремо через URL-імпорти Vite, щоб шляхи були правильні і в dev, і в build.
  import soundFontUrl from '@coderline/alphatab/soundfont/sonivox.sf3?url'
  import bravuraWoff2 from '@coderline/alphatab/font/Bravura.woff2?url'
  import bravuraWoff from '@coderline/alphatab/font/Bravura.woff?url'

  type View = 'both' | 'tab' | 'score'
  type Layout = 'page' | 'horizontal'

  let { active = true }: { active?: boolean } = $props()

  let host: HTMLDivElement
  let scroller: HTMLDivElement
  let fileInput: HTMLInputElement
  let api: alphaTab.AlphaTabApi | undefined

  // --- стан ---
  let fileName = $state<string | null>(null)
  let title = $state('')
  let artist = $state('')
  let tracks = $state<alphaTab.model.Track[]>([])
  let activeTrack = $state(0)
  let trackMute = $state<boolean[]>([])
  let trackSolo = $state<boolean[]>([])
  let showTracks = $state(false)

  let playing = $state(false)
  let speed = $state(100)
  let looping = $state(false)
  let hasRange = $state(false)
  let metronome = $state(false)
  let countIn = $state(false)
  let view = $state<View>('both')
  let layout = $state<Layout>('page')

  let soundFontProgress = $state(0)
  let playerReady = $state(false)
  let rendering = $state(false)
  let error = $state<string | null>(null)
  let currentTime = $state(0)
  let endTime = $state(0)
  let dragOver = $state(false)
  let recentKey = $state(0)

  // --- бектрек з YouTube ---
  let fileSize = 0
  let source = $state<Source>('synth')
  let videoId = $state<string | null>(null)
  let syncPoints = $state<FlatSyncPoint[]>([])
  let showBacking = $state(false)
  let ytQuery = $state('')
  let ytResults = $state<YtResult[]>([])
  let ytSearching = $state(false)
  let ytError = $state<string | null>(null)
  let ytUnavailable = $state(false)
  let handler: YouTubeMediaHandler | null = null
  let handlerReady = $state(false)
  /** Перемкнутися на ORIG, щойно плеєр YouTube стане готовим. */
  let wantYoutube = false
  let searchSeq = 0

  const hasScore = $derived(tracks.length > 0)
  const offsetMs = $derived(offsetOf(syncPoints))
  const taps = $derived(tapCount(syncPoints))
  const isOrig = $derived(source === 'youtube')
  /** Швидкості YouTube: крок 25 % у межах 25–200 %. Синтезатор: 25–150 % з кроком 5. */
  const speedMin = 25
  const speedMax = $derived(isOrig ? 200 : 150)
  const speedStep = $derived(isOrig ? 25 : 5)

  // --- ініціалізація alphaTab ---
  onMount(() => {
    api = new alphaTab.AlphaTabApi(host, {
      core: {
        smuflFontSources: new Map([
          [alphaTab.FontFileFormat.Woff2, bravuraWoff2],
          [alphaTab.FontFileFormat.Woff, bravuraWoff],
        ]),
      },
      display: {
        layoutMode: alphaTab.LayoutMode.Page,
        staveProfile: alphaTab.StaveProfile.ScoreTab,
        scale: 1,
      },
      player: {
        playerMode: alphaTab.PlayerMode.EnabledAutomatic,
        soundFont: soundFontUrl,
        enableCursor: true,
        enableUserInteraction: true,
        scrollElement: scroller,
        scrollMode: alphaTab.ScrollMode.Continuous,
        scrollOffsetY: -48,
      },
    })

    api.scoreLoaded.on((score) => {
      title = score.title
      artist = score.artist
      tracks = score.tracks
      const first = score.masterBars[0]
      session.tabTempo = first?.tempoAutomations[0]?.value ?? null
      session.tabTimeSignature = first
        ? { numerator: first.timeSignatureNumerator, denominator: first.timeSignatureDenominator }
        : null
      session.tabTitle = score.title || fileName || ''
      activeTrack = 0
      publishTuning(0)
      trackMute = score.tracks.map((t) => t.playbackInfo.isMute)
      trackSolo = score.tracks.map((t) => t.playbackInfo.isSolo)
      hasRange = false
      error = null
      resetBacking()
      ytQuery = buildQuery(score.artist, score.title, fileName)
      void restoreLink(fileName, fileSize)
    })
    api.renderStarted.on(() => (rendering = true))
    api.renderFinished.on(() => (rendering = false))
    api.soundFontLoad.on((e) => (soundFontProgress = e.total ? e.loaded / e.total : 0))
    api.playerReady.on(() => (playerReady = true))
    api.playerStateChanged.on((e) => {
      playing = e.state === alphaTab.synth.PlayerState.Playing
    })
    let lastPosUpdate = 0
    api.playerPositionChanged.on((e) => {
      const now = performance.now()
      if (now - lastPosUpdate < 200 && e.currentTime < e.endTime) return
      lastPosUpdate = now
      currentTime = e.currentTime
      endTime = e.endTime
    })
    api.playbackRangeChanged.on((e) => (hasRange = e.playbackRange !== null))
    api.error.on((e) => {
      error = e.message
      rendering = false
    })

    window.addEventListener('keydown', onKeyDown)

    if (import.meta.env.DEV) {
      // Доступ до API з консолі для ручного тестування в dev-режимі.
      ;(window as unknown as { __noodler: unknown }).__noodler = { api, openFile }
    }
  })

  onDestroy(() => {
    window.removeEventListener('keydown', onKeyDown)
    api?.destroy()
  })

  // --- відкриття файлу ---
  async function openFile(file: File) {
    openBytes(file.name, new Uint8Array(await file.arrayBuffer()), true)
  }

  function openBytes(name: string, data: Uint8Array, persist: boolean) {
    if (!api) return
    error = null
    // Новий файл завжди стартує із синтезатором: відео належить попередньому.
    setSource('synth')
    fileName = name
    fileSize = data.byteLength
    // alphaTab може забрати буфер собі, тому в сховище кладемо окрему копію.
    const copy = persist ? data.slice().buffer : null
    if (!api.load(data)) {
      error = `Не вдалося відкрити «${name}»`
      return
    }
    if (copy) {
      void saveRecent(name, copy).then(() => (recentKey += 1))
    }
  }

  /** Передаємо стрій доріжки тюнеру через спільний стан. alphaTab веде струни від найтонішої до найтовщої. */
  function publishTuning(trackIndex: number) {
    const staff = tracks[trackIndex]?.staves[0]
    const tunings = staff?.stringTuning?.tunings ?? []
    if (!staff || staff.isPercussion || tunings.length === 0) {
      session.tabTuning = null
      return
    }
    const midi = [...tunings].reverse()
    session.tabTuning = { name: staff.stringTuning.name || tracks[trackIndex].name, midi }
  }

  function onFileChosen(e: Event) {
    const input = e.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    if (file) void openFile(file)
    input.value = ''
  }

  function onDrop(e: DragEvent) {
    e.preventDefault()
    dragOver = false
    const file = e.dataTransfer?.files?.[0]
    if (file) void openFile(file)
  }

  function loadDemo() {
    if (!api) return
    error = null
    setSource('synth')
    fileName = 'demo.alphatex'
    fileSize = 0
    api.tex(demoTex)
  }

  // --- транспорт ---
  function playPause() {
    api?.playPause()
  }

  function stop() {
    api?.stop()
  }

  function setSpeed(value: number) {
    speed = snapSpeed(value)
    if (api) api.playbackSpeed = speed / 100
  }

  function snapSpeed(value: number): number {
    const step = speedStep
    const snapped = Math.round(value / step) * step
    return Math.max(speedMin, Math.min(speedMax, snapped))
  }

  function toggleLoop() {
    looping = !looping
    if (api) api.isLooping = looping
  }

  function clearRange() {
    if (api) api.playbackRange = null
  }

  function toggleMetronome() {
    metronome = !metronome
    if (api) api.metronomeVolume = metronome ? 1 : 0
  }

  function toggleCountIn() {
    countIn = !countIn
    if (api) api.countInVolume = countIn ? 1 : 0
  }

  function seekBar(delta: number) {
    if (!api?.score) return
    const bars = api.score.masterBars
    const tick = api.tickPosition
    let i = bars.findIndex((b) => tick >= b.start && tick < b.start + b.calculateDuration())
    if (i < 0) i = tick <= 0 ? 0 : bars.length - 1
    const target = Math.max(0, Math.min(bars.length - 1, i + delta))
    api.tickPosition = bars[target].start
  }

  // --- вигляд ---
  function setView(v: View) {
    view = v
    if (!api) return
    api.settings.display.staveProfile =
      v === 'tab'
        ? alphaTab.StaveProfile.Tab
        : v === 'score'
          ? alphaTab.StaveProfile.Score
          : alphaTab.StaveProfile.ScoreTab
    api.updateSettings()
    api.render()
  }

  function setLayout(l: Layout) {
    layout = l
    if (!api) return
    api.settings.display.layoutMode =
      l === 'horizontal' ? alphaTab.LayoutMode.Horizontal : alphaTab.LayoutMode.Page
    api.updateSettings()
    api.render()
  }

  // --- доріжки ---
  function selectTrack(i: number) {
    activeTrack = i
    publishTuning(i)
    api?.renderTracks([tracks[i]])
  }

  function toggleMute(i: number) {
    trackMute[i] = !trackMute[i]
    api?.changeTrackMute([tracks[i]], trackMute[i])
  }

  function toggleSolo(i: number) {
    trackSolo[i] = !trackSolo[i]
    api?.changeTrackSolo([tracks[i]], trackSolo[i])
  }

  // --- гарячі клавіші ---
  function onKeyDown(e: KeyboardEvent) {
    const t = e.target as HTMLElement | null
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return
    if (!active || !hasScore) return
    switch (e.code) {
      case 'Space':
        e.preventDefault()
        playPause()
        break
      case 'Escape':
        stop()
        break
      case 'ArrowLeft':
        e.preventDefault()
        seekBar(-1)
        break
      case 'ArrowRight':
        e.preventDefault()
        seekBar(1)
        break
      case 'KeyL':
        toggleLoop()
        break
      case 'KeyM':
        if (isOrig) tapSync()
        break
      case 'KeyB':
        showBacking = !showBacking
        break
    }
  }

  // --- бектрек з YouTube ---

  /** Міст handler → alphaTab. Геттер isPlaying читає стан у момент виклику. */
  const syncTarget: SyncTarget = {
    updatePosition(ms) {
      const output = api?.player?.output as alphaTab.synth.IExternalMediaSynthOutput | undefined
      output?.updatePosition?.(ms)
    },
    play: () => void api?.play(),
    pause: () => api?.pause(),
    stop: () => api?.stop(),
    get isPlaying() {
      return api?.playerState === alphaTab.synth.PlayerState.Playing
    },
    setPlaybackSpeed(rate) {
      speed = Math.round(rate * 100)
      if (api) api.playbackSpeed = rate
    },
  }

  function resetBacking() {
    videoId = null
    syncPoints = []
    ytResults = []
    ytError = null
    ytUnavailable = false
    wantYoutube = false
    searchSeq += 1
    ytSearching = false
  }

  /** Відновлює збережене відео для файлу або запускає автопошук. */
  async function restoreLink(name: string | null, size: number) {
    if (!name) return
    const link = await getLink(name, size)
    if (fileName !== name || fileSize !== size) return // тим часом відкрили інший файл
    if (link) {
      videoId = link.videoId
      syncPoints = link.syncPoints
      applySyncPoints()
      showBacking = true
      // Файл уже прив’язано до запису: граємо з ним, щойно плеєр YouTube буде готовий.
      wantYoutube = true
    } else if (size > 0) {
      void runSearch(ytQuery)
    }
  }

  async function runSearch(query: string) {
    ytQuery = query
    const q = query.trim()
    if (!q) return
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      ytError = 'Немає мережі: пошук недоступний'
      return
    }
    const seq = ++searchSeq
    ytSearching = true
    ytError = null
    ytUnavailable = false
    try {
      const found = await searchYouTube(q, { apiKey: getApiKey() })
      if (seq !== searchSeq) return
      ytResults = found
      if (found.length === 0) ytError = 'Нічого не знайдено'
    } catch (e) {
      if (seq !== searchSeq) return
      if (e instanceof SearchUnavailableError) ytUnavailable = true
      else ytError = e instanceof Error ? e.message : String(e)
    } finally {
      if (seq === searchSeq) ytSearching = false
    }
  }

  /** Переносить мітки в модель alphaTab і перераховує синхронізацію плеєра. */
  function applySyncPoints() {
    if (!api?.score) return
    api.score.applyFlatSyncPoints(plainPoints(syncPoints))
    api.updateSyncPoints()
  }

  function persistLink() {
    if (!fileName || !videoId) return
    void saveLink(fileName, fileSize, { videoId, syncPoints: plainPoints(syncPoints) })
  }

  function pickVideo(id: string) {
    if (id === videoId) return
    setSource('synth')
    videoId = id
    syncPoints = []
    applySyncPoints()
    persistLink()
    showBacking = true
    wantYoutube = true
  }

  function unlinkVideo() {
    setSource('synth')
    wantYoutube = false
    videoId = null
    syncPoints = []
    applySyncPoints()
    if (fileName) void removeLink(fileName, fileSize)
  }

  /** Плеєр YouTube створено (або знищено) у міні-вікні. */
  function onYtPlayer(player: YT.Player | null) {
    handler?.destroy()
    handler = null
    handlerReady = false
    if (!player) {
      if (isOrig) setSource('synth')
      return
    }
    handler = new YouTubeMediaHandler(player, syncTarget)
    handlerReady = true
    if (isOrig) attachHandler()
    else if (wantYoutube) {
      wantYoutube = false
      setSource('youtube')
    }
  }

  function attachHandler() {
    if (!api || !handler) return
    ;(api.player!.output as alphaTab.synth.IExternalMediaSynthOutput).handler = handler
    handler.playbackRate = speed / 100
  }

  function setSource(next: Source) {
    if (!api || next === source) return
    if (next === 'youtube') {
      if (!handler) {
        wantYoutube = true
        return
      }
      api.stop()
      source = next
      api.settings.player.playerMode = alphaTab.PlayerMode.EnabledExternalMedia
      api.updateSettings()
      attachHandler()
      setSpeed(speed)
      // Зовнішньому медіа SoundFont не потрібен: плеєр готовий одразу після завантаження midi.
      playerReady = true
    } else {
      api.stop()
      handler?.pause()
      source = next
      playerReady = false
      api.settings.player.playerMode = alphaTab.PlayerMode.EnabledAutomatic
      api.updateSettings()
      setSpeed(speed)
    }
  }

  /** Поточний такт (із повторами) за позицією курсора, і порядок відтворення для міток. */
  function currentBar(): { bar: BarRef; order: (b: BarRef) => number } | null {
    const entries = api?.tickCache?.masterBars
    if (!api || !entries || entries.length === 0) return null
    const tick = api.tickPosition
    let idx = entries.findIndex((e) => tick >= e.start && tick < e.end)
    if (idx < 0) idx = tick <= 0 ? 0 : entries.length - 1
    const e = entries[idx]
    // Натиснули ближче до кінця такту — мали на увазі першу долю наступного.
    if (tick - e.start > (e.end - e.start) / 2 && idx + 1 < entries.length) idx += 1
    const target = entries[idx]
    let occurrence = 0
    for (let i = 0; i < idx; i++) if (entries[i].masterBar.index === target.masterBar.index) occurrence++
    const order = (b: BarRef) => {
      let n = -1
      for (const entry of entries) {
        if (entry.masterBar.index !== b.barIndex) continue
        n++
        if (n === b.barOccurence) return entry.start
      }
      return Number.MAX_SAFE_INTEGER
    }
    return { bar: { barIndex: target.masterBar.index, barOccurence: occurrence }, order }
  }

  function tapSync() {
    if (!handler || !isOrig) return
    const cur = currentBar()
    if (!cur) return
    syncPoints = withTap(syncPoints, cur.bar, handler.currentTimeMs, cur.order)
    applySyncPoints()
    persistLink()
  }

  function setOffset(ms: number) {
    syncPoints = withOffset(syncPoints, ms)
    applySyncPoints()
    persistLink()
  }

  function offsetNow() {
    if (handler) setOffset(handler.currentTimeMs)
  }

  function resetSync() {
    syncPoints = []
    applySyncPoints()
    persistLink()
  }

  function fmt(ms: number) {
    const s = Math.max(0, Math.floor(ms / 1000))
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
  }
</script>

<div
  class="player"
  class:drag-over={dragOver}
  role="region"
  aria-label="Плеєр табулатур"
  ondragover={(e) => {
    e.preventDefault()
    dragOver = true
  }}
  ondragleave={() => (dragOver = false)}
  ondrop={onDrop}
>
  <input
    bind:this={fileInput}
    type="file"
    accept=".gp,.gp3,.gp4,.gp5,.gpx,.xml,.musicxml,.mxl"
    hidden
    onchange={onFileChosen}
  />

  <div class="toolbar">
    <button class="primary" onclick={() => fileInput.click()}>Відкрити</button>
    <button onclick={loadDemo}>Демо</button>

    <div class="song" title={fileName ?? ''}>
      {#if hasScore}
        <strong>{title || fileName}</strong>
        {#if artist}<span class="muted"> — {artist}</span>{/if}
      {:else}
        <span class="muted">Файл не відкрито</span>
      {/if}
    </div>

    {#if hasScore}
      <button class:active={showTracks} onclick={() => (showTracks = !showTracks)}>
        Доріжки ({tracks.length})
      </button>
      <div class="seg" role="group" aria-label="Вигляд">
        <button class:active={view === 'both'} onclick={() => setView('both')}>Обидва</button>
        <button class:active={view === 'tab'} onclick={() => setView('tab')}>Таби</button>
        <button class:active={view === 'score'} onclick={() => setView('score')}>Ноти</button>
      </div>
      <div class="seg" role="group" aria-label="Розкладка">
        <button class:active={layout === 'page'} onclick={() => setLayout('page')}>Сторінка</button>
        <button class:active={layout === 'horizontal'} onclick={() => setLayout('horizontal')}>Стрічка</button>
      </div>
    {/if}
  </div>

  {#if showTracks && hasScore}
    <div class="tracks">
      {#each tracks as track, i (track.index)}
        <div class="track" class:current={i === activeTrack}>
          <button class="track-name" onclick={() => selectTrack(i)} title="Показати доріжку">
            {track.name || `Доріжка ${i + 1}`}
          </button>
          <button class:active={trackMute[i]} onclick={() => toggleMute(i)} disabled={isOrig} title={isOrig ? 'Недоступно з оригінальним записом' : 'Mute'}>M</button>
          <button class:active={trackSolo[i]} onclick={() => toggleSolo(i)} disabled={isOrig} title={isOrig ? 'Недоступно з оригінальним записом' : 'Solo'}>S</button>
        </div>
      {/each}
    </div>
  {/if}

  {#if error}
    <div class="error">{error}</div>
  {/if}

  <div class="score" bind:this={scroller}>
    <div class="at-host" bind:this={host}></div>
    {#if !hasScore}
      <div class="empty">
        <p>Перетягни сюди файл Guitar Pro (.gp, .gp5, .gpx) або натисни «Відкрити».</p>
        <p class="muted">Нічого не відправляється на сервер: файл лишається у браузері.</p>
        <div class="recent">
          <RecentFiles onopen={(name, data) => openBytes(name, data, false)} refreshKey={recentKey} />
        </div>
      </div>
    {/if}
  </div>

  {#if showBacking && hasScore}
    <BackingTrack
      {videoId}
      {source}
      query={ytQuery}
      results={ytResults}
      searching={ytSearching}
      searchError={ytError}
      searchUnavailable={ytUnavailable}
      {offsetMs}
      {taps}
      canSwitch={handlerReady}
      canTap={isOrig && playing}
      onplayer={onYtPlayer}
      onstatechange={(s) => handler?.onStateChange(s)}
      onratechange={(r) => handler?.onPlaybackRateChange(r)}
      onsource={setSource}
      onsearch={(q) => void runSearch(q)}
      onpick={pickVideo}
      onunlink={unlinkVideo}
      onoffset={setOffset}
      onoffsetnow={offsetNow}
      ontap={tapSync}
      onresetsync={resetSync}
      onclose={() => (showBacking = false)}
    />
  {/if}

  <div class="transport">
    <button onclick={stop} disabled={!hasScore} title="Стоп (Esc)">⏹</button>
    <button class="primary play" onclick={playPause} disabled={!hasScore || !playerReady} title="Грати / пауза (пробіл)">
      {playing ? '⏸' : '▶'}
    </button>
    <span class="time">{fmt(currentTime)} / {fmt(endTime)}</span>

    <label class="speed">
      <span>{speed}%</span>
      <input
        type="range"
        min={speedMin}
        max={speedMax}
        step={speedStep}
        value={speed}
        oninput={(e) => setSpeed(Number((e.currentTarget as HTMLInputElement).value))}
        disabled={!hasScore}
      />
    </label>

    <button class:active={looping} onclick={toggleLoop} disabled={!hasScore} title="Зациклити (L)">Loop</button>
    {#if hasRange}
      <button onclick={clearRange} title="Зняти виділення фрагменту">✕ фрагмент</button>
    {/if}
    <button class:active={metronome} onclick={toggleMetronome} disabled={!hasScore || isOrig} title={isOrig ? 'Недоступно з оригінальним записом' : 'Клік метронома'}>Клік</button>
    <button class:active={countIn} onclick={toggleCountIn} disabled={!hasScore || isOrig} title={isOrig ? 'Недоступно з оригінальним записом' : 'Відлік перед стартом'}>1-2-3-4</button>
    <button
      class="backing-btn"
      class:active={showBacking || isOrig}
      onclick={() => (showBacking = !showBacking)}
      disabled={!hasScore}
      title="Бектрек з YouTube (B)"
    >
      {#if isOrig}▶ ORIG{:else if videoId}Бектрек{:else if ytSearching}Бектрек…{:else if ytResults.length > 0}Бектрек <span class="dot" aria-label="знайдено"></span>{:else}Бектрек{/if}
    </button>

    <span class="status muted">
      {#if rendering}
        рендер…
      {:else if !playerReady && soundFontProgress > 0 && soundFontProgress < 1}
        звук {Math.round(soundFontProgress * 100)}%
      {:else if !playerReady && hasScore}
        завантаження звуку…
      {/if}
    </span>
  </div>
</div>

<style>
  .player {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .player.drag-over .score {
    outline: 3px dashed var(--accent);
    outline-offset: -6px;
  }

  .toolbar,
  .transport,
  .tracks {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    padding: 8px 12px;
    background: var(--panel);
    flex: 0 0 auto;
  }

  .toolbar {
    border-bottom: 1px solid var(--border);
  }

  .transport {
    border-top: 1px solid var(--border);
    min-height: var(--transport-h);
    padding-bottom: calc(8px + env(safe-area-inset-bottom));
  }

  .tracks {
    border-bottom: 1px solid var(--border);
    gap: 12px;
  }

  .track {
    display: flex;
    gap: 4px;
    align-items: center;
  }

  .track-name {
    min-width: 120px;
    text-align: left;
  }

  .track.current .track-name {
    border-color: var(--accent);
    color: var(--accent);
    font-weight: 600;
  }

  .song {
    flex: 1 1 200px;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .seg {
    display: flex;
  }

  .seg button {
    border-radius: 0;
    margin-left: -1px;
  }

  .seg button:first-child {
    border-radius: var(--radius) 0 0 var(--radius);
    margin-left: 0;
  }

  .seg button:last-child {
    border-radius: 0 var(--radius) var(--radius) 0;
  }

  .score {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
    position: relative;
    background: #fff;
    color: #000;
  }

  .at-host {
    min-height: 100%;
  }

  .empty {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    padding: 24px;
    color: #333;
    pointer-events: none;
  }

  .recent {
    pointer-events: auto;
    margin-top: 16px;
    width: min(420px, 100%);
    text-align: left;
  }

  .error {
    padding: 8px 12px;
    background: color-mix(in srgb, var(--danger) 12%, var(--panel));
    color: var(--danger);
    flex: 0 0 auto;
  }

  .play {
    font-size: 20px;
    min-width: 56px;
  }

  .time {
    font-variant-numeric: tabular-nums;
    min-width: 90px;
  }

  .speed {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1 1 160px;
    max-width: 320px;
  }

  .speed span {
    min-width: 44px;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  .speed input {
    flex: 1 1 auto;
    min-width: 80px;
  }

  .status {
    margin-left: auto;
    font-size: 14px;
  }

  .backing-btn .dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    margin-left: 4px;
    border-radius: 50%;
    background: var(--accent);
    vertical-align: middle;
  }

  .muted {
    color: var(--muted);
  }

  /* На вузьких екранах тулбар і доріжки не переносяться, а прокручуються вбік,
     щоб нотний стан отримав максимум висоти. */
  @media (max-width: 640px) {
    .toolbar,
    .tracks {
      flex-wrap: nowrap;
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
    }

    .toolbar > *,
    .tracks > * {
      flex: 0 0 auto;
    }

    .song {
      flex: 0 1 auto;
      max-width: 40vw;
    }

    .status {
      display: none;
    }
  }

  /* Елементи, які alphaTab малює всередині контейнера */
  .score :global(.at-cursor-bar) {
    background: rgba(255, 213, 0, 0.22);
  }

  .score :global(.at-selection div) {
    background: rgba(31, 111, 235, 0.12);
  }

  .score :global(.at-cursor-beat) {
    background: rgba(31, 111, 235, 0.8);
    width: 3px;
  }

  .score :global(.at-highlight *) {
    fill: #1f6feb;
    stroke: #1f6feb;
  }
</style>
