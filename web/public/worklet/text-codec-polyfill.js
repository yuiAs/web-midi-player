// Minimal TextEncoder / TextDecoder shims for AudioWorkletGlobalScope.
// wasm-bindgen's generated `core.js` instantiates `new TextDecoder('utf-8', ...)`
// at module evaluation time, and these globals are missing inside the worklet,
// so static-importing core.js without this shim makes the worklet module
// silently fail to register its processor.
//
// Imported as a SIBLING module before core.js so it is evaluated first.

if (typeof globalThis.TextDecoder === 'undefined') {
  class TextDecoderShim {
    constructor(_label, _options) {}
    decode(input) {
      if (input == null) return '';
      const buf =
        input instanceof Uint8Array
          ? input
          : new Uint8Array(input.buffer ?? input);
      let out = '';
      let i = 0;
      while (i < buf.length) {
        const b1 = buf[i++];
        if (b1 < 0x80) {
          out += String.fromCharCode(b1);
        } else if (b1 < 0xc0) {
          out += '�';
        } else if (b1 < 0xe0) {
          const b2 = buf[i++] ?? 0;
          out += String.fromCharCode(((b1 & 0x1f) << 6) | (b2 & 0x3f));
        } else if (b1 < 0xf0) {
          const b2 = buf[i++] ?? 0;
          const b3 = buf[i++] ?? 0;
          out += String.fromCharCode(
            ((b1 & 0x0f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f),
          );
        } else {
          const b2 = buf[i++] ?? 0;
          const b3 = buf[i++] ?? 0;
          const b4 = buf[i++] ?? 0;
          const cp =
            ((b1 & 0x07) << 18) |
            ((b2 & 0x3f) << 12) |
            ((b3 & 0x3f) << 6) |
            (b4 & 0x3f);
          const c = cp - 0x10000;
          out += String.fromCharCode(0xd800 | (c >> 10), 0xdc00 | (c & 0x3ff));
        }
      }
      return out;
    }
  }
  globalThis.TextDecoder = TextDecoderShim;
}

if (typeof globalThis.TextEncoder === 'undefined') {
  class TextEncoderShim {
    constructor() {}
    encode(str) {
      const len = str.length;
      const buf = new Uint8Array(len * 4);
      let pos = 0;
      for (let i = 0; i < len; i++) {
        let cp = str.charCodeAt(i);
        if (cp >= 0xd800 && cp < 0xdc00 && i + 1 < len) {
          const next = str.charCodeAt(i + 1);
          if (next >= 0xdc00 && next < 0xe000) {
            cp = 0x10000 + ((cp - 0xd800) << 10) + (next - 0xdc00);
            i++;
          }
        }
        if (cp < 0x80) {
          buf[pos++] = cp;
        } else if (cp < 0x800) {
          buf[pos++] = 0xc0 | (cp >> 6);
          buf[pos++] = 0x80 | (cp & 0x3f);
        } else if (cp < 0x10000) {
          buf[pos++] = 0xe0 | (cp >> 12);
          buf[pos++] = 0x80 | ((cp >> 6) & 0x3f);
          buf[pos++] = 0x80 | (cp & 0x3f);
        } else {
          buf[pos++] = 0xf0 | (cp >> 18);
          buf[pos++] = 0x80 | ((cp >> 12) & 0x3f);
          buf[pos++] = 0x80 | ((cp >> 6) & 0x3f);
          buf[pos++] = 0x80 | (cp & 0x3f);
        }
      }
      return buf.slice(0, pos);
    }
    encodeInto(str, dest) {
      const enc = this.encode(str);
      const n = Math.min(enc.length, dest.length);
      dest.set(enc.subarray(0, n));
      return { read: str.length, written: n };
    }
  }
  globalThis.TextEncoder = TextEncoderShim;
}
