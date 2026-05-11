//! MIDI sequencer: schedules events against the audio clock.
//!
//! Trimmed port of ump/src/sequencer/player.rs for the wasm core.
//! All inter-thread coordination is gone — the AudioWorklet owns the
//! sequencer outright, so playing/stopped/finished/current_tick live as
//! plain fields and dispatch_event reports MIDI events through an
//! out-param log sink instead of writing to atomic channel/monitor state.
//! The host (main thread) reconstructs whatever per-channel snapshots it
//! needs from the event stream.

use crate::midi::event::{MidiData, MidiEvent, TimedMidiEvent};
use crate::midi::sysex::{parse_sysex, SysExCommand};
use crate::midi::tempo_map::TempoMap;
use crate::synth::engine::SynthPool;

pub struct Sequencer {
    events: Vec<TimedMidiEvent>,
    tempo_map: TempoMap,
    ticks_per_quarter: u16,
    total_ticks: u64,
    port_count: u8,

    /// Current position index into events list.
    event_index: usize,
    /// Current time in seconds (audio clock).
    current_time_secs: f64,
    /// Current tick (derived from current_time_secs).
    current_tick: u64,
    /// Current microseconds per quarter note.
    us_per_quarter: u32,

    /// Transport state. AudioWorklet single-threaded, so plain bools suffice.
    playing: bool,
    stopped: bool,
    finished: bool,
}

impl Sequencer {
    pub fn new(midi_data: &MidiData, tempo_map: TempoMap) -> Self {
        Sequencer {
            events: midi_data.events.clone(),
            tempo_map,
            ticks_per_quarter: midi_data.ticks_per_quarter,
            total_ticks: midi_data.total_ticks,
            port_count: midi_data.port_count,
            event_index: 0,
            current_time_secs: 0.0,
            current_tick: 0,
            us_per_quarter: 500_000, // default 120 BPM
            playing: false,
            stopped: true,
            finished: false,
        }
    }

    /// Create an empty sequencer (no events, used as a pre-load placeholder).
    pub fn new_empty(ticks_per_quarter: u16, tempo_map: TempoMap) -> Self {
        Sequencer {
            events: Vec::new(),
            tempo_map,
            ticks_per_quarter,
            total_ticks: 0,
            port_count: 1,
            event_index: 0,
            current_time_secs: 0.0,
            current_tick: 0,
            us_per_quarter: 500_000,
            playing: false,
            stopped: true,
            finished: false,
        }
    }

    pub fn play(&mut self) {
        self.playing = true;
        self.stopped = false;
        self.finished = false;
    }

    pub fn pause(&mut self) {
        self.playing = false;
    }

    pub fn stop(&mut self, synth: &mut SynthPool) {
        self.playing = false;
        self.stopped = true;
        self.seek_to_tick(0, synth);
    }

    pub fn is_playing(&self) -> bool {
        self.playing
    }
    pub fn is_finished(&self) -> bool {
        self.finished
    }
    pub fn current_tick(&self) -> u64 {
        self.current_tick
    }
    pub fn current_time_secs(&self) -> f64 {
        self.current_time_secs
    }
    pub fn total_ticks(&self) -> u64 {
        self.total_ticks
    }
    pub fn port_count(&self) -> u8 {
        self.port_count
    }
    pub fn ticks_per_quarter(&self) -> u16 {
        self.ticks_per_quarter
    }
    /// Current BPM derived from the running microseconds-per-quarter value.
    pub fn current_bpm(&self) -> f64 {
        60_000_000.0 / self.us_per_quarter as f64
    }
    pub fn total_duration_secs(&self) -> f64 {
        self.tempo_map.total_duration_secs(self.total_ticks)
    }

    /// Fill the audio buffer with rendered samples.
    /// Dispatched MIDI events are appended to `log` so the host can stream
    /// them to the UI's log window.
    pub fn fill_buffer(
        &mut self,
        synth: &mut SynthPool,
        left: &mut [f32],
        right: &mut [f32],
        log: &mut Vec<TimedMidiEvent>,
    ) {
        let sample_rate = synth.sample_rate() as f64;
        let buf_len = left.len();

        if self.stopped || !self.playing || self.finished {
            left.fill(0.0);
            right.fill(0.0);
            return;
        }

        // Process events and render in small chunks to keep timing tight.
        let chunk_size = 64;
        let mut offset = 0;

        while offset < buf_len {
            let remaining = buf_len - offset;
            let this_chunk = remaining.min(chunk_size);

            let time_advance = this_chunk as f64 / sample_rate;
            let new_time = self.current_time_secs + time_advance;
            let new_tick = self.tempo_map.secs_to_tick(new_time);

            while self.event_index < self.events.len() {
                if self.events[self.event_index].tick > new_tick {
                    break;
                }
                let evt = self.events[self.event_index].clone();
                self.event_index += 1;
                Self::dispatch_event(&evt, &mut self.us_per_quarter, synth);
                log.push(evt);
            }

            synth.render(
                &mut left[offset..offset + this_chunk],
                &mut right[offset..offset + this_chunk],
            );

            self.current_time_secs = new_time;
            self.current_tick = new_tick;

            offset += this_chunk;
        }

        if self.event_index >= self.events.len() && self.current_tick >= self.total_ticks {
            self.finished = true;
            self.playing = false;
        }
    }

    fn dispatch_event(
        evt: &TimedMidiEvent,
        us_per_quarter: &mut u32,
        synth: &mut SynthPool,
    ) {
        match &evt.event {
            MidiEvent::NoteOn { port, channel, key, vel } => {
                synth.note_on(*port, *channel as i32, *key as i32, *vel as i32);
            }
            MidiEvent::NoteOff { port, channel, key } => {
                synth.note_off(*port, *channel as i32, *key as i32);
            }
            MidiEvent::ProgramChange { port, channel, program } => {
                synth.program_change(*port, *channel as i32, *program as i32);
            }
            MidiEvent::ControlChange { port, channel, controller, value } => {
                synth.control_change(*port, *channel as i32, *controller as i32, *value as i32);
            }
            MidiEvent::PitchBend { port, channel, value } => {
                synth.pitch_bend(*port, *channel as i32, *value);
            }
            MidiEvent::PolyAftertouch { port, channel, key, pressure } => {
                synth.poly_aftertouch(*port, *channel as i32, *key as i32, *pressure as i32);
            }
            MidiEvent::ChannelAftertouch { port, channel, pressure } => {
                synth.channel_aftertouch(*port, *channel as i32, *pressure as i32);
            }
            MidiEvent::TempoChange(us_per_q) => {
                *us_per_quarter = *us_per_q;
            }
            MidiEvent::TimeSignature { .. } => {
                // Bookkeeping only — host derives time signature from the event log.
            }
            MidiEvent::SysEx(data) => {
                synth.process_sysex(data);

                if let Some(cmd) = parse_sysex(data) {
                    match cmd {
                        SysExCommand::SystemReset(_) => {
                            synth.system_reset();
                        }
                        SysExCommand::GsDrumMap { channel, is_drum } => {
                            // SysEx has no port context — apply to port 0.
                            synth.set_percussion_channel(0, channel as usize, is_drum);
                            synth.control_change(0, channel as i32, 0, 0);
                            synth.program_change(0, channel as i32, 0);
                        }
                        SysExCommand::MasterVolume(_) => {
                            // Host-side concern; rustysynth's internal volume is left at default.
                        }
                    }
                }
            }
        }
    }

    /// Seek to a specific tick position by replaying all state-setting events
    /// (program changes, control changes, tempo, sysex) up to `target_tick`
    /// silently — note events are skipped so seek does not sound.
    pub fn seek_to_tick(&mut self, target_tick: u64, synth: &mut SynthPool) {
        synth.reset();
        let pc = synth.port_count();
        for p in 0..pc {
            for ch in 0..16usize {
                synth.set_percussion_channel(p, ch, ch == 9);
            }
        }

        self.event_index = 0;
        self.us_per_quarter = 500_000;

        while self.event_index < self.events.len() {
            let evt = &self.events[self.event_index];
            if evt.tick > target_tick {
                break;
            }

            match &evt.event {
                MidiEvent::ProgramChange { port, channel, program } => {
                    synth.program_change(*port, *channel as i32, *program as i32);
                }
                MidiEvent::ControlChange { port, channel, controller, value } => {
                    synth.control_change(*port, *channel as i32, *controller as i32, *value as i32);
                }
                MidiEvent::TempoChange(us_per_q) => {
                    self.us_per_quarter = *us_per_q;
                }
                MidiEvent::PitchBend { port, channel, value } => {
                    synth.pitch_bend(*port, *channel as i32, *value);
                }
                MidiEvent::ChannelAftertouch { port, channel, pressure } => {
                    synth.channel_aftertouch(*port, *channel as i32, *pressure as i32);
                }
                MidiEvent::SysEx(data) => {
                    synth.process_sysex(data);
                    if let Some(cmd) = parse_sysex(data) {
                        match cmd {
                            SysExCommand::SystemReset(_) => synth.system_reset(),
                            SysExCommand::GsDrumMap { channel, is_drum } => {
                                synth.set_percussion_channel(0, channel as usize, is_drum);
                                synth.control_change(0, channel as i32, 0, 0);
                                synth.program_change(0, channel as i32, 0);
                            }
                            SysExCommand::MasterVolume(_) => {}
                        }
                    }
                }
                _ => {}
            }

            self.event_index += 1;
        }

        self.current_tick = target_tick;
        self.current_time_secs = self.tempo_map.tick_to_secs(target_tick);
        self.finished = false;
    }
}
