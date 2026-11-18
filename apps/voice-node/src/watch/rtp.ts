// Raw RTP side of watching a Go Live: parsing, PLI keyframe requests and H.264 (RFC 6184) reassembly.

export interface RtpPacket {
  payloadType: number;
  marker: boolean;
  seq: number;
  timestamp: number;
  ssrc: number;
  payload: Buffer;
}

/** RTCP shares the port with RTP (rtcp-mux); its packet types are 192-223. */
export function isRtcp(b: Buffer): boolean {
  const pt = b[1];
  return pt !== undefined && pt >= 192 && pt <= 223;
}

export function parseRtp(b: Buffer): RtpPacket | null {
  if (b.length < 12 || (b.readUInt8(0) & 0xc0) !== 0x80) return null;
  const first = b.readUInt8(0);
  const second = b.readUInt8(1);
  let offset = 12 + (first & 0x0f) * 4;
  if (first & 0x10) {
    if (b.length < offset + 4) return null;
    offset += 4 + b.readUInt16BE(offset + 2) * 4;
  }
  let end = b.length;
  if (first & 0x20) end -= b.readUInt8(b.length - 1);
  if (offset > end) return null;
  return {
    payloadType: second & 0x7f,
    marker: (second & 0x80) !== 0,
    seq: b.readUInt16BE(2),
    timestamp: b.readUInt32BE(4),
    ssrc: b.readUInt32BE(8),
    payload: b.subarray(offset, end),
  };
}

/** Picture Loss Indication (RFC 4585): asks the sender for a keyframe. */
export function pliPacket(senderSsrc: number, mediaSsrc: number): Buffer {
  const b = Buffer.alloc(12);
  b.writeUInt8(0x81, 0); // V=2, FMT=1
  b.writeUInt8(206, 1); // payload-specific feedback
  b.writeUInt16BE(2, 2);
  b.writeUInt32BE(senderSsrc >>> 0, 4);
  b.writeUInt32BE(mediaSsrc >>> 0, 8);
  return b;
}

export interface H264Frame {
  /** Annex-B with 4-byte start codes, the form DAVE encrypts. */
  data: Buffer;
  keyframe: boolean;
}

const START = Buffer.from([0, 0, 0, 1]);
const MAX_PENDING = 32;

function naluType(b: number | undefined): number {
  return (b ?? 0) & 0x1f;
}

/** Turns one H.264 access unit's packets (RFC 6184: single NAL, STAP-A, FU-A) into Annex-B. */
function assemble(packets: readonly RtpPacket[]): H264Frame | null {
  const out: Buffer[] = [];
  let keyframe = false;
  const nal = (data: Buffer): void => {
    if (naluType(data[0]) === 5) keyframe = true;
    out.push(START, data);
  };
  let fu: Buffer[] | null = null;
  for (const { payload } of packets) {
    const type = naluType(payload[0]);
    if (type >= 1 && type <= 23) {
      nal(payload);
    } else if (type === 24) {
      let i = 1;
      while (i + 2 <= payload.length) {
        const size = payload.readUInt16BE(i);
        i += 2;
        if (i + size > payload.length) return null;
        nal(payload.subarray(i, i + size));
        i += size;
      }
    } else if (type === 28) {
      const indicator = payload[0];
      const header = payload[1];
      if (indicator === undefined || header === undefined) return null;
      if (header & 0x80) fu = [Buffer.from([(indicator & 0xe0) | (header & 0x1f)])];
      if (!fu) return null;
      fu.push(payload.subarray(2));
      if (header & 0x40) {
        nal(Buffer.concat(fu));
        fu = null;
      }
    } else {
      return null;
    }
  }
  if (fu || out.length === 0) return null;
  return { data: Buffer.concat(out), keyframe };
}

/**
 * Collects packets by timestamp and emits a frame at its marker bit. A frame with a gap is
 * dropped (counted in `broken`): DAVE authenticates whole frames, so a partial one is useless.
 */
export class H264Assembler {
  readonly #pending = new Map<number, RtpPacket[]>();
  broken = 0;

  push(packet: RtpPacket): H264Frame | null {
    const list = this.#pending.get(packet.timestamp) ?? [];
    if (list.some((p) => p.seq === packet.seq)) return null;
    list.push(packet);
    this.#pending.set(packet.timestamp, list);
    if (this.#pending.size > MAX_PENDING) {
      const oldest = this.#pending.keys().next().value;
      if (oldest !== undefined) {
        this.#pending.delete(oldest);
        this.broken++;
      }
    }
    if (!list.some((p) => p.marker)) return null;
    const base = list[0]?.seq ?? 0;
    // Distances from the first arrival, so the order survives the 16-bit wrap.
    const signed = (seq: number): number => ((seq - base + 0x8000) & 0xffff) - 0x8000;
    const sorted = [...list].sort((a, b) => signed(a.seq) - signed(b.seq));
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    if (!first || !last) return null;
    const span = ((last.seq - first.seq) & 0xffff) + 1;
    if (span !== sorted.length) return null; // Late packets may still fill the gap.
    this.#pending.delete(packet.timestamp);
    const frame = assemble(sorted);
    if (!frame) this.broken++;
    return frame;
  }
}
