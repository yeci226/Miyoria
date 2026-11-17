// Unit tests of the PCM, WAV and TTS helpers.

import { describe, expect, it } from "vitest";
import {
  type AudioBuf,
  type Carry,
  decodeChunk,
  decodeWav,
  encodeWav,
  rateFromContentType,
  resample,
  sovitsLang,
} from "../src/index.js";

function buf(rate: number, samples: number[]): AudioBuf {
  return { sampleRate: rate, samples: Int16Array.from(samples) };
}

function plain(a: AudioBuf): { sampleRate: number; samples: number[] } {
  return { sampleRate: a.sampleRate, samples: [...a.samples] };
}

describe("pcm", () => {
  it("carries_odd_bytes_across_chunks", () => {
    const carry: Carry = { byte: null };
    const a = decodeChunk(carry, 8000, Uint8Array.of(1, 0, 2));
    expect([...(a?.samples ?? [])]).toEqual([1]);
    expect(carry.byte).toBe(2);
    // a one-byte chunk completes the sample and leaves nothing behind
    const b = decodeChunk(carry, 8000, Uint8Array.of(0));
    expect([...(b?.samples ?? [])]).toEqual([2]);
    expect(carry.byte).toBeNull();
    // a lone byte yields no audio but is kept
    expect(decodeChunk(carry, 8000, Uint8Array.of(7))).toBeNull();
    expect(decodeChunk(carry, 8000, new Uint8Array())).toBeNull();
    expect(carry.byte).toBe(7);
  });

  it("decodes_negative_samples_across_a_split", () => {
    const carry: Carry = { byte: null };
    // -2 = 0xFFFE, split between chunks
    expect([...(decodeChunk(carry, 8000, Uint8Array.of(0xfe))?.samples ?? [9])]).toEqual([9]);
    expect([...(decodeChunk(carry, 8000, Uint8Array.of(0xff, 0x00, 0x80))?.samples ?? [])]).toEqual(
      [-2, -32768],
    );
  });

  it("parses_rate_param", () => {
    expect(rateFromContentType("audio/L16; rate=24000; channels=1")).toBe(24000);
    expect(rateFromContentType('audio/L16;Rate="16000"')).toBe(16000);
    expect(rateFromContentType("audio/L16")).toBeNull();
    expect(rateFromContentType("audio/L16; rate=abc")).toBeNull();
  });
});

describe("wav", () => {
  it("round_trip", () => {
    const a = buf(16_000, [0, 1, -1, 32767, -32768, 1234]);
    const bytes = encodeWav(a);
    expect(bytes.length).toBe(44 + 12);
    expect(plain(decodeWav(bytes))).toEqual(plain(a));
  });

  it("empty_round_trip", () => {
    const a = buf(8000, []);
    expect(plain(decodeWav(encodeWav(a)))).toEqual(plain(a));
  });

  it("decode_downmixes_stereo_and_skips_unknown_chunks", () => {
    const parts: number[] = [];
    const ascii = (s: string) => {
      for (const c of s) parts.push(c.charCodeAt(0));
    };
    const u32 = (v: number) => parts.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24);
    const u16 = (v: number) => parts.push(v & 0xff, (v >>> 8) & 0xff);
    ascii("RIFF");
    u32(0);
    ascii("WAVE");
    ascii("fmt ");
    u32(16);
    u16(1);
    u16(2);
    u32(44_100);
    u32(44_100 * 4);
    u16(4);
    u16(16);
    ascii("LIST");
    u32(3);
    parts.push(1, 2, 3, 0); // 3 bytes + pad
    ascii("data");
    u32(0xffff_ffff); // streamed: unknown size
    for (const s of [100, 300, -50, 50]) u16(s & 0xffff);
    expect(plain(decodeWav(Uint8Array.from(parts)))).toEqual({
      sampleRate: 44_100,
      samples: [200, 0],
    });
  });

  it("decode_rejects_garbage_and_non_16_bit", () => {
    expect(() => decodeWav(new TextEncoder().encode("nope"))).toThrow();
    const w = encodeWav(buf(16_000, [1, 2]));
    w[34] = 8; // bits per sample
    expect(() => decodeWav(w)).toThrow(/16-bit PCM/);
  });

  it("resample_length_and_endpoints", () => {
    const ramp = Array.from({ length: 160 }, (_, i) => i * 100);
    const a = buf(16_000, ramp);
    const up = resample(a, 48_000);
    expect(up.sampleRate).toBe(48_000);
    expect(up.samples.length).toBe(480);
    expect(up.samples[0]).toBe(0);
    expect(up.samples[3]).toBe(100); // exactly on input sample 1
    expect(up.samples[1]).toBe(33); // 1/3 of the way to 100
    expect(up.samples[up.samples.length - 1]).toBe(15_900);

    const down = resample(up, 16_000);
    expect(down.samples.length).toBe(160);
    expect(down.samples[0]).toBe(0);
    expect(down.samples[10]).toBe(1000);
  });

  it("resample_edge_cases", () => {
    const a = buf(16_000, [5, 6, 7]);
    expect(plain(resample(a, 16_000))).toEqual(plain(a));
    expect(resample(buf(16_000, []), 24_000).samples.length).toBe(0);
    expect([...resample(buf(16_000, [9]), 32_000).samples]).toEqual([9, 9]);
  });
});

describe("tts", () => {
  it("language_mapping", () => {
    expect(sovitsLang("Japanese")).toBe("ja");
    expect(sovitsLang(" zh ")).toBe("zh");
    expect(sovitsLang("klingon")).toBeNull();
  });
});
