//! web-midi-player core (Wasm).
//!
//! Phase 1: minimal `add` export to verify the wasm-pack -> Vite pipeline.
//! Real MIDI / SF2 / synthesizer surface will land in Phase 2+.

use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn add(a: i32, b: i32) -> i32 {
    a + b
}

#[wasm_bindgen]
pub fn core_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
