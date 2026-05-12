#!/usr/bin/env bash
set -euo pipefail

# Cloudflare Pages build entrypoint.
#
# The Pages build image (v3, currently Node 22.x) ships Node + npm but no Rust
# toolchain, so we install rustup + wasm-pack on the fly, then run the same
# wasm + Vite pipeline used locally. `~/.cargo` is not in the Pages build
# cache, so this install runs on every build (~30-60s).
#
# Suggested Pages settings — option A (root = repo root):
#   Build command:    bash cloudflare-build.sh
#   Build output dir: web/dist
#
# Option B (root = web/, invoked via npm script):
#   Build command:    npm run cloudflare:build
#   Build output dir: dist

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 1. Install Rust (stable, minimal profile) non-interactively.
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
  | sh -s -- -y --default-toolchain stable --profile minimal
# shellcheck source=/dev/null
. "$HOME/.cargo/env"

# 2. Add the wasm target and install wasm-pack via the upstream init script
#    (binary download — faster than `cargo install wasm-pack` from source).
#    wasm-pack moved from the rustwasm org to the wasm-bindgen org in mid-2025
#    (see https://blog.rust-lang.org/inside-rust/2025/07/21/sunsetting-the-rustwasm-github-org/);
#    the old rustwasm.github.io URL still resolves but is pinned to v0.13.1.
rustup target add wasm32-unknown-unknown
# `init.sh` contains bash-isms; piping to `sh` (= dash on the CF Pages image)
# trips a syntax error at the first function definition. Pipe to bash.
curl --proto '=https' --tlsv1.2 -sSf \
  https://wasm-bindgen.github.io/wasm-pack/installer/init.sh | bash

# 3. Build the wasm core, then the Svelte app. `npm ci` is idempotent even if
#    CF Pages already ran an install step for us.
cd "$SCRIPT_DIR/web"
npm ci
npm run wasm
npm run build
