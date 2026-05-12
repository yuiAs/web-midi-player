// Per-channel synthesizer state inferred from the MIDI event log lines
// emitted by `format_event` in core/src/player.rs. The regexes here are
// tightly coupled to that formatter — keep them in sync.
//
// Rationale for parsing log strings instead of a structured event channel:
// the log lines already cross the worklet→main message boundary, so reusing
// them avoids a second postMessage stream and a WASM rebuild.

import { GM_INSTRUMENTS } from './gmNames';

// GM defaults that any conforming synth boots into after a system reset.
// Used so that a channel which has only emitted NoteOn (no CC/Program yet)
// still shows plausible values instead of zeros.
export const DEFAULT_PROGRAM = 0;
export const DEFAULT_VOLUME = 100;
export const DEFAULT_PAN = 64;
export const DEFAULT_EXPRESSION = 127;

export const MAX_PORTS = 4;
export const CHANNELS_PER_PORT = 16;
export const MAX_CHANNELS = MAX_PORTS * CHANNELS_PER_PORT;

export interface ChannelState {
  port: number;        // 0..MAX_PORTS-1
  channel: number;     // 0..15 (raw MIDI channel; display is 1-based)
  program: number;     // 0..127
  volume: number;      // CC7
  pan: number;         // CC10
  expression: number;  // CC11
}

export function channelKey(port: number, channel: number): number {
  return port * CHANNELS_PER_PORT + channel;
}

export function makeDefaultState(port: number, channel: number): ChannelState {
  return {
    port,
    channel,
    program: DEFAULT_PROGRAM,
    volume: DEFAULT_VOLUME,
    pan: DEFAULT_PAN,
    expression: DEFAULT_EXPRESSION,
  };
}

// Patterns target the exact substrings produced by format_event:
//   "  P{port} Ch{ch:>2}  PrgChange   prog={program}"
//   "  P{port} Ch{ch:>2}  CC          ctl={controller:<3} val={value}"
//   "  P{port} Ch{ch:>2}  NoteOn      key={key:<3} vel={vel}"
const RE_PRG = /\bP(\d+) Ch\s*(\d+)\s+PrgChange\s+prog=(\d+)/;
const RE_CC = /\bP(\d+) Ch\s*(\d+)\s+CC\s+ctl=\s*(\d+)\s+val=(\d+)/;
const RE_NOTE_ON = /\bP(\d+) Ch\s*(\d+)\s+NoteOn/;

const CC_VOLUME = 7;
const CC_PAN = 10;
const CC_EXPRESSION = 11;

export function gmName(program: number): string {
  return GM_INSTRUMENTS[program] ?? 'Unknown';
}

/**
 * Apply every line in `lines` to `states`, mutating it in place.
 *
 * A channel slot stays `null` until it sees its first relevant event
 * (NoteOn, CC for one of the tracked controllers, or ProgramChange),
 * at which point it is materialised with GM defaults and the event's
 * value is folded in. This keeps the table to "channels actually used".
 */
export function applyLogLines(
  states: (ChannelState | null)[],
  lines: string[],
): void {
  for (const line of lines) {
    let m = line.match(RE_PRG);
    if (m) {
      ensure(states, +m[1], +m[2]).program = +m[3];
      continue;
    }
    m = line.match(RE_CC);
    if (m) {
      const port = +m[1];
      const ch = +m[2];
      const ctl = +m[3];
      const val = +m[4];
      if (ctl === CC_VOLUME) ensure(states, port, ch).volume = val;
      else if (ctl === CC_PAN) ensure(states, port, ch).pan = val;
      else if (ctl === CC_EXPRESSION) ensure(states, port, ch).expression = val;
      continue;
    }
    m = line.match(RE_NOTE_ON);
    if (m) {
      ensure(states, +m[1], +m[2]);
    }
  }
}

function ensure(
  states: (ChannelState | null)[],
  port: number,
  channel: number,
): ChannelState {
  // Guard against malformed lines that report out-of-range values:
  // return an ephemeral state so the caller's write doesn't pollute
  // an arbitrary slot, but never persist it.
  if (port >= MAX_PORTS || channel >= CHANNELS_PER_PORT) {
    return makeDefaultState(port, channel);
  }
  const idx = channelKey(port, channel);
  let s = states[idx];
  if (!s) {
    s = makeDefaultState(port, channel);
    states[idx] = s;
  }
  return s;
}
