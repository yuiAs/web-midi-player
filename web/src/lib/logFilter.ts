// Parse the event category off a formatted log line. The line format is
// stable (defined by `format_event` in core/src/player.rs); we look at the
// type word that starts at a fixed column.

export type EventCategory = 'note' | 'cc' | 'pc' | 'pb' | 'at' | 'sysex' | 'meta';

export interface FilterFlags {
  note: boolean;
  cc: boolean;
  pc: boolean;
  pb: boolean;
  at: boolean;
  sysex: boolean;
  meta: boolean;
}

export const DEFAULT_FILTERS: FilterFlags = {
  note: true,
  cc: true,
  pc: true,
  pb: true,
  at: true,
  sysex: true,
  meta: true,
};

export const FILTER_LABELS: Record<keyof FilterFlags, string> = {
  note: 'Notes',
  cc: 'CC',
  pc: 'PC',
  pb: 'PitchBend',
  at: 'Aftertouch',
  sysex: 'SysEx',
  meta: 'Meta',
};

const CATEGORY_KEYWORDS: Array<[EventCategory, readonly string[]]> = [
  ['note', ['NoteOn', 'NoteOff']],
  ['cc', ['CC ']],
  ['pc', ['PrgChange']],
  ['pb', ['PitchBend']],
  ['at', ['PolyAT', 'ChanAT']],
  ['sysex', ['SysEx']],
  ['meta', ['Tempo', 'TimeSig']],
];

/** Detect the category of a single log line. Defaults to 'meta' for safety. */
export function categoryOf(line: string): EventCategory {
  // The type word lives between col ~20 and the next double-space; checking
  // substring presence is cheaper than slicing and matches uniquely.
  for (const [cat, keywords] of CATEGORY_KEYWORDS) {
    for (const kw of keywords) {
      if (line.includes(kw)) return cat;
    }
  }
  return 'meta';
}

export function lineMatches(line: string, filters: FilterFlags): boolean {
  return filters[categoryOf(line)];
}
