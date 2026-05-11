# web-midi-player

Browser MIDI player. The DSP core is a Rust crate (a trimmed port of the
[ump](https://github.com/yuiAs/ump) sequencer + a fork of
[rustysynth](https://github.com/yuiAs/rustysynth)) compiled to WebAssembly
and run from inside an `AudioWorklet`; the UI is Svelte 5.

| Layer | Lives in |
|---|---|
| MIDI parsing, sequencer, SF2 synthesis | `core/` (Rust → wasm) |
| AudioWorklet processor + tiny UTF-8 polyfill | `web/public/worklet/` |
| AudioContext wrapper, Svelte UI | `web/src/` |

## Prerequisites

- **Rust** stable (1.95+ tested). `rustup target add wasm32-unknown-unknown`.
- **wasm-pack**: `cargo install wasm-pack`.
- **Node.js** 20+ and **npm** 10+.

## Build

```sh
# one-time deps
cd web
npm install

# (re)build the wasm core — outputs to both web/src/wasm (typed import path
# for Vite) and web/public/wasm (raw URL the AudioWorklet pulls from)
npm run wasm
```

Use `npm run wasm:dev` instead for an unoptimised, faster-to-rebuild wasm.

## Run

```sh
# dev server with HMR on http://localhost:5173/
npm run dev

# production build, then preview
npm run build
npm run preview
```

The dev / preview servers send `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` so that `crossOriginIsolated`
is true; without it the AudioWorklet + wasm path will not work in some
browsers. If you serve the build with your own server, keep those two
headers.

## Quick check

```sh
cd web
npm run check    # svelte-check + tsc

cd ../core
cargo check --target wasm32-unknown-unknown
```

## Notes

- SF2 and MIDI files are loaded locally only — nothing leaves the browser.
- No external MIDI device output. Playback is software-synthesised by the
  rustysynth fork.
- Tested with Chrome on Windows. Other Chromium browsers should work; the
  AudioWorklet polyfill in `web/public/worklet/text-codec-polyfill.js`
  covers the `TextDecoder`/`TextEncoder` gap inside `AudioWorkletGlobalScope`.

## License

MIT.
