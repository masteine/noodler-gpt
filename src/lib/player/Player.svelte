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
  import { SearchFailedError, SearchUnavailableError, buildQuery, searchYouTube, type YtResult } from '../youtube/search'
  import { getApiKey } from '../youtube/settings'
  import Icon from '../ui/Icon.svelte'
  import Logo from '../ui/Logo.svelte'
  import Prefs from '../ui/Prefs.svelte'
  import { t, tn, type Key } from '../i18n/index.svelte'
  import { offsetOf, plainPoints, tapCount, withOffset, withTap, type BarRef, type FlatSyncPoint } from '../youtube/sync'
  import { NoTabAudioError, TabAudioRecorder, isAutoSyncSupported } from '../autosync/capture'
  import { CancelledError, NoNotesError, REF_SECONDS, autoSyncOffset, type AutoSyncProgress } from '../autosync/autosync'
  import { notesFromScore } from '../autosync/score'
  // Ресурси alphaTab беремо через URL-імпорти Vite, щоб шляхи були правильні і в dev, і в build.
  import soundFontUrl from '@coderline/alphatab/soundfont/sonivox.sf3?url'
  import bravuraWoff2 from '@coderline/alphatab/font/Bravura.woff2?url'
  import bravuraWoff from '@coderline/alphatab/font/Bravura.woff?url'

  type View = 'both' | 'tab' | 'score'

  /** Кроки масштабу нотного стану. */
  const ZOOMS = [0.5, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2]
  /** Кольори доріжок у боковій панелі за порядком. */
  const TRACK_COLORS = ['var(--accent)', 'var(--track-2)', 'var(--ok)', '#f472b6', '#a78bfa', '#2dd4bf']
  /** Та сама межа, що й у CSS: вужче — телефонний макет. */
  const MOBILE = '(max-width: 720px)'

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
  let trackVolume = $state<number[]>([])
  let showTracks = $state(false)

  let playing = $state(false)
  let speed = $state(100)
  let looping = $state(false)
  let hasRange = $state(false)
  let metronome = $state(false)
  let countIn = $state(false)
  let view = $state<View>('both')
  let zoomIndex = $state(ZOOMS.indexOf(1))

  let soundFontProgress = $state(0)
  let playerReady = $state(false)
  let rendering = $state(false)
  let error = $state<string | null>(null)
  let currentTime = $state(0)
  let endTime = $state(0)
  let currentTick = $state(0)
  let endTick = $state(0)
  let range = $state<{ startTick: number; endTick: number } | null>(null)
  /** Такти у порядку відтворення (з повторами): номер і початок у midi-тиках. */
  let barMarks = $state<{ num: number; start: number }[]>([])
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
  /** Іде автосинхронізація початку (прогрес) або null. */
  let autoSync = $state<AutoSyncProgress | null>(null)
  /** Підсумок останньої автосинхронізації для вікна бектреку. */
  let autoSyncNote = $state<string | null>(null)
  let autoSyncAbort: AbortController | null = null
  const canAutoSync = isAutoSyncSupported()
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
    // На телефоні нотний стан поряд із табом не вміщається: стартуємо з самих табів дрібнішим масштабом.
    if (matchMedia(MOBILE).matches) {
      view = 'tab'
      zoomIndex = ZOOMS.indexOf(0.75)
    }
    api = new alphaTab.AlphaTabApi(host, {
      core: {
        smuflFontSources: new Map([
          [alphaTab.FontFileFormat.Woff2, bravuraWoff2],
          [alphaTab.FontFileFormat.Woff, bravuraWoff],
        ]),
      },
      display: {
        layoutMode: alphaTab.LayoutMode.Page,
        staveProfile: profileOf(view),
        scale: ZOOMS[zoomIndex],
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
      trackVolume = score.tracks.map(() => 100)
      hasRange = false
      range = null
      currentTick = 0
      endTick = 0
      currentTime = 0
      endTime = 0
      barMarks = []
      error = null
      resetBacking()
      ytQuery = buildQuery(score.artist, score.title, fileName)
      void restoreLink(fileName, fileSize)
    })
    api.renderStarted.on(() => (rendering = true))
    api.renderFinished.on(() => (rendering = false))
    api.soundFontLoad.on((e) => (soundFontProgress = e.total ? e.loaded / e.total : 0))
    api.playerReady.on(() => (playerReady = true))
    api.midiLoaded.on(() => {
      barMarks = (api?.tickCache?.masterBars ?? []).map((e) => ({ num: e.masterBar.index + 1, start: e.start }))
    })
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
      currentTick = e.currentTick
      endTick = e.endTick
    })
    api.playbackRangeChanged.on((e) => {
      hasRange = e.playbackRange !== null
      range = e.playbackRange ? { startTick: e.playbackRange.startTick, endTick: e.playbackRange.endTick } : null
    })
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
      error = t('player.openFailed', { name })
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
    api.tex(demoTex({ title: t('demo.title'), guitar: t('demo.guitar'), bass: t('demo.bass') }))
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

  function seek(tick: number) {
    if (api) api.tickPosition = tick
    currentTick = tick
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
  function profileOf(v: View) {
    return v === 'tab'
      ? alphaTab.StaveProfile.Tab
      : v === 'score'
        ? alphaTab.StaveProfile.Score
        : alphaTab.StaveProfile.ScoreTab
  }

  function setView(v: View) {
    view = v
    if (!api) return
    api.settings.display.staveProfile = profileOf(v)
    api.updateSettings()
    api.render()
  }

  function setZoom(index: number) {
    zoomIndex = Math.max(0, Math.min(ZOOMS.length - 1, index))
    if (!api) return
    api.settings.display.scale = ZOOMS[zoomIndex]
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

  function setTrackVolume(i: number, value: number) {
    trackVolume[i] = value
    api?.changeTrackVolume([tracks[i]], value / 100)
  }

  /** Підпис під назвою доріжки: інструмент за MIDI-програмою та кількість струн. */
  function trackInfo(track: alphaTab.model.Track): string {
    const staff = track.staves[0]
    if (staff?.isPercussion) return t('inst.drums')
    const program = track.playbackInfo.program
    const inst: Key | null =
      program <= 7
        ? 'inst.piano'
        : program === 24 || program === 25
          ? 'inst.acoustic'
          : program >= 26 && program <= 31
            ? 'inst.electric'
            : program >= 32 && program <= 39
              ? 'inst.bass'
              : null
    const strings = staff?.stringTuning?.tunings.length ?? 0
    return [inst ? t(inst) : '', strings ? tn('n.strings', strings) : ''].filter(Boolean).join(' · ')
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
      ytError = t('player.offline')
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
      if (found.length === 0) ytError = t('player.nothingFound')
    } catch (e) {
      if (seq !== searchSeq) return
      if (e instanceof SearchUnavailableError) ytUnavailable = true
      else if (e instanceof SearchFailedError)
        ytError = e.status === null ? t('search.service') : t('search.http', { status: e.status })
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

  /**
   * Автосинхронізація початку: захоплює звук вкладки, програє відео з початку й зіставляє
   * хрому запису з нотами табу. Викликається з кліку: getDisplayMedia потребує жесту користувача.
   */
  async function runAutoSync() {
    if (!api?.score || !api.tickCache || !handler || !isOrig || autoSync) return
    const h = handler
    api.stop()
    h.suspended = true
    autoSyncNote = null
    autoSync = { phase: 'starting', seconds: 0, total: 0 }
    const abort = new AbortController()
    autoSyncAbort = abort
    let recorder: TabAudioRecorder | null = null
    try {
      recorder = await TabAudioRecorder.open()
      recorder.onended = () => abort.abort()
      const notes = notesFromScore(api.score, api.tickCache, (REF_SECONDS + 60) * 1000)
      const result = await autoSyncOffset({
        player: h.player,
        notes,
        recorder,
        signal: abort.signal,
        onProgress: (p) => (autoSync = p),
      })
      if (result.confidence === 'poor') {
        autoSyncNote = t('bt.autoPoor')
      } else {
        setOffset(result.offsetMs)
        let note = t(result.confidence === 'good' ? 'bt.autoGood' : 'bt.autoFair', { time: fmtMs(result.offsetMs) })
        if (result.shift !== 0) {
          const up = result.shift <= 6
          note += ' ' + t(up ? 'bt.autoHigher' : 'bt.autoLower', { n: up ? result.shift : 12 - result.shift })
        }
        autoSyncNote = note
      }
    } catch (e) {
      if (e instanceof CancelledError) autoSyncNote = t('bt.autoCancelled')
      else if (e instanceof NoTabAudioError) autoSyncNote = t('bt.autoNoAudio')
      else if (e instanceof NoNotesError) autoSyncNote = t('bt.autoNoNotes')
      else if (e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'AbortError')) autoSyncNote = t('bt.autoDenied')
      else autoSyncNote = e instanceof Error ? e.message : String(e)
    } finally {
      recorder?.close()
      autoSyncAbort = null
      autoSync = null
      h.suspended = false
      // Відео лишаємо на паузі на початку; alphaTab стоїть на такті 1, наступний play піде зі зсуву.
      h.player.pauseVideo()
      api.stop()
    }
  }

  function cancelAutoSync() {
    autoSyncAbort?.abort()
  }

  function fmtMs(ms: number) {
    const tenths = Math.round(ms / 100)
    const m = Math.floor(tenths / 600)
    const s = (tenths - m * 600) / 10
    return `${m}:${s.toFixed(1).padStart(4, '0')}`
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

  // --- прогрес і підписи ---
  const pct = (tick: number) => (endTick > 0 ? Math.min(100, Math.max(0, (tick / endTick) * 100)) : 0)

  /** Номер такту, на якому лежить тік (за порядком відтворення). */
  function barAt(tick: number): number | null {
    let num: number | null = null
    for (const m of barMarks) {
      if (m.start > tick) break
      num = m.num
    }
    return num
  }

  const loopLabel = $derived.by(() => {
    if (!range) return t('player.loopLabel')
    const a = barAt(range.startTick)
    const b = barAt(Math.max(range.startTick, range.endTick - 1))
    if (a === null || b === null) return t('player.loopLabel')
    return a === b ? t('player.loopBar', { a }) : t('player.loopBars', { a, b })
  })

  /** Під прогресом підписуємо не більше ~12 тактів, щоб цифри не злипалися. */
  const barLabels = $derived.by(() => {
    if (barMarks.length === 0 || endTick <= 0) return []
    const every = Math.ceil(barMarks.length / 12)
    return barMarks
      .filter((_, i) => i % every === 0)
      .map((m) => ({
        ...m,
        left: pct(m.start),
        inRange: range !== null && m.start >= range.startTick && m.start < range.endTick,
      }))
  })

  const sig = $derived(session.tabTimeSignature)
  const metaParts = $derived(
    [
      tn('n.tracks', tracks.length),
      sig ? `${sig.numerator}/${sig.denominator}` : '',
      session.tabTempo ? `♩ = ${session.tabTempo}` : '',
      endTime > 0 ? fmt(endTime) : '',
    ].filter(Boolean),
  )
  const mobileMeta = $derived(
    [
      tracks[activeTrack]?.name ?? '',
      sig ? `${sig.numerator}/${sig.denominator}` : '',
      session.tabTempo ? `♩ ${session.tabTempo}` : '',
    ].filter(Boolean),
  )
  const status = $derived(
    rendering
      ? t('player.rendering')
      : !playerReady && soundFontProgress > 0 && soundFontProgress < 1
        ? t('player.sound', { p: Math.round(soundFontProgress * 100) })
        : !playerReady && hasScore
          ? t('player.loadingSound')
          : '',
  )
</script>

{#snippet trackList()}
  <div class="tracks">
    {#each tracks as track, i (track.index)}
      {@const name = track.name || t('player.trackN', { n: i + 1 })}
      <div class="track" class:current={i === activeTrack}>
        <div class="track-top">
          <span class="swatch" style:background={TRACK_COLORS[i % TRACK_COLORS.length]}></span>
          <button class="track-name" aria-pressed={i === activeTrack} onclick={() => selectTrack(i)} title={t('player.showTrack')}>
            <span class="tname">{name}</span>
            <span class="tsub">{trackInfo(track)}</span>
          </button>
          <button
            class="ms"
            aria-pressed={trackMute[i]}
            onclick={() => toggleMute(i)}
            disabled={isOrig}
            aria-label={t('player.mute', { name })}
            title={isOrig ? t('player.origOnly') : t('player.mute', { name })}>M</button
          >
          <button
            class="ms"
            aria-pressed={trackSolo[i]}
            onclick={() => toggleSolo(i)}
            disabled={isOrig}
            aria-label={t('player.solo', { name })}
            title={isOrig ? t('player.origOnly') : t('player.solo', { name })}>S</button
          >
        </div>
        <label class="tvol">
          <Icon name="volume" size={16} />
          <span class="sr-only">{t('player.volume', { name })}</span>
          <input
            type="range"
            min="0"
            max="100"
            value={trackVolume[i] ?? 100}
            disabled={isOrig}
            oninput={(e) => setTrackVolume(i, Number((e.currentTarget as HTMLInputElement).value))}
          />
        </label>
      </div>
    {/each}
  </div>
{/snippet}

{#snippet progress(compact: boolean)}
  <div class="progress" class:compact>
    <span class="bar-bg" aria-hidden="true"></span>
    {#if range}
      <span class="bar-range" aria-hidden="true" style:left="{pct(range.startTick)}%" style:width="{pct(range.endTick) - pct(range.startTick)}%"></span>
    {/if}
    <span class="bar-fill" aria-hidden="true" style:width="{pct(currentTick)}%"></span>
    <span class="bar-thumb" aria-hidden="true" style:left="{pct(currentTick)}%"></span>
    <input
      type="range"
      min="0"
      max={Math.max(1, endTick)}
      step="1"
      value={currentTick}
      disabled={!hasScore || endTick <= 0}
      aria-label={t('player.position')}
      aria-valuetext="{fmt(currentTime)} / {fmt(endTime)}"
      oninput={(e) => seek(Number((e.currentTarget as HTMLInputElement).value))}
    />
  </div>
{/snippet}

<div
  class="player"
  class:drag-over={dragOver}
  role="region"
  aria-label={t('player.aria')}
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

  {#if hasScore}
    <!-- Десктоп: рядок файлу -->
    <div class="filebar">
      <div class="file">
        <div class="file-icon"><Icon name="file" size={20} /></div>
        <div class="file-text">
          <div class="file-title" title={fileName ?? ''}>{title || fileName}{#if artist}<span class="artist"> — {artist}</span>{/if}</div>
          <div class="file-meta mono">
            {metaParts.join(' · ')}{#if status}<span class="status"> · {status}</span>{/if}
          </div>
        </div>
      </div>
      <button class="btn primary" onclick={() => fileInput.click()}>
        <Icon name="folder" />
        {t('player.open')}
      </button>
      <button class="btn" onclick={loadDemo}>
        <Icon name="sparkle" />
        {t('player.demo')}
      </button>
      <div class="spacer"></div>
      <div class="seg" role="group" aria-label={t('player.view')}>
        <button aria-pressed={view === 'both'} onclick={() => setView('both')}>{t('player.view.both')}</button>
        <button aria-pressed={view === 'tab'} onclick={() => setView('tab')}>{t('player.view.tab')}</button>
        <button aria-pressed={view === 'score'} onclick={() => setView('score')}>{t('player.view.score')}</button>
      </div>
      <div class="seg zoom" role="group" aria-label={t('player.zoom')}>
        <button onclick={() => setZoom(zoomIndex - 1)} disabled={zoomIndex === 0} aria-label={t('player.zoomOut')} title={t('player.zoomOut')}>
          <Icon name="minus" size={16} />
        </button>
        <span class="zoom-value mono">{Math.round(ZOOMS[zoomIndex] * 100)}%</span>
        <button onclick={() => setZoom(zoomIndex + 1)} disabled={zoomIndex === ZOOMS.length - 1} aria-label={t('player.zoomIn')} title={t('player.zoomIn')}>
          <Icon name="plus" size={16} />
        </button>
      </div>
    </div>

    <!-- Телефон: компактна шапка й перемикач вигляду -->
    <header class="m-head">
      <Logo size={26} />
      <div class="m-title">
        <div class="file-title">{title || fileName}</div>
        <div class="file-meta mono">{status || mobileMeta.join(' · ')}</div>
      </div>
      <button class="icon-btn plain big" aria-label={t('player.tracks')} aria-expanded={showTracks} onclick={() => (showTracks = !showTracks)}>
        <Icon name="layers" size={20} />
      </button>
      <button class="icon-btn big accent" aria-label={t('player.openFile')} onclick={() => fileInput.click()}>
        <Icon name="folder" size={20} />
      </button>
    </header>
    <div class="m-view">
      <div class="seg fill" role="group" aria-label={t('player.view')}>
        <button aria-pressed={view === 'both'} onclick={() => setView('both')}>{t('player.view.both')}</button>
        <button aria-pressed={view === 'tab'} onclick={() => setView('tab')}>{t('player.view.tab')}</button>
        <button aria-pressed={view === 'score'} onclick={() => setView('score')}>{t('player.view.score')}</button>
      </div>
    </div>
  {/if}

  {#if error}
    <div class="error-box error">{error}</div>
  {/if}

  <div class="body">
    {#if hasScore}
      <aside class="aside">
        <section class="side-section">
          <h2 class="eyebrow">{t('player.tracks')}</h2>
          {@render trackList()}
        </section>
        <RecentFiles variant="aside" current={fileName} onopen={(name, data) => openBytes(name, data, false)} refreshKey={recentKey} />
        <p class="note-line privacy"><Icon name="lock" size={16} />{t('player.privacyAside')}</p>
      </aside>
    {/if}

    <div class="score" class:idle={!hasScore} bind:this={scroller}>
      <div class="paper">
        <div class="at-host" bind:this={host}></div>
      </div>
    </div>

    {#if !hasScore}
      <div class="empty">
        <div class="m-brand"><Logo size={26} />Noodler</div>
        <div class="drop" class:over={dragOver}>
          <div class="drop-icon"><Icon name="upload" size={34} stroke={1.8} /></div>
          <div>
            <h1>{t('player.dropTitle')}</h1>
            <p>{t('player.dropText')}</p>
          </div>
          <div class="exts mono">
            <span>.gp</span><span>.gp5</span><span>.gpx</span>
          </div>
          <div class="drop-actions">
            <button class="btn primary lg" onclick={() => fileInput.click()}>
              <Icon name="folder" />
              {t('player.openFile')}
            </button>
            <button class="btn lg" onclick={loadDemo}>
              <Icon name="sparkle" />
              {t('player.tryDemo')}
            </button>
          </div>
          <p class="drop-privacy"><Icon name="lock" size={15} />{t('player.privacy')}</p>
        </div>

        <div class="empty-recent">
          <RecentFiles variant="page" onopen={(name, data) => openBytes(name, data, false)} refreshKey={recentKey} />
        </div>

        <div class="empty-keys">
          <span><kbd>{t('keys.space')}</kbd> {t('keys.playPause')}</span>
          <span><kbd>L</kbd> {t('keys.loop')}</span>
          <span><kbd>B</kbd> {t('keys.backing')}</span>
          <span><kbd>Esc</kbd> {t('keys.stop')}</span>
        </div>

        <div class="empty-prefs"><Prefs /></div>
      </div>
    {/if}
  </div>

  {#if showTracks && hasScore}
    <!-- Телефон: доріжки в нижньому аркуші -->
    <div class="sheet-backdrop" role="presentation" onclick={() => (showTracks = false)}></div>
    <div class="sheet" role="dialog" aria-label={t('player.tracks')}>
      <div class="sheet-handle" aria-hidden="true"></div>
      <div class="sheet-head">
        <h2>{t('player.tracks')}</h2>
        <button class="icon-btn big" onclick={() => (showTracks = false)} aria-label={t('player.close')}>
          <Icon name="x" />
        </button>
      </div>
      {@render trackList()}
    </div>
  {/if}

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
      canAutoSync={canAutoSync && isOrig && handlerReady}
      {autoSync}
      {autoSyncNote}
      onautosync={() => void runAutoSync()}
      onautosynccancel={cancelAutoSync}
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

  {#if hasScore}
    <!-- Десктоп: транспорт -->
    <footer class="transport">
      <div class="t-main">
        <button class="t-stop" onclick={stop} aria-label={t('player.stop')} title={t('player.stop')}>
          <Icon name="stop" size={16} />
        </button>
        <button class="t-play" onclick={playPause} disabled={!playerReady} aria-label={t('player.playPause')} title={t('player.playPause')}>
          <Icon name={playing ? 'pause' : 'play'} size={22} />
        </button>
        <span class="time mono">{fmt(currentTime)} <span class="time-end">/ {fmt(endTime)}</span></span>
      </div>

      <div class="t-progress">
        {@render progress(false)}
        <div class="bar-labels mono" aria-hidden="true">
          {#each barLabels as b (b.start)}
            <span class:in-range={b.inRange} style:left="{b.left}%">{b.num}</span>
          {/each}
        </div>
      </div>

      <div class="seg tempo" role="group" aria-label={t('player.tempo')}>
        <span class="tempo-label">{t('player.tempo')}</span>
        <button class="step" onclick={() => setSpeed(speed - speedStep)} disabled={speed <= speedMin} aria-label={t('player.slower')} title={t('player.slower')}>
          <Icon name="minus" size={16} />
        </button>
        <span class="tempo-value mono">{speed}%</span>
        <button class="step" onclick={() => setSpeed(speed + speedStep)} disabled={speed >= speedMax} aria-label={t('player.faster')} title={t('player.faster')}>
          <Icon name="plus" size={16} />
        </button>
      </div>

      <div class="t-toggles">
        <button class="toggle" aria-pressed={looping} onclick={toggleLoop} title={t('player.loop')}>
          <Icon name="loop" />
          {loopLabel}
        </button>
        {#if hasRange}
          <button class="icon-btn" onclick={clearRange} aria-label={t('player.clearRange')} title={t('player.clearRange')}>
            <Icon name="x" size={16} />
          </button>
        {/if}
        <button class="toggle" aria-pressed={metronome} onclick={toggleMetronome} disabled={isOrig} title={isOrig ? t('player.origOnly') : t('player.clickTitle')}>
          <Icon name="click" />
          {t('player.click')}
        </button>
        <button class="toggle" aria-pressed={countIn} onclick={toggleCountIn} disabled={isOrig} title={isOrig ? t('player.origOnly') : t('player.countInTitle')}>
          <Icon name="timer" />
          {t('player.countIn')}
        </button>
        <button class="toggle" aria-pressed={showBacking || isOrig} onclick={() => (showBacking = !showBacking)} title={t('player.backingTitle')}>
          <Icon name="headphones" />
          {isOrig ? 'ORIG' : t('player.backing')}
          {#if !videoId && ytResults.length > 0}<span class="dot" aria-label={t('player.found')}></span>{/if}
        </button>
      </div>
    </footer>

    <!-- Телефон: транспорт -->
    <section class="m-transport" aria-label={t('player.transport')}>
      <div class="m-progress mono">
        <span>{fmt(currentTime)}</span>
        {@render progress(true)}
        <span>{fmt(endTime)}</span>
      </div>
      <div class="m-buttons">
        <button class="m-btn" aria-pressed={metronome} onclick={toggleMetronome} disabled={isOrig} aria-label={t('player.clickTitle')}>
          <Icon name="click" size={22} />
        </button>
        <button class="m-btn boxed" onclick={stop} aria-label={t('player.stop')}>
          <Icon name="stop" size={16} />
        </button>
        <button class="t-play big" onclick={playPause} disabled={!playerReady} aria-label={t('player.playPause')}>
          <Icon name={playing ? 'pause' : 'play'} size={26} />
        </button>
        <button class="m-btn" class:boxed={looping} aria-pressed={looping} onclick={toggleLoop} aria-label={loopLabel}>
          <Icon name="loop" size={20} />
        </button>
        <button class="m-btn" aria-pressed={showBacking || isOrig} onclick={() => (showBacking = !showBacking)} aria-label={t('player.backingTitle')}>
          <Icon name="headphones" size={22} />
          {#if !videoId && ytResults.length > 0}<span class="dot corner" aria-label={t('player.found')}></span>{/if}
        </button>
      </div>
      <div class="m-tempo">
        <button class="toggle small mono" aria-pressed={countIn} onclick={toggleCountIn} disabled={isOrig} aria-label={t('player.countInTitle')}>1·2·3·4</button>
        <label>
          {t('player.tempo')}
          <input
            type="range"
            min={speedMin}
            max={speedMax}
            step={speedStep}
            value={speed}
            oninput={(e) => setSpeed(Number((e.currentTarget as HTMLInputElement).value))}
          />
        </label>
        <span class="tempo-value mono">{speed}%</span>
      </div>
    </section>
  {/if}
</div>

<style>
  .player {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  /* --- рядок файлу --- */
  .filebar {
    padding: 14px 24px;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px 16px;
    border-bottom: 1px solid var(--line);
    flex: none;
  }

  .file {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
    max-width: 420px;
  }

  .file-icon {
    width: 40px;
    height: 40px;
    flex: none;
    border-radius: 10px;
    background: var(--accent-soft);
    border: 1px solid var(--line);
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--accent-ink);
  }

  .file-text {
    min-width: 0;
  }

  .file-title {
    font-size: 16px;
    font-weight: 600;
    line-height: 1.3;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .artist {
    color: var(--muted);
    font-weight: 500;
  }

  .file-meta {
    font-size: 12px;
    line-height: 1.5;
    color: var(--muted-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .status {
    color: var(--accent-ink);
  }

  .spacer {
    flex: 1;
  }

  .zoom {
    align-items: center;
  }

  .zoom > button {
    width: 34px;
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  .zoom-value {
    min-width: 48px;
    text-align: center;
    font-size: 13px;
  }

  .error {
    margin: 12px 24px 0;
    flex: none;
  }

  /* --- основна зона --- */
  .body {
    --aside-w: 300px;
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    position: relative;
  }

  .player.drag-over .score {
    outline: 3px dashed var(--accent);
    outline-offset: -10px;
  }

  .aside {
    flex: 0 0 var(--aside-w);
    padding: 20px;
    border-right: 1px solid var(--line);
    display: flex;
    flex-direction: column;
    gap: 28px;
    overflow-y: auto;
  }

  .side-section {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .privacy {
    margin-top: auto;
  }

  .tracks {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .track {
    padding: 12px;
    border-radius: 12px;
    background: var(--surface);
    border: 1px solid var(--line);
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .track.current {
    background: var(--surface-2);
    border-color: var(--accent-line);
  }

  .track-top {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .swatch {
    width: 8px;
    height: 28px;
    flex: none;
    border-radius: 4px;
  }

  .track-name {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    text-align: left;
  }

  .tname {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tsub {
    font-size: 12px;
    color: var(--muted-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ms {
    width: 36px;
    height: 36px;
    flex: none;
    border-radius: 8px;
    border: 1px solid var(--line-2);
    background: var(--card);
    color: var(--muted);
    font-weight: 600;
    font-size: 13px;
  }

  .ms[aria-pressed='true'] {
    border-color: var(--accent);
    background: var(--accent);
    color: var(--on-accent);
  }

  .tvol {
    display: flex;
    align-items: center;
    gap: 10px;
    color: var(--faint);
  }

  .tvol input {
    flex: 1;
    min-width: 0;
    margin: 0;
  }

  .score {
    flex: 1 1 auto;
    min-width: 0;
    overflow: auto;
    padding: 24px;
    background: var(--bg-sunken);
  }

  /* Без файлу контейнер alphaTab лишається в розмітці (API вже створено), але невидимий.
     Ліворуч лишаємо місце під бокову панель: alphaTab рендерить файл ще до її появи,
     і ширина нотного стану має одразу збігтися з фінальною. */
  .score.idle {
    position: absolute;
    inset: 0 0 0 var(--aside-w);
    visibility: hidden;
    pointer-events: none;
  }

  .paper {
    min-height: 100%;
    padding: 20px 24px 32px;
    border-radius: 16px;
    background: var(--paper);
    color: var(--paper-ink);
  }

  /* --- стартовий екран --- */
  .empty {
    flex: 1 1 auto;
    overflow-y: auto;
    padding: 48px 24px 56px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 40px;
  }

  .drop {
    width: 100%;
    max-width: 760px;
    padding: 56px 32px;
    border: 1.5px dashed var(--line-3);
    border-radius: 24px;
    background: var(--card);
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: 20px;
    transition: border-color 0.15s, background 0.15s;
  }

  .drop.over {
    border-color: var(--accent);
    background: var(--accent-soft);
  }

  .drop-icon {
    width: 72px;
    height: 72px;
    border-radius: 20px;
    background: var(--accent-soft);
    color: var(--accent-ink);
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .drop h1 {
    margin: 0;
    font-size: 28px;
    font-weight: 700;
    letter-spacing: -0.02em;
    line-height: 1.2;
  }

  .drop h1 + p {
    margin: 10px 0 0;
    font-size: 15px;
    color: var(--muted);
    line-height: 1.5;
  }

  .exts {
    display: flex;
    gap: 8px;
  }

  .exts span {
    padding: 4px 10px;
    border-radius: 999px;
    background: var(--surface-3);
    border: 1px solid var(--line-2);
    font-size: 12px;
    color: var(--text-2);
  }

  .drop-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 12px;
    margin-top: 4px;
  }

  .drop-privacy {
    margin: 8px 0 0;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    color: var(--faint);
  }

  .drop-privacy :global(svg) {
    flex: none;
  }

  .empty-recent {
    width: 100%;
    max-width: 760px;
  }

  .empty-keys {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 8px 20px;
    font-size: 12px;
    color: var(--faint);
  }

  .empty-prefs,
  .m-brand {
    display: none;
  }

  /* --- транспорт --- */
  .transport {
    flex: none;
    border-top: 1px solid var(--line);
    background: var(--footer);
    padding: 12px 24px calc(12px + env(safe-area-inset-bottom));
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px 24px;
  }

  .t-main {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .t-stop {
    width: 44px;
    height: 44px;
    border-radius: 12px;
    border: 1px solid var(--line-2);
    background: var(--surface-2);
    color: var(--text);
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  .t-play {
    width: 52px;
    height: 52px;
    flex: none;
    border-radius: 50%;
    background: var(--accent);
    color: var(--on-accent);
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  .t-play.big {
    width: 64px;
    height: 64px;
  }

  .time {
    margin-left: 4px;
    font-size: 14px;
    white-space: nowrap;
  }

  .time-end {
    color: var(--faint);
  }

  .t-progress {
    flex: 1 1 320px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .progress {
    position: relative;
    height: 20px;
  }

  .progress span {
    position: absolute;
    pointer-events: none;
  }

  .bar-bg {
    left: 0;
    right: 0;
    top: 7px;
    height: 6px;
    border-radius: 3px;
    background: var(--line-2);
  }

  .bar-range {
    top: 4px;
    height: 12px;
    border-radius: 4px;
    background: color-mix(in srgb, var(--accent) 20%, transparent);
    border: 1px solid var(--accent-line);
  }

  .bar-fill {
    left: 0;
    top: 7px;
    height: 6px;
    border-radius: 3px;
    background: var(--accent);
  }

  .bar-thumb {
    top: 2px;
    width: 16px;
    height: 16px;
    margin-left: -8px;
    border-radius: 8px;
    background: #fff;
    border: 2px solid var(--accent-ink);
  }

  .progress input {
    position: absolute;
    inset: 0;
    width: 100%;
    margin: 0;
    opacity: 0;
    cursor: pointer;
  }

  .progress.compact .bar-bg,
  .progress.compact .bar-fill {
    top: 8px;
    height: 4px;
  }

  .progress.compact .bar-range {
    top: 5px;
    height: 10px;
  }

  .progress.compact .bar-thumb {
    top: 3px;
    width: 14px;
    height: 14px;
    margin-left: -7px;
    border-width: 0;
  }

  .progress:has(input:focus-visible) .bar-thumb {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .bar-labels {
    position: relative;
    height: 14px;
    font-size: 11px;
    color: var(--faint);
  }

  .bar-labels span {
    position: absolute;
    transform: translateX(-50%);
  }

  .bar-labels span:first-child {
    transform: none;
  }

  .bar-labels .in-range {
    color: var(--accent-ink);
    font-weight: 700;
  }

  .tempo {
    align-items: center;
    gap: 4px;
    border-radius: 12px;
  }

  .tempo-label {
    padding: 0 8px 0 10px;
    font-size: 13px;
    color: var(--muted);
  }

  .tempo-value {
    min-width: 54px;
    text-align: center;
    font-size: 14px;
    font-weight: 700;
  }

  .t-toggles {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .t-toggles .icon-btn {
    width: 32px;
    height: 32px;
    margin-left: -4px;
  }

  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--accent);
  }

  .dot.corner {
    position: absolute;
    top: 10px;
    right: 10px;
  }

  /* --- нижній аркуш і мобільні блоки (за замовчуванням сховані) --- */
  .m-head,
  .m-view,
  .m-transport,
  .sheet,
  .sheet-backdrop {
    display: none;
  }

  /* --- нотний стан: елементи, які малює alphaTab --- */
  .score :global(.at-cursor-bar) {
    background: color-mix(in srgb, var(--accent) 16%, transparent);
  }

  .score :global(.at-selection div) {
    background: color-mix(in srgb, var(--accent) 18%, transparent);
  }

  .score :global(.at-cursor-beat) {
    background: var(--accent);
    width: 2px;
  }

  .score :global(.at-highlight *) {
    fill: #b45309;
    stroke: #b45309;
  }

  /* Планшет: бокова панель вужча. */
  @media (max-width: 1100px) {
    .body {
      --aside-w: 260px;
    }

    .aside {
      padding: 16px;
    }

    .score {
      padding: 16px;
    }
  }

  /* Телефон */
  @media (max-width: 720px) {
    .body {
      --aside-w: 0px;
    }

    .filebar,
    .aside,
    .transport,
    .empty-keys {
      display: none;
    }

    .m-head {
      height: 60px;
      flex: none;
      padding: 8px 8px 8px 16px;
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .m-title {
      flex: 1;
      min-width: 0;
    }

    .m-title .file-title {
      font-size: 16px;
      line-height: 1.25;
    }

    .m-title .file-meta {
      font-size: 11px;
    }

    .icon-btn.big {
      width: 44px;
      height: 44px;
      border-radius: 12px;
    }

    .icon-btn.accent {
      border-color: transparent;
      background: var(--surface-2);
      color: var(--accent-ink);
    }

    .m-view {
      display: block;
      flex: none;
      padding: 0 16px 10px;
    }

    .m-view .seg {
      border-radius: 12px;
    }

    .m-view .seg > button {
      height: 36px;
      border-radius: 9px;
    }

    .error {
      margin: 0 12px 10px;
    }

    .score {
      padding: 0 12px;
      background: transparent;
    }

    .paper {
      padding: 8px 4px 16px;
    }

    .empty {
      padding: 20px 16px 32px;
      gap: 28px;
    }

    .drop {
      padding: 36px 20px;
    }

    .drop h1 {
      font-size: 22px;
    }

    .drop-actions {
      flex-direction: column;
      align-self: stretch;
    }

    .empty-prefs {
      display: block;
    }

    .m-brand {
      align-self: flex-start;
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: -8px;
      font-size: 18px;
      font-weight: 700;
      letter-spacing: -0.02em;
    }

    .m-transport {
      flex: none;
      margin-top: 10px;
      padding: 12px 16px 10px;
      background: var(--card);
      border-top: 1px solid var(--line);
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .m-progress {
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 11px;
      color: var(--muted);
    }

    .m-progress .progress {
      flex: 1;
    }

    .m-buttons {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .m-btn {
      position: relative;
      width: 48px;
      height: 48px;
      border-radius: 14px;
      border: 1px solid transparent;
      color: var(--muted);
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }

    .m-btn.boxed {
      border-color: var(--line-2);
      background: var(--surface-2);
      color: var(--text);
    }

    .m-btn[aria-pressed='true'] {
      border-color: var(--accent);
      background: var(--accent-soft);
      color: var(--accent-ink);
    }

    .m-tempo {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .toggle.small {
      height: 36px;
      padding: 0 10px;
      border-radius: 10px;
      font-size: 12px;
    }

    .m-tempo label {
      flex: 1;
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 13px;
      color: var(--muted);
    }

    .m-tempo input {
      flex: 1;
      min-width: 0;
      margin: 0;
    }

    .m-tempo .tempo-value {
      min-width: 44px;
      text-align: right;
      font-size: 13px;
    }

    .sheet-backdrop {
      display: block;
      position: fixed;
      inset: 0;
      z-index: 30;
      background: #000000b3;
    }

    .sheet {
      position: fixed;
      left: 0;
      right: 0;
      bottom: 0;
      z-index: 31;
      max-height: 80vh;
      overflow-y: auto;
      border-radius: 24px 24px 0 0;
      background: var(--surface);
      border-top: 1px solid var(--line-2);
      padding: 8px 16px calc(20px + env(safe-area-inset-bottom));
      display: flex;
      flex-direction: column;
      gap: 14px;
    }

    .sheet-handle {
      align-self: center;
      width: 40px;
      height: 5px;
      border-radius: 3px;
      background: var(--line-3);
    }

    .sheet-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .sheet-head h2 {
      margin: 0;
      font-size: 18px;
      font-weight: 700;
    }

    .sheet .track {
      background: var(--surface-2);
    }
  }
</style>
