<script lang="ts">
  import { onMount } from 'svelte';
  import { loadCore, core_version } from './lib/core';
  import {
    SynthClient,
    MODE_LABELS,
    type MidiInfoSnapshot,
    type MidiModeId,
    type PositionSnapshot,
  } from './lib/player';
  import {
    DEFAULT_FILTERS,
    FILTER_LABELS,
    lineMatches,
    type FilterFlags,
  } from './lib/logFilter';
  import {
    loadVolume,
    saveVolume,
    loadLoop,
    saveLoop,
    loadSf2Handle,
    saveSf2Handle,
    clearSf2Handle,
  } from './lib/persist';
  import FileLoader from './components/FileLoader.svelte';
  import Controls from './components/Controls.svelte';
  import LogView from './components/LogView.svelte';
  import Segmented from './components/Segmented.svelte';
  import Switch from './components/Switch.svelte';
  import Slider from './components/Slider.svelte';

  // Cap MIDI event log to prevent unbounded growth.
  // ~10k lines × ~60 bytes ≈ 600 KB — comfortable.
  const MAX_LOG_LINES = 10_000;

  // ---- Bootstrap state -----------------------------------------------------
  let coreReady = $state(false);
  let coreVersion = $state('');
  let crossOriginIsolated = $state(false);

  // `preparing` covers both the WASM load and the wait for the user's
  // first gesture; `starting` is the brief window between click and
  // `ctx.resume()` completing. The boot overlay is shown unless `ready`.
  let audioStatus = $state<'preparing' | 'starting' | 'ready' | 'error'>('preparing');
  let prepared = $state(false);
  let wasmLoaded = $state(0);
  let wasmTotal = $state(0);
  let workletSampleRate = $state<number | null>(null);
  let lastError = $state<string | null>(null);

  // ---- File / playback state ----------------------------------------------
  let sf2Loaded = $state(false);
  let sf2Name = $state<string | null>(null);
  let sf2Size = $state<number | null>(null);
  let midiInfo = $state<MidiInfoSnapshot | null>(null);
  let midiName = $state<string | null>(null);
  let midiSize = $state<number | null>(null);

  let position = $state<PositionSnapshot>({ tick: 0, secs: 0, bpm: 120, isPlaying: false });
  let modeOverride = $state<MidiModeId | 'auto'>('auto');
  // Restore last session's preferences synchronously from localStorage so the
  // first render already shows the persisted values.
  let loopEnabled = $state(loadLoop());
  // Slider domain is 0..100; the audible gain is volume²/10000 so the
  // perceived loudness curve feels roughly linear to the ear.
  let volume = $state(loadVolume());

  // Read the reactive dep outside the optional chain. `client?.x(arg)`
  // short-circuits when client is null, which skips arg evaluation and
  // therefore skips dependency tracking — the effect would never re-run
  // when the dep changes later.
  $effect(() => {
    const enabled = loopEnabled;
    client?.setLoop(enabled);
    saveLoop(enabled);
  });
  $effect(() => {
    const v = volume;
    client?.setVolume((v / 100) ** 2);
    saveVolume(v);
  });
  let logLines = $state<string[]>([]);
  let autoFollow = $state(true);
  let filters = $state<FilterFlags>({ ...DEFAULT_FILTERS });

  // Filtered view fed to LogView. Recomputes only when logLines or filters
  // change — cheap enough for 10k-row logs.
  const filteredLogLines = $derived(
    Object.values(filters).every(Boolean)
      ? logLines
      : logLines.filter((line) => lineMatches(line, filters)),
  );

  let client: SynthClient | null = null;
  let preparePromise: Promise<void> | null = null;
  // Reactive so the "Restore last SF2" button shows up once the handle
  // has been read from IndexedDB. Cleared after a successful restore or
  // when the user revokes permission.
  let pendingSf2Handle = $state<FileSystemFileHandle | null>(null);

  const canPlay = $derived(audioStatus === 'ready' && sf2Loaded && !!midiInfo);

  const effectiveMode = $derived<MidiModeId | null>(
    modeOverride === 'auto'
      ? (midiInfo?.detected_mode ?? null)
      : modeOverride,
  );

  const modeOptions = [
    { value: 'auto' as const, label: 'Auto' },
    { value: 0 as MidiModeId, label: MODE_LABELS[0] },
    { value: 1 as MidiModeId, label: MODE_LABELS[1] },
    { value: 2 as MidiModeId, label: MODE_LABELS[2] },
    { value: 3 as MidiModeId, label: MODE_LABELS[3] },
  ];

  const filterKeys = Object.keys(FILTER_LABELS) as Array<keyof FilterFlags>;

  onMount(() => {
    crossOriginIsolated = self.crossOriginIsolated;

    // Main-thread core init is independent of audio; let it resolve in
    // the background so the version chip lights up when ready.
    void loadCore().then(() => {
      coreVersion = core_version();
      coreReady = true;
    });
    void loadSf2Handle().then((h) => {
      pendingSf2Handle = h;
    });

    client = new SynthClient({
      onReady: (sr) => {
        workletSampleRate = sr;
        // The $effect for volume/loop already ran at mount with client=null,
        // so apply the current values explicitly now that the audio graph
        // exists. Otherwise the worklet keeps its built-in defaults instead
        // of the persisted ones.
        client?.setVolume((volume / 100) ** 2);
        client?.setLoop(loopEnabled);
      },
      onSf2Loaded: () => {
        sf2Loaded = true;
      },
      onMidiLoaded: (info) => {
        midiInfo = info;
      },
      onPosition: (p) => {
        position = p;
      },
      onLogLines: (lines) => {
        const combined = logLines.length + lines.length;
        if (combined > MAX_LOG_LINES) {
          logLines = [...logLines.slice(combined - MAX_LOG_LINES), ...lines];
        } else {
          logLines = [...logLines, ...lines];
        }
      },
      onError: (msg) => {
        lastError = msg;
        audioStatus = 'error';
      },
    });

    // Kick off WASM compile + worklet load eagerly. No user gesture is
    // required for this phase; the context stays suspended until the
    // overlay click runs resume().
    preparePromise = client.prepare((loaded, total) => {
      wasmLoaded = loaded;
      wasmTotal = total;
    });
    preparePromise
      .then(() => {
        prepared = true;
      })
      .catch((e) => {
        lastError = String(e);
        audioStatus = 'error';
      });
  });

  async function startAudio() {
    if (audioStatus !== 'preparing' || !client || !preparePromise) return;
    audioStatus = 'starting';
    // Dispatch resume() synchronously inside the click handler so the
    // transient activation token is consumed before any await — a long
    // WASM compile would otherwise expire the gesture (~5 s window) and
    // the resume would silently fail.
    const resumePromise = client.resume();
    try {
      await preparePromise;
      await resumePromise;
      audioStatus = 'ready';
    } catch (e) {
      lastError = String(e);
      audioStatus = 'error';
    }
  }

  function onOverlayKey(e: KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      void startAudio();
    }
  }

  async function restoreSf2() {
    const handle = pendingSf2Handle;
    if (!handle || !client) return;
    if (await ensureReadPermission(handle)) {
      await loadSf2FromHandle(handle);
    } else {
      await clearSf2Handle();
    }
    pendingSf2Handle = null;
  }

  function handleSf2(
    bytes: Uint8Array,
    name: string,
    handle: FileSystemFileHandle | undefined,
  ) {
    sf2Loaded = false;
    sf2Name = name;
    sf2Size = bytes.byteLength;
    client?.loadSf2(bytes);
    // Browsers without the File System Access API never hand us a handle;
    // wipe any stale entry from a previous capable-browser session so a
    // newer pick isn't shadowed by an old auto-restore.
    if (handle) void saveSf2Handle(handle);
    else void clearSf2Handle();
  }

  function handleMidi(
    bytes: Uint8Array,
    name: string,
    _handle: FileSystemFileHandle | undefined,
  ) {
    midiInfo = null;
    midiName = name;
    midiSize = bytes.byteLength;
    position = { tick: 0, secs: 0, bpm: 120, isPlaying: false };
    logLines = [];
    changeModeOverride('auto');
    client?.loadMidi(bytes);
  }

  // queryPermission first to avoid an unnecessary prompt when the user
  // previously chose "Allow on every visit"; otherwise prompt via
  // requestPermission. Returns false on any failure so the caller can
  // fall back to a clean unloaded state.
  async function ensureReadPermission(handle: FileSystemFileHandle): Promise<boolean> {
    const h = handle as unknown as {
      queryPermission?: (d: { mode: 'read' }) => Promise<PermissionState>;
      requestPermission?: (d: { mode: 'read' }) => Promise<PermissionState>;
    };
    if (typeof h.queryPermission !== 'function' || typeof h.requestPermission !== 'function') {
      return false;
    }
    try {
      let state = await h.queryPermission({ mode: 'read' });
      if (state === 'granted') return true;
      state = await h.requestPermission({ mode: 'read' });
      return state === 'granted';
    } catch {
      return false;
    }
  }

  async function loadSf2FromHandle(handle: FileSystemFileHandle): Promise<void> {
    try {
      const file = await handle.getFile();
      const buf = await file.arrayBuffer();
      sf2Loaded = false;
      sf2Name = file.name;
      sf2Size = buf.byteLength;
      client?.loadSf2(new Uint8Array(buf));
    } catch {
      // File was moved or deleted between save and read; drop the stale entry.
      await clearSf2Handle();
    }
  }

  function changeModeOverride(v: MidiModeId | 'auto') {
    modeOverride = v;
    client?.setModeOverride(v === 'auto' ? null : v);
  }

  function toggleFilter(key: keyof FilterFlags) {
    filters = { ...filters, [key]: !filters[key] };
  }

  function playPause() {
    if (position.isPlaying) client?.pause();
    else client?.play();
  }

  function fmtTime(secs: number): string {
    if (!isFinite(secs) || secs < 0) return '-:--';
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }
</script>

<main>
  <header>
    <h1>web-midi-player</h1>
    <div class="status-line">
      <span>core <code>{coreReady ? coreVersion : '...'}</code></span>
      {#if workletSampleRate}<span>·</span><span>{workletSampleRate} Hz</span>{/if}
      {#if !crossOriginIsolated}<span class="warn">· not cross-origin-isolated</span>{/if}
    </div>
  </header>

  <section>
    <h2>Files</h2>
    <FileLoader
      label="SF2"
      accept=".sf2,.sf3"
      fileName={sf2Name}
      fileSize={sf2Size}
      onload={handleSf2}
    />
    {#if pendingSf2Handle && audioStatus === 'ready'}
      <div class="restore-row">
        <button class="btn-ghost" type="button" onclick={restoreSf2}>
          前回のSF2を復元
        </button>
        <span class="dim">stored from last visit</span>
      </div>
    {/if}
    <FileLoader
      label="MIDI"
      accept=".mid,.midi"
      fileName={midiName}
      fileSize={midiSize}
      onload={handleMidi}
    />
    {#if lastError}<p class="err"><code>{lastError}</code></p>{/if}
  </section>

  <section>
    <h2>Mode</h2>
    <Segmented
      options={modeOptions}
      value={modeOverride}
      onchange={changeModeOverride}
    />
    <p class="meta">
      effective: <code>{effectiveMode === null ? '-' : MODE_LABELS[effectiveMode]}</code>
      {#if midiInfo && modeOverride === 'auto'}
        <span class="dim">(detected from file)</span>
      {/if}
    </p>
  </section>

  {#if midiInfo}
    <section>
      <h2>Info</h2>
      <dl>
        <dt>SMF format</dt><dd><code>{midiInfo.format}</code></dd>
        <dt>Tracks</dt><dd><code>{midiInfo.track_count}</code></dd>
        <dt>Ports</dt><dd><code>{midiInfo.port_count}</code></dd>
        <dt>Resolution</dt><dd><code>{midiInfo.ticks_per_quarter} TPQ</code></dd>
        <dt>Notes</dt><dd><code>{midiInfo.total_notes.toLocaleString()}</code></dd>
        <dt>BPM</dt><dd><code>{position.bpm.toFixed(2)}</code></dd>
        <dt>Duration</dt><dd><code>{fmtTime(midiInfo.duration_secs)}</code></dd>
      </dl>
    </section>
  {/if}

  <section>
    <h2>Transport</h2>
    <Controls
      {canPlay}
      isPlaying={position.isPlaying}
      onplaypause={playPause}
      onstop={() => client?.stop()}
    />
    <div class="transport-meta">
      <span class="time">
        <code>{fmtTime(position.secs)}</code>
        <span class="dim">/ {fmtTime(midiInfo?.duration_secs ?? 0)}</span>
      </span>
      <div class="transport-controls">
        <Slider bind:value={volume} label="Vol" format={(v) => `${v}%`} />
        <Switch bind:checked={loopEnabled} label="Loop" />
      </div>
    </div>
  </section>

  <section>
    <div class="log-header">
      <h2>Log</h2>
      <div class="log-actions">
        <Switch bind:checked={autoFollow} label="Auto-scroll" />
        <button class="btn-ghost" onclick={() => (logLines = [])}>Clear</button>
        <span class="dim">{logLines.length.toLocaleString()} events</span>
      </div>
    </div>
    <div class="filter-chips">
      {#each filterKeys as key}
        <button
          type="button"
          class="chip"
          class:active={filters[key]}
          onclick={() => toggleFilter(key)}
          aria-pressed={filters[key]}
        >
          {FILTER_LABELS[key]}
        </button>
      {/each}
    </div>
    <LogView lines={filteredLogLines} bind:autoFollow />
  </section>

  <footer>
    <a
      href="https://github.com/yuiAs/web-midi-player"
      target="_blank"
      rel="noopener noreferrer"
    >
      GitHub
    </a>
  </footer>
</main>

{#if audioStatus !== 'ready'}
  <!-- Full-page gesture trap. The browser will only resume() the audio
       context from inside a user activation, so any click on this layer
       doubles as the start signal. The main UI is rendered underneath so
       the dismiss feels instantaneous, with no second layout pass. -->
  <div
    class="boot-overlay"
    role="button"
    tabindex="0"
    aria-label="Click anywhere to start audio"
    onclick={startAudio}
    onkeydown={onOverlayKey}
  >
    <div class="boot-card" role="status" aria-live="polite">
      {#if audioStatus === 'error'}
        <h2>Audio failed to start</h2>
        {#if lastError}<p class="err"><code>{lastError}</code></p>{/if}
        <p class="dim">Reload the page to retry.</p>
      {:else if audioStatus === 'starting'}
        <h2>Starting…</h2>
        <progress aria-label="starting audio"></progress>
      {:else if prepared}
        <h2>Ready</h2>
        <p>Click anywhere — or press Enter — to start audio.</p>
      {:else}
        <h2>Loading core…</h2>
        {#if wasmTotal > 0}
          <progress value={wasmLoaded} max={wasmTotal}></progress>
          <p class="dim">
            {(wasmLoaded / 1024).toFixed(0)} / {(wasmTotal / 1024).toFixed(0)} KB
          </p>
        {:else}
          <progress aria-label="loading WASM"></progress>
        {/if}
        <p class="dim hint">You can click now; playback will start as soon as the core is ready.</p>
      {/if}
    </div>
  </div>
{/if}

<style>
  main {
    max-width: 720px;
    margin: 0 auto;
    padding: 1.5rem 1rem 3rem;
    color: var(--fg);
  }

  header {
    border-bottom: 1px solid var(--border);
    padding-bottom: 0.75rem;
    margin-bottom: 1.5rem;
  }
  h1 { margin: 0; font-size: 1.5rem; font-weight: 600; }
  h2 {
    margin: 0 0 0.5rem;
    font-size: 1rem;
    font-weight: 600;
    color: var(--fg-secondary);
  }

  .status-line {
    margin-top: 0.25rem;
    font-size: 0.8rem;
    color: var(--fg-muted);
    display: flex;
    gap: 0.4rem;
    flex-wrap: wrap;
  }
  .status-line .warn { color: var(--danger); }

  section { margin-bottom: 1.5rem; }

  .restore-row {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    margin: 0.25rem 0 0.5rem 4rem;
    font-size: 0.85rem;
  }

  .boot-overlay {
    position: fixed;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: color-mix(in srgb, var(--bg) 70%, transparent);
    backdrop-filter: blur(4px);
    -webkit-backdrop-filter: blur(4px);
    z-index: 100;
    cursor: pointer;
  }
  .boot-overlay:focus-visible {
    outline: none;
  }
  .boot-overlay:focus-visible .boot-card {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .boot-card {
    background: var(--bg);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 1.6rem 2rem;
    min-width: 280px;
    max-width: min(420px, calc(100vw - 2rem));
    text-align: center;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.18);
  }
  .boot-card h2 { margin: 0 0 0.6rem; }
  .boot-card p { margin: 0.4rem 0 0; font-size: 0.9rem; }
  .boot-card .hint { margin-top: 0.6rem; font-size: 0.78rem; }
  .boot-card progress {
    display: block;
    width: 100%;
    height: 8px;
    margin: 0.5rem 0 0.2rem;
    accent-color: var(--accent);
  }

  code {
    background: var(--code-bg);
    padding: 0.05rem 0.3rem;
    border-radius: 3px;
    font-family: ui-monospace, Consolas, monospace;
    font-size: 0.85rem;
    color: var(--fg);
  }

  .err {
    color: var(--danger);
    margin: 0.5rem 0 0;
    font-size: 0.85rem;
  }

  dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.25rem 1rem;
    margin: 0;
  }
  dl dt { color: var(--fg-muted); font-size: 0.9rem; }
  dl dd { margin: 0; }

  .transport-meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    flex-wrap: wrap;
    margin-top: 0.75rem;
  }
  .transport-controls {
    display: flex;
    align-items: center;
    gap: 1rem;
    flex-wrap: wrap;
  }
  .time {
    font-size: 0.95rem;
    display: flex;
    gap: 0.5rem;
    align-items: baseline;
  }
  .dim { color: var(--fg-dim); }

  .meta {
    margin: 0.5rem 0 0;
    font-size: 0.9rem;
    color: var(--fg-secondary);
  }

  .log-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    flex-wrap: wrap;
    margin-bottom: 0.4rem;
  }
  .log-header h2 { margin: 0; }
  .log-actions {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    font-size: 0.85rem;
  }

  .filter-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    margin: 0 0 0.5rem;
  }
  .chip {
    padding: 0.2rem 0.7rem;
    font-size: 0.78rem;
    font-weight: 500;
    border-radius: 999px;
    background: transparent;
    color: var(--fg-muted);
    border: 1px solid var(--border);
    cursor: pointer;
    transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
  }
  .chip:hover { color: var(--fg); }
  .chip.active {
    background: var(--accent);
    color: var(--accent-fg);
    border-color: var(--accent);
  }
  .chip:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  .btn-ghost {
    padding: 0.25rem 0.85rem;
    font-size: 0.82rem;
    border-radius: 8px;
  }

  footer {
    margin-top: 2rem;
    padding-top: 1rem;
    border-top: 1px solid var(--border);
    text-align: right;
    font-size: 0.8rem;
    color: var(--fg-muted);
  }
  footer a {
    color: var(--fg-muted);
    text-decoration: none;
  }
  footer a:hover { color: var(--fg); text-decoration: underline; }
</style>
