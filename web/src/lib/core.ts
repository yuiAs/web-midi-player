// Loader for the wasm-pack output of web-midi-player-core.
// wasm-pack `--target web` produces an ESM with a default-export `init()`
// that must be awaited before any other export can be called.
import init, { add, core_version } from '../wasm/core.js';

let initialized: Promise<void> | null = null;

export function loadCore(): Promise<void> {
  if (!initialized) {
    initialized = init().then(() => undefined);
  }
  return initialized;
}

export { add, core_version };
