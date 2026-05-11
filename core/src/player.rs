//! Wasm-bindgen surface: owns SynthPool + Sequencer and exposes the
//! minimal transport API consumed by the AudioWorklet.

use wasm_bindgen::prelude::*;

use crate::midi::event::{MidiEvent, TimedMidiEvent};
use crate::midi::mode_detect::{detect_mode, MidiMode};
use crate::midi::parser::parse_midi;
use crate::sequencer::Sequencer;
use crate::synth::engine::SynthPool;

/// Format a single MIDI event as one line for the UI log window.
/// Padded so columns line up in a monospace view.
fn format_event(evt: &TimedMidiEvent) -> String {
    let tick = evt.tick;
    match &evt.event {
        MidiEvent::NoteOn { port, channel, key, vel } => format!(
            "{tick:>10}  P{port} Ch{ch:>2}  NoteOn      key={key:<3} vel={vel}",
            ch = channel
        ),
        MidiEvent::NoteOff { port, channel, key } => format!(
            "{tick:>10}  P{port} Ch{ch:>2}  NoteOff     key={key}",
            ch = channel
        ),
        MidiEvent::ProgramChange { port, channel, program } => format!(
            "{tick:>10}  P{port} Ch{ch:>2}  PrgChange   prog={program}",
            ch = channel
        ),
        MidiEvent::ControlChange { port, channel, controller, value } => format!(
            "{tick:>10}  P{port} Ch{ch:>2}  CC          ctl={controller:<3} val={value}",
            ch = channel
        ),
        MidiEvent::PitchBend { port, channel, value } => format!(
            "{tick:>10}  P{port} Ch{ch:>2}  PitchBend   val={value}",
            ch = channel
        ),
        MidiEvent::PolyAftertouch { port, channel, key, pressure } => format!(
            "{tick:>10}  P{port} Ch{ch:>2}  PolyAT      key={key:<3} pres={pressure}",
            ch = channel
        ),
        MidiEvent::ChannelAftertouch { port, channel, pressure } => format!(
            "{tick:>10}  P{port} Ch{ch:>2}  ChanAT      pres={pressure}",
            ch = channel
        ),
        MidiEvent::TempoChange(us_per_q) => {
            let bpm = 60_000_000.0 / *us_per_q as f64;
            format!("{tick:>10}  --        Tempo       us/q={us_per_q} ({bpm:.2} BPM)")
        }
        MidiEvent::TimeSignature { numerator, denominator } => {
            let denom = 1u32 << *denominator;
            format!("{tick:>10}  --        TimeSig     {numerator}/{denom}")
        }
        MidiEvent::SysEx(data) => {
            // Hex dump, truncated to keep the log row tidy.
            const MAX: usize = 16;
            let mut hex = String::with_capacity(MAX * 3);
            for (i, b) in data.iter().take(MAX).enumerate() {
                if i > 0 {
                    hex.push(' ');
                }
                use core::fmt::Write;
                let _ = write!(hex, "{b:02X}");
            }
            if data.len() > MAX {
                hex.push_str(&format!(" .. (+{} bytes)", data.len() - MAX));
            }
            format!("{tick:>10}  --        SysEx       {hex}")
        }
    }
}

/// Mode enum mirrored to JS as a u8.
/// 0=GM, 1=GS, 2=XG, 3=GM2.
fn mode_to_u8(m: MidiMode) -> u8 {
    match m {
        MidiMode::GM => 0,
        MidiMode::GS => 1,
        MidiMode::XG => 2,
        MidiMode::GM2 => 3,
    }
}

/// Per-file metadata returned by `Player.load_midi`.
/// Fields are exposed to JS as getters via wasm-bindgen.
#[wasm_bindgen]
pub struct MidiInfo {
    /// SMF format (0 = single, 1 = parallel, 2 = sequential).
    pub format: u8,
    pub track_count: u32,
    pub port_count: u8,
    pub ticks_per_quarter: u16,
    pub total_notes: u32,
    pub initial_bpm: f64,
    pub duration_secs: f64,
    /// Mode detected from SysEx + Bank Select; 0=GM, 1=GS, 2=XG, 3=GM2.
    pub detected_mode: u8,
}

#[wasm_bindgen]
pub struct Player {
    sample_rate: u32,
    synth: Option<SynthPool>,
    sequencer: Option<Sequencer>,
    /// Buffer of events dispatched during the most recent render pass.
    /// Reused across calls; the host drains it via a Phase 5 interface.
    event_log: Vec<TimedMidiEvent>,

    /// Mode detected at load time; 0=GM if no MIDI loaded yet.
    detected_mode: u8,
    /// Optional user override; when Some, used in place of detected_mode.
    override_mode: Option<u8>,
    /// When true the sequencer rewinds to tick 0 after finishing.
    loop_enabled: bool,
}

/// Canonical reset SysEx (sans F0/F7 framing) for each mode.
fn mode_sysex_bytes(mode: u8) -> &'static [u8] {
    match mode {
        // Universal Non-Real-Time: 7E 7F 09 01 (GM On).
        0 => &[0x7E, 0x7F, 0x09, 0x01],
        // Roland GS Reset.
        1 => &[0x41, 0x10, 0x42, 0x12, 0x40, 0x00, 0x7F, 0x00, 0x41],
        // Yamaha XG Reset.
        2 => &[0x43, 0x10, 0x4C, 0x00, 0x00, 0x7E, 0x00],
        // Universal Non-Real-Time: 7E 7F 09 03 (GM2 On).
        3 => &[0x7E, 0x7F, 0x09, 0x03],
        _ => &[],
    }
}

#[wasm_bindgen]
impl Player {
    #[wasm_bindgen(constructor)]
    pub fn new(sample_rate: u32) -> Player {
        Player {
            sample_rate,
            synth: None,
            sequencer: None,
            event_log: Vec::new(),
            detected_mode: 0,
            override_mode: None,
            loop_enabled: false,
        }
    }

    /// Parse an SF2 blob and create a single-port SynthPool.
    /// Must be called before render() produces sound.
    pub fn load_sf2(&mut self, bytes: &[u8]) -> Result<(), JsError> {
        let pool = SynthPool::single(bytes, self.sample_rate, 1)
            .map_err(|e| JsError::new(&format!("{e:#}")))?;
        self.synth = Some(pool);
        Ok(())
    }

    /// Parse a SMF blob into a sequencer and return its metadata.
    /// Also resets the synth and re-applies the effective mode so leftover
    /// notes / controllers / per-channel state from the previous file do
    /// not leak into the new one.
    pub fn load_midi(&mut self, bytes: &[u8]) -> Result<MidiInfo, JsError> {
        let (midi_data, tempo_map) =
            parse_midi(bytes).map_err(|e| JsError::new(&format!("{e:#}")))?;

        let duration_secs = tempo_map.total_duration_secs(midi_data.total_ticks);
        let initial_bpm = tempo_map.bpm_at_tick(0);
        let detected = detect_mode(&midi_data.events);
        let detected_u8 = mode_to_u8(detected);

        let info = MidiInfo {
            format: midi_data.format,
            track_count: midi_data.tracks.len() as u32,
            port_count: midi_data.port_count,
            ticks_per_quarter: midi_data.ticks_per_quarter,
            total_notes: midi_data.note_rects.len() as u32,
            initial_bpm,
            duration_secs,
            detected_mode: detected_u8,
        };

        let seq = Sequencer::new(&midi_data, tempo_map);
        self.sequencer = Some(seq);
        self.detected_mode = detected_u8;
        // Preserve the user's override across loads — they likely want the
        // forced mode to keep applying to the next file too.
        self.apply_effective_mode();

        Ok(info)
    }

    /// Toggle loop playback. When true, the sequencer rewinds to tick 0
    /// (with a fresh synth reset and a mode re-apply) after finishing the
    /// last event.
    pub fn set_loop(&mut self, enabled: bool) {
        self.loop_enabled = enabled;
    }

    #[wasm_bindgen(getter)]
    pub fn loop_enabled(&self) -> bool {
        self.loop_enabled
    }

    pub fn play(&mut self) {
        if let Some(seq) = self.sequencer.as_mut() {
            seq.play();
        }
    }

    pub fn pause(&mut self) {
        if let Some(seq) = self.sequencer.as_mut() {
            seq.pause();
        }
    }

    pub fn stop(&mut self) {
        if let (Some(seq), Some(synth)) = (self.sequencer.as_mut(), self.synth.as_mut()) {
            seq.stop(synth);
        }
    }

    #[wasm_bindgen(getter)]
    pub fn is_playing(&self) -> bool {
        self.sequencer.as_ref().is_some_and(|s| s.is_playing())
    }

    #[wasm_bindgen(getter)]
    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    #[wasm_bindgen(getter)]
    pub fn current_tick(&self) -> u64 {
        self.sequencer.as_ref().map(|s| s.current_tick()).unwrap_or(0)
    }

    #[wasm_bindgen(getter)]
    pub fn current_time_secs(&self) -> f64 {
        self.sequencer.as_ref().map(|s| s.current_time_secs()).unwrap_or(0.0)
    }

    #[wasm_bindgen(getter)]
    pub fn current_bpm(&self) -> f64 {
        self.sequencer.as_ref().map(|s| s.current_bpm()).unwrap_or(120.0)
    }

    #[wasm_bindgen(getter)]
    pub fn total_duration_secs(&self) -> f64 {
        self.sequencer.as_ref().map(|s| s.total_duration_secs()).unwrap_or(0.0)
    }

    #[wasm_bindgen(getter)]
    pub fn detected_mode(&self) -> u8 {
        self.detected_mode
    }

    /// Effective mode = override_mode if set, else detected_mode.
    #[wasm_bindgen(getter)]
    pub fn effective_mode(&self) -> u8 {
        self.override_mode.unwrap_or(self.detected_mode)
    }

    /// Force a specific mode. Pass 0..=3 to override, or 255 to clear.
    /// Injects the canonical mode-reset SysEx so the synth's drum routing
    /// and bank defaults match the new choice right away. A subsequent
    /// in-file SysEx of a different flavour will still take effect when it
    /// plays — this is a manual override, not a filter.
    pub fn set_mode_override(&mut self, mode: u8) {
        self.override_mode = if mode <= 3 { Some(mode) } else { None };
        self.apply_effective_mode();
    }

    fn apply_effective_mode(&mut self) {
        let Some(synth) = self.synth.as_mut() else {
            return;
        };
        let bytes = mode_sysex_bytes(self.override_mode.unwrap_or(self.detected_mode));
        if bytes.is_empty() {
            return;
        }
        synth.process_sysex(bytes);
        synth.system_reset();
    }

    /// Drain all buffered events into formatted log lines and return them.
    /// The internal buffer is emptied so the next call only returns new events.
    pub fn drain_log_lines(&mut self) -> Vec<String> {
        let lines: Vec<String> = self.event_log.iter().map(format_event).collect();
        self.event_log.clear();
        lines
    }

    /// Render one block of audio into the supplied stereo buffers.
    /// Returns the number of MIDI events dispatched in this block; the host
    /// is expected to call drain_log_lines on a UI-paced cadence (typically
    /// from the same place position snapshots are sent).
    pub fn render(&mut self, left: &mut [f32], right: &mut [f32]) -> usize {
        let before = self.event_log.len();
        let effective = self.override_mode.unwrap_or(self.detected_mode);
        match (self.sequencer.as_mut(), self.synth.as_mut()) {
            (Some(seq), Some(synth)) => {
                seq.fill_buffer(synth, left, right, &mut self.event_log);
                if self.loop_enabled && seq.is_finished() {
                    // Rewind, reset the synth, and re-stamp the effective
                    // mode so the next loop iteration starts clean.
                    seq.seek_to_tick(0, synth);
                    let bytes = mode_sysex_bytes(effective);
                    if !bytes.is_empty() {
                        synth.process_sysex(bytes);
                        synth.system_reset();
                    }
                    seq.play();
                }
            }
            _ => {
                left.fill(0.0);
                right.fill(0.0);
            }
        }
        self.event_log.len() - before
    }
}
