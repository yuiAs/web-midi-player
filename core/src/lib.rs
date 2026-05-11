//! web-midi-player core (Wasm).
//!
//! Phase 2 layer-in: MIDI parsing modules ported from the ump native crate.
//! Synthesis + sequencer wiring lands in subsequent steps.

// `#[macro_use]` mirrors ump's main.rs so log_info!/log_warn!/log_error!
// are reachable from sibling modules without explicit imports.
#[macro_use]
pub mod debug;
pub mod midi;
pub mod player;
pub mod sequencer;
pub mod synth;

pub use player::Player;

use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn add(a: i32, b: i32) -> i32 {
    a + b
}

#[wasm_bindgen]
pub fn core_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
