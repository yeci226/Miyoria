// The media type of an artifact, decided from its bytes (v5-architecture §11.2: "型別看內容判斷,不信副
// 檔名"). The kinds she makes have fixed signatures in their first bytes: PNG, JPEG, WebP, GIF, WAV,
// MP3, OGG, MP4, WebM, PDF. Anything without one is accepted only as plain text, and only when the
// whole content is UTF-8 without NUL or control characters (tab, newline, carriage return and form
// feed allowed). Everything else is refused, so HTML, SVG, scripts and executables never come in
// under a type a browser would run: HTML or SVG text is stored as `text/plain`.
//
// A caller may declare the type it believes it has. A declaration the content contradicts is
// refused; one that agrees (an alias, a text subtype for text) is replaced by the sniffed type.

import type { ArtifactKind } from "@miyoria/contracts/events";
import { StoreError } from "../common.js";

/** How many leading bytes `sniff` looks at. */
export const SNIFF_BYTES = 64;

/** A media type the store accepts, with its kind and download extension. */
export interface MediaType {
  mime: string;
  kind: ArtifactKind;
  extension: string;
}

const TYPES = {
  png: { mime: "image/png", kind: "image", extension: "png" },
  jpeg: { mime: "image/jpeg", kind: "image", extension: "jpg" },
  webp: { mime: "image/webp", kind: "image", extension: "webp" },
  gif: { mime: "image/gif", kind: "image", extension: "gif" },
  wav: { mime: "audio/wav", kind: "audio", extension: "wav" },
  mp3: { mime: "audio/mpeg", kind: "audio", extension: "mp3" },
  ogg: { mime: "audio/ogg", kind: "audio", extension: "ogg" },
  oggVideo: { mime: "video/ogg", kind: "video", extension: "ogv" },
  mp4: { mime: "video/mp4", kind: "video", extension: "mp4" },
  m4a: { mime: "audio/mp4", kind: "audio", extension: "m4a" },
  webm: { mime: "video/webm", kind: "video", extension: "webm" },
  pdf: { mime: "application/pdf", kind: "document", extension: "pdf" },
  text: { mime: "text/plain", kind: "text", extension: "txt" },
} as const satisfies Record<string, MediaType>;

/** Every type the store stores, by mime. */
export const MEDIA_TYPES: readonly MediaType[] = Object.values(TYPES);

/** The plain-text type: what text without a signature is. */
export const TEXT_TYPE: MediaType = TYPES.text;

/** Content the store does not accept, or that contradicts what the caller declared. */
export class ArtifactTypeError extends StoreError {}

function ascii(bytes: Uint8Array, at: number, text: string): boolean {
  if (bytes.length < at + text.length) return false;
  for (let i = 0; i < text.length; i++) {
    if (bytes[at + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return bytes.length >= prefix.length && prefix.every((b, i) => bytes[i] === b);
}

/** Whether `needle` (ASCII) occurs in `bytes`. */
function contains(bytes: Uint8Array, needle: string): boolean {
  for (let at = 0; at + needle.length <= bytes.length; at++) {
    if (ascii(bytes, at, needle)) return true;
  }
  return false;
}

/** An MPEG audio frame header (layer III, II or I) at `at`. */
function mpegFrame(bytes: Uint8Array, at: number): boolean {
  const b1 = bytes[at];
  const b2 = bytes[at + 1];
  const b3 = bytes[at + 2];
  if (b1 !== 0xff || b2 === undefined || b3 === undefined) return false;
  if ((b2 & 0xe0) !== 0xe0) return false; // frame sync
  if (((b2 >> 3) & 0x03) === 0x01) return false; // reserved version
  if (((b2 >> 1) & 0x03) === 0x00) return false; // reserved layer
  const bitrate = b3 >> 4;
  if (bitrate === 0x0f) return false;
  if (((b3 >> 2) & 0x03) === 0x03) return false; // reserved sample rate
  return true;
}

/** ISO base media brands taken as MP4 video, and as MP4 audio. */
const MP4_BRANDS = new Set([
  "isom",
  "iso2",
  "iso3",
  "iso4",
  "iso5",
  "iso6",
  "mp41",
  "mp42",
  "avc1",
  "dash",
  "mmp4",
  "M4V ",
  "M4VP",
  "MSNV",
]);
const M4A_BRANDS = new Set(["M4A ", "M4B "]);

/**
 * The binary type `head` (the first `SNIFF_BYTES` bytes, or all of a shorter content) starts
 * with, or `null` when it has no signature this store knows.
 */
export function sniff(head: Uint8Array): MediaType | null {
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return TYPES.png;
  if (startsWith(head, [0xff, 0xd8, 0xff])) return TYPES.jpeg;
  if (ascii(head, 0, "GIF87a") || ascii(head, 0, "GIF89a")) return TYPES.gif;
  if (ascii(head, 0, "RIFF") && ascii(head, 8, "WEBP")) return TYPES.webp;
  if (ascii(head, 0, "RIFF") && ascii(head, 8, "WAVE")) return TYPES.wav;
  if (ascii(head, 0, "%PDF-")) return TYPES.pdf;
  if (ascii(head, 0, "OggS")) {
    return contains(head, "theora") ? TYPES.oggVideo : TYPES.ogg;
  }
  if (startsWith(head, [0x1a, 0x45, 0xdf, 0xa3])) {
    // Matroska's EBML header; WebM says so in its DocType.
    return contains(head, "webm") ? TYPES.webm : null;
  }
  if (ascii(head, 4, "ftyp") && head.length >= 12) {
    const brand = String.fromCharCode(...head.subarray(8, 12));
    if (M4A_BRANDS.has(brand)) return TYPES.m4a;
    if (MP4_BRANDS.has(brand)) return TYPES.mp4;
    return null; // QuickTime, HEIF, 3GP, ...: not one of hers
  }
  if (ascii(head, 0, "ID3") || mpegFrame(head, 0)) return TYPES.mp3;
  return null;
}

/**
 * Checks, a chunk at a time, that a whole content is plain text: UTF-8 (a BOM allowed) without
 * NUL or control characters other than tab, newline, carriage return and form feed.
 */
export class TextCheck {
  readonly #decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  #ok = true;

  get ok(): boolean {
    return this.#ok;
  }

  push(chunk: Uint8Array): void {
    if (!this.#ok) return;
    try {
      this.#check(this.#decoder.decode(chunk, { stream: true }));
    } catch {
      this.#ok = false;
    }
  }

  /** Whether everything pushed was text. */
  end(): boolean {
    if (!this.#ok) return false;
    try {
      this.#check(this.#decoder.decode());
    } catch {
      this.#ok = false;
    }
    return this.#ok;
  }

  #check(text: string): void {
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      const control = c < 0x20 || (c >= 0x7f && c <= 0x9f);
      if (control && c !== 0x09 && c !== 0x0a && c !== 0x0d && c !== 0x0c) {
        this.#ok = false;
        return;
      }
    }
  }
}

/** Declared types that name the same content as a stored one. */
const ALIASES: Record<string, string> = {
  "image/jpg": "image/jpeg",
  "image/pjpeg": "image/jpeg",
  "audio/mp3": "audio/mpeg",
  "audio/x-mp3": "audio/mpeg",
  "audio/mpeg3": "audio/mpeg",
  "audio/x-mpeg": "audio/mpeg",
  "audio/wave": "audio/wav",
  "audio/x-wav": "audio/wav",
  "audio/vnd.wave": "audio/wav",
  "audio/x-pn-wav": "audio/wav",
  "application/x-pdf": "application/pdf",
  "audio/x-m4a": "audio/mp4",
  "audio/m4a": "audio/mp4",
};

/** One container, two kinds: a declaration of either agrees with the content. */
const SAME_CONTAINER: Record<string, readonly string[]> = {
  "video/mp4": ["audio/mp4", "application/mp4"],
  "audio/mp4": ["video/mp4", "application/mp4"],
  "audio/ogg": ["video/ogg", "application/ogg"],
  "video/ogg": ["audio/ogg", "application/ogg"],
  "video/webm": ["audio/webm"],
};

/** Declared types that text content agrees with (stored as `text/plain` all the same). */
const TEXT_DECLARATIONS = new Set(["application/json", "application/x-ndjson", "application/xml"]);

/** A declared type without parameters, lowercased; `null` for none. */
export function normalizeMime(declared: string | null | undefined): string | null {
  if (declared === null || declared === undefined) return null;
  const bare = declared.split(";")[0]?.trim().toLowerCase() ?? "";
  if (bare === "" || bare === "application/octet-stream") return null;
  return ALIASES[bare] ?? bare;
}

/** Whether `declared` (normalised) agrees with the sniffed `type`. */
export function agrees(declared: string, type: MediaType): boolean {
  if (declared === type.mime) return true;
  if (SAME_CONTAINER[type.mime]?.includes(declared)) return true;
  if (type === TYPES.text) return declared.startsWith("text/") || TEXT_DECLARATIONS.has(declared);
  return false;
}

/**
 * The type of a whole content from its first bytes and whether all of it was text. Throws an
 * `ArtifactTypeError` when it is none of the accepted types or contradicts `declared`.
 */
export function decideType(
  head: Uint8Array,
  isText: boolean,
  declared: string | null | undefined,
): MediaType {
  const type = sniff(head) ?? (isText ? TYPES.text : null);
  if (type === null) {
    throw new ArtifactTypeError(
      "the content is not one of the accepted types (PNG, JPEG, WebP, GIF, WAV, MP3, OGG, MP4, " +
        "WebM, PDF, plain text)",
    );
  }
  const want = normalizeMime(declared);
  if (want !== null && !agrees(want, type)) {
    throw new ArtifactTypeError(`the content is ${type.mime}, not the declared ${want}`);
  }
  return type;
}
