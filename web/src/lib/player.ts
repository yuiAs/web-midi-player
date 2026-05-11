// Main-thread wrapper around the AudioWorklet that hosts the Wasm Player.
// Boots the AudioContext, ships the compiled wasm module to the worklet,
// and exposes a tiny command surface for the UI.

const WORKLET_URL = '/worklet/synth-processor.js';
const WASM_URL = '/wasm/core_bg.wasm';

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
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private readyPromise: Promise<void> | null = null;

  constructor(private readonly events: SynthClientEvents = {}) {}

  async start(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = this.boot();
    return this.readyPromise;
  }

  private async boot(): Promise<void> {
    const ctx = new AudioContext();
    this.ctx = ctx;

    const [wasmModule] = await Promise.all([
      WebAssembly.compileStreaming(fetch(WASM_URL)),
      ctx.audioWorklet.addModule(WORKLET_URL),
    ]);

    const node = new AudioWorkletNode(ctx, 'synth-processor', {
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

    node.connect(ctx.destination);

    if (ctx.state === 'suspended') {
      await ctx.resume();
    }
  }

  get audioContext(): AudioContext | null {
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
