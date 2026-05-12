// Main-thread wrapper around the AudioWorklet that hosts the Wasm Player.
// Boots the AudioContext, ships the compiled wasm module to the worklet,
// and exposes a tiny command surface for the UI.

const WORKLET_URL = '/worklet/synth-processor.js';
const WASM_URL = '/wasm/core_bg.wasm';

/** Reports bytes received during the WASM fetch. `total` is 0 if unknown. */
export type ProgressFn = (loaded: number, total: number) => void;

/// 0=GM, 1=GS, 2=XG, 3=GM2. Matches the u8 returned by the Rust core.
export type MidiModeId = 0 | 1 | 2 | 3;

export const MODE_LABELS: Record<MidiModeId, string> = {
  0: 'GM',
  1: 'GS',
  2: 'XG',
  3: 'GM2',
};

export interface MidiInfoSnapshot {
  /** SMF format: 0 single-track, 1 parallel, 2 sequential. */
  format: number;
  track_count: number;
  port_count: number;
  ticks_per_quarter: number;
  total_notes: number;
  initial_bpm: number;
  duration_secs: number;
  detected_mode: MidiModeId;
}

export interface PositionSnapshot {
  tick: number;
  secs: number;
  bpm: number;
  isPlaying: boolean;
}

export type WorkletOutbound =
  | { type: 'ready'; sampleRate: number }
  | { type: 'sf2_loaded' }
  | { type: 'midi_loaded'; info: MidiInfoSnapshot }
  | {
      type: 'position';
      tick: number;
      secs: number;
      bpm: number;
      isPlaying: boolean;
      logLines: string[];
    }
  | { type: 'mode_changed'; effective_mode: MidiModeId }
  | { type: 'error'; message: string };

export interface SynthClientEvents {
  onReady?: (sampleRate: number) => void;
  onSf2Loaded?: () => void;
  onMidiLoaded?: (info: MidiInfoSnapshot) => void;
  onPosition?: (pos: PositionSnapshot) => void;
  onLogLines?: (lines: string[]) => void;
  onModeChanged?: (effectiveMode: MidiModeId) => void;
  onError?: (message: string) => void;
}

/** Numeric value used by `set_mode_override(255)` to clear an override. */
const CLEAR_OVERRIDE = 255;

export class SynthClient {
  private readonly ctx: AudioContext;
  private node: AudioWorkletNode | null = null;
  private gain: GainNode | null = null;
  private preparePromise: Promise<void> | null = null;

  constructor(private readonly events: SynthClientEvents = {}) {
    // Allocated up front so that resume() inside a click handler can fire
    // synchronously without racing a deferred context construction.
    // The context starts in `suspended` state until resume() runs.
    this.ctx = new AudioContext();
  }

  /**
   * Fetch + compile the WASM, load the AudioWorklet, and wire the graph.
   * Runs without user activation; the context stays suspended throughout.
   * Idempotent — repeated calls return the same in-flight promise.
   */
  prepare(onProgress?: ProgressFn): Promise<void> {
    if (!this.preparePromise) {
      this.preparePromise = this.boot(onProgress);
    }
    return this.preparePromise;
  }

  /**
   * Transition the AudioContext from `suspended` to `running`. Must be
   * invoked during a user gesture (click/keydown) because browser
   * autoplay policy gates resume() on transient activation.
   */
  resume(): Promise<void> {
    if (this.ctx.state === 'suspended') {
      return this.ctx.resume();
    }
    return Promise.resolve();
  }

  private async boot(onProgress?: ProgressFn): Promise<void> {
    const [wasmModule] = await Promise.all([
      compileWasmWithProgress(WASM_URL, onProgress),
      this.ctx.audioWorklet.addModule(WORKLET_URL),
    ]);

    const node = new AudioWorkletNode(this.ctx, 'synth-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { wasmModule },
    });
    this.node = node;

    node.port.onmessage = (e: MessageEvent<WorkletOutbound>) => {
      const msg = e.data;
      switch (msg.type) {
        case 'ready':
          this.events.onReady?.(msg.sampleRate);
          break;
        case 'sf2_loaded':
          this.events.onSf2Loaded?.();
          break;
        case 'midi_loaded':
          this.events.onMidiLoaded?.(msg.info);
          break;
        case 'position':
          this.events.onPosition?.({
            tick: msg.tick,
            secs: msg.secs,
            bpm: msg.bpm,
            isPlaying: msg.isPlaying,
          });
          if (msg.logLines.length > 0) {
            this.events.onLogLines?.(msg.logLines);
          }
          break;
        case 'mode_changed':
          this.events.onModeChanged?.(msg.effective_mode);
          break;
        case 'error':
          this.events.onError?.(msg.message);
          break;
      }
    };

    // Master gain sits between the worklet and destination so volume can
    // be tweaked without rebuilding the graph.
    const gain = this.ctx.createGain();
    this.gain = gain;
    node.connect(gain).connect(this.ctx.destination);
  }

  /**
   * Set master output gain. `value` is a linear multiplier (1.0 = unity).
   * Uses a short linear ramp instead of `setTargetAtTime` because the
   * latter is asymptotic — target=0 never actually reaches silence.
   * `cancelScheduledValues` clears any pending ramp so dragging the
   * slider does not pile up overlapping automations.
   */
  setVolume(value: number): void {
    const g = this.gain;
    if (!g) return;
    const target = Math.max(0, value);
    const now = this.ctx.currentTime;
    g.gain.cancelScheduledValues(now);
    g.gain.setValueAtTime(g.gain.value, now);
    g.gain.linearRampToValueAtTime(target, now + 0.02);
  }

  get audioContext(): AudioContext {
    return this.ctx;
  }

  loadSf2(bytes: Uint8Array): void {
    this.node?.port.postMessage({ type: 'load_sf2', bytes }, [bytes.buffer]);
  }

  loadMidi(bytes: Uint8Array): void {
    this.node?.port.postMessage({ type: 'load_midi', bytes }, [bytes.buffer]);
  }

  play(): void {
    this.node?.port.postMessage({ type: 'play' });
  }
  pause(): void {
    this.node?.port.postMessage({ type: 'pause' });
  }
  stop(): void {
    this.node?.port.postMessage({ type: 'stop' });
  }

  /** Force the effective mode. Pass `null` to revert to the detected mode. */
  setModeOverride(mode: MidiModeId | null): void {
    this.node?.port.postMessage({
      type: 'set_mode',
      mode: mode === null ? CLEAR_OVERRIDE : mode,
    });
  }

  /** Toggle loop playback. */
  setLoop(enabled: boolean): void {
    this.node?.port.postMessage({ type: 'set_loop', enabled });
  }
}

/**
 * Compile WASM while reporting fetch progress.
 *
 * A TransformStream taps the byte count without buffering the whole
 * module — the raw stream still flows into `compileStreaming` so we
 * keep the parallel-compile speed-up. Falls back to plain streaming
 * compile when there is nothing to report to.
 */
async function compileWasmWithProgress(
  url: string,
  onProgress?: ProgressFn,
): Promise<WebAssembly.Module> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`fetch ${url}: ${response.status} ${response.statusText}`);
  }
  if (!onProgress || !response.body) {
    return WebAssembly.compileStreaming(response);
  }
  const total = Number(response.headers.get('Content-Length') ?? 0);
  let loaded = 0;
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      loaded += chunk.byteLength;
      onProgress(loaded, total);
      controller.enqueue(chunk);
    },
  });
  const piped = response.body.pipeThrough(counter);
  // compileStreaming requires `Content-Type: application/wasm`; the
  // wrapper Response carries it because we strip the original headers.
  return WebAssembly.compileStreaming(
    new Response(piped, { headers: { 'Content-Type': 'application/wasm' } }),
  );
}
