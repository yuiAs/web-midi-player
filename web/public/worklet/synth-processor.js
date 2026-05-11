// AudioWorkletProcessor driving the Wasm `Player` on every render quantum.
//
// Lives under public/ (raw static asset) instead of being bundled by Vite —
// Vite's worker bundler injects HMR helpers that don't run in the worklet
// global scope, and the AudioWorklet spec only accepts ES modules that can
// load cleanly from their delivered URL.
//
// Authored in plain JS because wasm-bindgen's `core.js` is JS too and the
// surface used here is tiny; the typed view exists in core.d.ts.

import './text-codec-polyfill.js';
import { initSync, Player } from '/wasm/core.js';

// Post a position snapshot every N quanta. At 128 samples/quantum and
// 48 kHz that is ~53 ms — fast enough for a smooth time readout, slow
// enough to not flood the main thread.
const POSITION_EMIT_EVERY = 20;

function midiInfoToPlainObject(info) {
  return {
    format: info.format,
    track_count: info.track_count,
    port_count: info.port_count,
    ticks_per_quarter: info.ticks_per_quarter,
    total_notes: info.total_notes,
    initial_bpm: info.initial_bpm,
    duration_secs: info.duration_secs,
    detected_mode: info.detected_mode,
  };
}

class SynthProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.player = null;
    this.quantaSinceEmit = 0;

    const opts = options.processorOptions ?? {};
    if (!opts.wasmModule) {
      this.port.postMessage({
        type: 'error',
        message: 'missing wasmModule in processorOptions',
      });
      return;
    }

    try {
      initSync({ module: opts.wasmModule });
      this.player = new Player(sampleRate);
      this.port.postMessage({ type: 'ready', sampleRate });
    } catch (err) {
      this.port.postMessage({ type: 'error', message: String(err) });
      return;
    }

    this.port.onmessage = (e) => {
      const msg = e.data;
      const p = this.player;
      if (!p) return;
      try {
        switch (msg.type) {
          case 'load_sf2':
            p.load_sf2(msg.bytes);
            this.port.postMessage({ type: 'sf2_loaded' });
            break;
          case 'load_midi': {
            const info = p.load_midi(msg.bytes);
            this.port.postMessage({
              type: 'midi_loaded',
              info: midiInfoToPlainObject(info),
            });
            break;
          }
          case 'play':
            p.play();
            break;
          case 'pause':
            p.pause();
            break;
          case 'stop':
            p.stop();
            break;
          case 'set_mode':
            p.set_mode_override(msg.mode);
            this.port.postMessage({
              type: 'mode_changed',
              effective_mode: p.effective_mode,
            });
            break;
          case 'set_loop':
            p.set_loop(msg.enabled);
            break;
        }
      } catch (err) {
        this.port.postMessage({ type: 'error', message: String(err) });
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    if (!out || out.length < 2) return true;
    const left = out[0];
    const right = out[1];
    const p = this.player;
    if (!p) {
      left.fill(0);
      right.fill(0);
      return true;
    }

    p.render(left, right);

    this.quantaSinceEmit++;
    if (this.quantaSinceEmit >= POSITION_EMIT_EVERY) {
      this.quantaSinceEmit = 0;
      // drain_log_lines returns [] when nothing new was dispatched; sending
      // an empty array is cheap, and bundling with `position` halves the
      // postMessage rate compared to two separate channels.
      const logLines = p.drain_log_lines();
      this.port.postMessage({
        type: 'position',
        tick: Number(p.current_tick),
        secs: p.current_time_secs,
        bpm: p.current_bpm,
        isPlaying: p.is_playing,
        logLines,
      });
    }
    return true;
  }
}

registerProcessor('synth-processor', SynthProcessor);
