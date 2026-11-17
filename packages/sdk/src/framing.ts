// LSP-style `Content-Length` framing: a header block, a blank line and a UTF-8 body of exactly
// that many bytes. The one copy of it: the SDK's peer and the host's both read and write frames
// with this module.

import { EXT_LIMITS } from "@miyoria/contracts/ext";

/** Largest accepted frame body, in bytes. */
export const MAX_FRAME = EXT_LIMITS.MAX_FRAME_BYTES;

/** A frame that cannot be read: a bad header, a body over the cap, a stream cut in the middle. */
export class FramingError extends Error {
  override name = "FramingError";
}

function toBuffer(chunk: Buffer | Uint8Array | string): Buffer {
  if (typeof chunk === "string") return Buffer.from(chunk, "utf8");
  if (Buffer.isBuffer(chunk)) return chunk;
  return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
}

/** Encodes one JSON message as a frame. */
export function encodeFrame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
}

/**
 * Incremental decoder: `push` takes the chunks of a stream and returns the body of every frame
 * they complete, as bytes. Headers end at a blank line, names are case-insensitive, and only
 * `Content-Length` is read. `end` throws if the stream stopped in the middle of a frame.
 */
export class FrameBodyDecoder {
  #buffer: Buffer = Buffer.alloc(0);
  /** `null` while reading headers; the body length once the blank line was seen. */
  #length: number | null = null;
  #headerLength: number | null = null;
  /** Bytes of header lines read so far for the frame being read. */
  #headerBytes = 0;
  #sawHeader = false;

  /** Appends a chunk and returns the body of every frame it completes. */
  push(chunk: Buffer | Uint8Array | string): Buffer[] {
    const bytes = toBuffer(chunk);
    this.#buffer = this.#buffer.length === 0 ? bytes : Buffer.concat([this.#buffer, bytes]);
    const out: Buffer[] = [];
    for (;;) {
      if (this.#length === null) {
        const nl = this.#buffer.indexOf(0x0a);
        if (nl < 0) {
          if (this.#headerBytes + this.#buffer.length > EXT_LIMITS.MAX_HEADER_BYTES) {
            throw new FramingError("header too long");
          }
          return out;
        }
        this.#headerBytes += nl + 1;
        if (this.#headerBytes > EXT_LIMITS.MAX_HEADER_BYTES) {
          throw new FramingError("header too long");
        }
        const line = this.#buffer
          .subarray(0, nl + 1)
          .toString("utf8")
          .replace(/[\r\n]+$/u, "");
        this.#buffer = this.#buffer.subarray(nl + 1);
        this.#sawHeader = true;
        if (line === "") {
          if (this.#headerLength === null) throw new FramingError("missing Content-Length");
          if (this.#headerLength > MAX_FRAME) {
            throw new FramingError(`frame of ${this.#headerLength} bytes is too large`);
          }
          this.#length = this.#headerLength;
          this.#headerLength = null;
          this.#headerBytes = 0;
          continue;
        }
        const colon = line.indexOf(":");
        if (colon < 0) throw new FramingError(`malformed header \`${line}\``);
        if (line.slice(0, colon).trim().toLowerCase() === "content-length") {
          const value = line.slice(colon + 1).trim();
          if (!/^\d+$/u.test(value)) throw new FramingError(`bad Content-Length \`${value}\``);
          this.#headerLength = Number(value);
        }
        continue;
      }
      if (this.#buffer.length < this.#length) return out;
      out.push(Buffer.from(this.#buffer.subarray(0, this.#length)));
      this.#buffer = this.#buffer.subarray(this.#length);
      this.#length = null;
      this.#sawHeader = false;
    }
  }

  /** Bytes buffered but not yet part of a complete frame. */
  get pending(): number {
    return this.#buffer.length;
  }

  /** Call at the end of the stream. Throws when a frame is incomplete. */
  end(): void {
    if (this.#sawHeader || this.#length !== null || this.#buffer.length > 0) {
      throw new FramingError("unexpected end of stream");
    }
  }
}

/** Decoder that returns the parsed JSON of each frame instead of its bytes. */
export class FrameDecoder {
  readonly #bodies = new FrameBodyDecoder();

  /** Appends a chunk and returns every message it completes. */
  push(chunk: Buffer | Uint8Array | string): unknown[] {
    return this.#bodies.push(chunk).map((body) => JSON.parse(body.toString("utf8")) as unknown);
  }

  /** Bytes buffered but not yet part of a complete frame. */
  get pending(): number {
    return this.#bodies.pending;
  }
}
