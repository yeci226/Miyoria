import { describe, expect, it } from "vitest";
import { H264Assembler, isRtcp, parseRtp, pliPacket, type RtpPacket } from "../src/watch/rtp.js";

interface RtpOptions {
  marker?: boolean;
  ext?: boolean;
  csrc?: number;
  padding?: number;
}

function rtp(pt: number, seq: number, ts: number, ssrc: number, payload: Buffer, o: RtpOptions = {}): Buffer {
  const csrc = o.csrc ?? 0;
  const extension = o.ext ? Buffer.from([0xbe, 0xde, 0, 1, 1, 2, 3, 4]) : Buffer.alloc(0);
  const h = Buffer.alloc(12 + csrc * 4);
  h.writeUInt8(0x80 | (o.padding ? 0x20 : 0) | (o.ext ? 0x10 : 0) | csrc, 0);
  h.writeUInt8((o.marker ? 0x80 : 0) | pt, 1);
  h.writeUInt16BE(seq & 0xffff, 2);
  h.writeUInt32BE(ts, 4);
  h.writeUInt32BE(ssrc, 8);
  const pad = o.padding ? Buffer.concat([Buffer.alloc(o.padding - 1), Buffer.from([o.padding])]) : Buffer.alloc(0);
  return Buffer.concat([h, extension, payload, pad]);
}

function pkt(seq: number, ts: number, payload: Buffer, marker = false): RtpPacket {
  const parsed = parseRtp(rtp(101, seq, ts, 1, payload, { marker }));
  if (!parsed) throw new Error("test packet did not parse");
  return parsed;
}

const fu = (start: boolean, end: boolean, chunk: Buffer): Buffer =>
  Buffer.concat([Buffer.from([0x7c, (start ? 0x80 : 0) | (end ? 0x40 : 0) | 5]), chunk]);
const CODE = Buffer.from([0, 0, 0, 1]);

describe("parseRtp", () => {
  it("reads the header fields", () => {
    const p = parseRtp(rtp(101, 7, 90, 0xabcd, Buffer.from([1, 2]), { marker: true }));
    expect(p).toMatchObject({ payloadType: 101, marker: true, seq: 7, timestamp: 90, ssrc: 0xabcd });
    expect([...(p?.payload ?? [])]).toEqual([1, 2]);
  });

  it("skips header extensions", () => {
    const p = parseRtp(rtp(120, 1, 2, 3, Buffer.from([9, 8]), { marker: true, ext: true }));
    expect([...(p?.payload ?? [])]).toEqual([9, 8]);
  });

  it("skips CSRC entries", () => {
    const p = parseRtp(rtp(101, 1, 2, 3, Buffer.from([9, 8]), { csrc: 2 }));
    expect([...(p?.payload ?? [])]).toEqual([9, 8]);
  });

  it("strips padding", () => {
    const p = parseRtp(rtp(101, 1, 2, 3, Buffer.from([9, 8]), { padding: 4 }));
    expect([...(p?.payload ?? [])]).toEqual([9, 8]);
  });

  it("rejects short or non-RTP data", () => {
    expect(parseRtp(Buffer.alloc(5))).toBeNull();
    expect(parseRtp(Buffer.alloc(12))).toBeNull();
  });
});

describe("isRtcp / pliPacket", () => {
  it("tells RTCP packet types from RTP", () => {
    expect(isRtcp(Buffer.from([0x81, 206]))).toBe(true);
    expect(isRtcp(Buffer.from([0x80, 101]))).toBe(false);
    expect(isRtcp(Buffer.alloc(1))).toBe(false);
  });

  it("builds a 12-byte PLI", () => {
    const b = pliPacket(1, 2);
    expect(b.length).toBe(12);
    expect([b[0], b[1]]).toEqual([0x81, 0xce]);
    expect(b.readUInt32BE(4)).toBe(1);
    expect(b.readUInt32BE(8)).toBe(2);
  });
});

describe("H264Assembler", () => {
  it("rebuilds a keyframe from out-of-order packets across the sequence wrap", () => {
    const sps = Buffer.from([0x67, 1, 2]);
    const idr = Buffer.alloc(3000, 7);
    idr[0] = 0x65;
    const stap = Buffer.concat([Buffer.from([0x78, 0, sps.length]), sps, Buffer.from([0, 2, 0x68, 9])]);
    const a = new H264Assembler();
    const results = [
      pkt(65534, 90, stap),
      pkt(65535, 90, fu(true, false, idr.subarray(1, 1000))),
      pkt(1, 90, fu(false, true, idr.subarray(2000)), true),
      pkt(0, 90, fu(false, false, idr.subarray(1000, 2000))),
    ].map((p) => a.push(p));
    expect(results.slice(0, 3)).toEqual([null, null, null]);
    expect(results[3]?.keyframe).toBe(true);
    expect(results[3]?.data.equals(Buffer.concat([CODE, sps, CODE, Buffer.from([0x68, 9]), CODE, idr]))).toBe(true);
    expect(a.broken).toBe(0);
  });

  it("emits a single NAL as a non-keyframe", () => {
    const a = new H264Assembler();
    const frame = a.push(pkt(1, 5, Buffer.from([0x41, 1]), true));
    expect(frame?.keyframe).toBe(false);
    expect(frame?.data.equals(Buffer.concat([CODE, Buffer.from([0x41, 1])]))).toBe(true);
  });

  it("gives no frame while a gap remains, and ignores duplicates", () => {
    const a = new H264Assembler();
    expect(a.push(pkt(10, 5, Buffer.from([0x41, 1])))).toBeNull();
    expect(a.push(pkt(10, 5, Buffer.from([0x41, 1])))).toBeNull();
    expect(a.push(pkt(12, 5, Buffer.from([0x41, 2]), true))).toBeNull();
    expect(a.push(pkt(11, 5, Buffer.from([0x41, 3])))?.keyframe).toBe(false);
  });

  it("counts a FU-A with no start as broken", () => {
    const a = new H264Assembler();
    expect(a.push(pkt(1, 5, fu(false, true, Buffer.from([1, 2, 3])), true))).toBeNull();
    expect(a.broken).toBe(1);
  });

  it("drops the oldest pending frame beyond MAX_PENDING", () => {
    const a = new H264Assembler();
    for (let i = 0; i < 32; i++) a.push(pkt(i, 100 + i, Buffer.from([0x41, 1])));
    expect(a.broken).toBe(0);
    a.push(pkt(32, 132, Buffer.from([0x41, 1])));
    expect(a.broken).toBe(1);
    // The dropped timestamp is gone: its marker alone now completes a one-packet frame, not the old one.
    expect(a.push(pkt(33, 133, Buffer.from([0x41, 1]), true))?.keyframe).toBe(false);
  });
});
