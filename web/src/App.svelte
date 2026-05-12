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

  let audioStatus = $state<'idle' | 'starting' | 'ready' | 'error'>('idle');
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
  // Handle fetched in onMount so the Start Audio click can synchronously
  // consume it for requestPermission(), which requires transient user
  // activation. Re-fetched on demand if the click beats onMount.
  let pendingSf2Handle: FileSystemFileHandle | null = null;

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

  onMount(async () => {
    crossOriginIsolated = self.crossOriginIsolated;
    await loadCore();
    coreVersion = core_version();
    coreReady = true;
    pendingSf2Handle = await loadSf2Handle();
  });

  async function startAudio() {
    if (client) return;
    audioStatus = 'starting';

    // Resolve SF2 read permission while the user-activation from this
    // click is still fresh. Browsers gate requestPermission() on transient
    // activation; calling it from onReady (which arrives via postMessage)
    // would always fail.
    const handle = pendingSf2Handle ?? (await loadSf2Handle());
    pendingSf2Handle = null;
    let restorable: FileSystemFileHandle | null = null;
    if (handle) {
      if (await ensureReadPermission(handle)) {
        restorable = handle;
      } else {
        await clearSf2Handle();
      }
    }

    client = new SynthClient({
      onReady: (sr) => {
        workletSampleRate = sr;
        audioStatus = 'ready';
        // The $effect for volume/loop already ran at mount with client=null,
        // so apply the current values explicitly now that the audio graph
        // exists. Otherwise the worklet keeps its built-in defaults instead
        // of the persisted ones.
        client?.setVolume((volume / 100) ** 2);
        client?.setLoop(loopEnabled);
        if (restorable) void loadSf2FromHandle(restorable);
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
    try {
      await client.start();
    } catch (e) {
      lastError = String(e);
      audioStatus = 'error';
    }
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

  {#if audioStatus !== 'ready'}
    <section class="boot">
      <button class="btn-primary" onclick={startAudio} disabled={audioStatus !== 'idle'}>
        {audioStatus === 'idle' ? 'Start Audio' : audioStatus}
      </button>
      {#if lastError}<p class="err"><code>{lastError}</code></p>{/if}
    </section>
  {:else}
    <section>
      <h2>Files</h2>
      <FileLoader
        label="SF2"
        accept=".sf2,.sf3"
        fileName={sf2Name}
        fileSize={sf2Size}
        onload={handleSf2}
      />
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
  {/if}

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
  section.boot { text-align: center; padding: 2rem 0; }

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

  .btn-primary {
    padding: 0.55rem 1.4rem;
    font-size: 0.95rem;
    background: var(--accent);
    color: var(--accent-fg);
    border-color: var(--accent);
    border-radius: 8px;
  }
  .btn-primary:hover:not(:disabled) {
    filter: brightness(1.06);
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
