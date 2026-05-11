import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import wasm from 'vite-plugin-wasm';

// COOP+COEP enable `cross-origin-isolated`, which is required for
// SharedArrayBuffer (used later by the AudioWorklet <-> main ring buffer).
const crossOriginIsolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  plugins: [svelte(), wasm()],
  server: {
    headers: crossOriginIsolationHeaders,
  },
  preview: {
    headers: crossOriginIsolationHeaders,
  },
  worker: {
    format: 'es',
    plugins: () => [wasm()],
  },
  optimizeDeps: {
    // wasm-pack output ships its own ESM loader; let Vite skip pre-bundle.
    exclude: ['./src/wasm/core.js'],
  },
});
