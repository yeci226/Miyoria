// Where the artifact store keeps bytes (docs/design/v5-data.md §5, v5-architecture §11.2 "id 不是
// 路徑"), and the cleaning of download names.
//
//   <root>/blobs/<aa>/<bb>/<sha256>   one file per distinct content, named by its lowercase hex hash
//   <root>/tmp/<ulid>.part            an ingest being written; renamed into place when complete
//
// Nothing outside the store names a file here. A blob's path is built only from a hash that is
// exactly 64 lowercase hex digits, and a temporary name only from a ULID the store makes, so no id,
// name or path a caller supplies can reach the file system through this module; every path is
// also checked to resolve inside the root. Download names are cleaned for a `Content-Disposition`
// header later, never used as a path.

import { randomBytes } from "node:crypto";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { newId } from "@miyoria/types";
import { StoreError } from "../common.js";

const SHA256 = /^[0-9a-f]{64}$/;

/** Whether `value` is a blob name: 64 lowercase hex digits. */
export function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value);
}

const TEMP_NAME = /^[0-9A-HJKMNP-TV-Z]{26}(?:-[0-9a-f]{8})?\.part$/;

/** Whether `name` is one of the store's temporary file names. */
export function isTempName(name: string): boolean {
  return TEMP_NAME.test(name);
}

/** A path refused because it would leave the store's root, or name something that is not a blob. */
export class ArtifactPathError extends StoreError {}

/** The blob layout under one root directory. */
export class BlobLayout {
  /** Absolute. */
  readonly root: string;
  readonly blobs: string;
  readonly tmp: string;

  constructor(root: string) {
    if (typeof root !== "string" || root.trim() === "" || root.includes("\0")) {
      throw new ArtifactPathError("the artifact store needs a root directory");
    }
    this.root = resolve(root);
    this.blobs = join(this.root, "blobs");
    this.tmp = join(this.root, "tmp");
  }

  /** Throws unless `path` is strictly inside the root. */
  #inside(path: string): string {
    const rel = relative(this.root, path);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).includes("..")) {
      throw new ArtifactPathError("a path left the artifact store's root");
    }
    return path;
  }

  /** The fan-out directory of a blob: `blobs/<aa>/<bb>`. */
  blobDir(sha256: string): string {
    if (!isSha256(sha256)) throw new ArtifactPathError("not a sha256 blob name");
    return this.#inside(join(this.blobs, sha256.slice(0, 2), sha256.slice(2, 4)));
  }

  /** The file of a blob. Refuses anything but 64 lowercase hex digits. */
  blobPath(sha256: string): string {
    return this.#inside(join(this.blobDir(sha256), sha256));
  }

  /** A fresh temporary file name in `tmp/`, never one that exists already. */
  tempPath(): string {
    // The random suffix keeps two stores sharing a root (a test, a second process) apart even
    // when their ULID factories agree to the millisecond.
    return this.#inside(join(this.tmp, `${newId()}-${randomBytes(4).toString("hex")}.part`));
  }

  /** A temporary file named by `name` (from a listing of `tmp/`), when it is one of the store's. */
  tempFile(name: string): string | null {
    return isTempName(name) ? this.#inside(join(this.tmp, name)) : null;
  }
}

// ---- download names --------------------------------------------------------------------------

/** Longest cleaned name, in UTF-8 bytes (most file systems allow 255). */
export const FILENAME_MAX_BYTES = 120;

/** What a name becomes when nothing of it is left. */
const FALLBACK_NAME = "artifact";

/** Windows device names, which name a device whatever the extension. */
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$|clock\$)$/i;

// Code points a download name never keeps: control characters (C0, DEL, C1), path separators and
// the characters Windows refuses, the bidirectional overrides and isolates (which make
// "evil<U+202E>txt.exe" read as "evilexe.txt"), zero-width and other invisible format characters,
// variation selectors, and the Unicode non-characters. As ranges of code points, so the source
// itself carries none of them.
const UNSAFE_RANGES: readonly (readonly [number, number])[] = [
  [0x00, 0x1f],
  [0x7f, 0x9f],
  [0xad, 0xad],
  [0x061c, 0x061c],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180e, 0x180e],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x206f],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xfff0, 0xffff],
  [0xe0000, 0xe0fff],
];
const UNSAFE_ASCII = new Set(["/", "\\", ":", "*", "?", '"', "<", ">", "|"]);

function unsafe(ch: string): boolean {
  if (UNSAFE_ASCII.has(ch)) return true;
  const cp = ch.codePointAt(0) ?? 0;
  // Lone surrogates, and the non-characters U+nFFFE and U+nFFFF of every plane.
  if ((cp >= 0xd800 && cp <= 0xdfff) || (cp & 0xfffe) === 0xfffe) return true;
  return UNSAFE_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);
}

function stripUnsafe(text: string): string {
  let out = "";
  for (const ch of text) if (!unsafe(ch)) out += ch;
  return out;
}

function utf8Length(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** `text` cut to at most `bytes` UTF-8 bytes, never inside a character. */
function cutBytes(text: string, bytes: number): string {
  let out = "";
  for (const ch of text) {
    if (utf8Length(out + ch) > bytes) break;
    out += ch;
  }
  return out;
}

/**
 * A download name made from `name` (a caller's or a model's), ending in `extension` (the sniffed
 * type's, without the dot). The result has no path separators, control, format or bidi
 * characters, no leading dots or dashes, no trailing dots or spaces, is not a Windows device name,
 * is NFC, at most `FILENAME_MAX_BYTES` bytes, and always ends in `.<extension>`: whatever the
 * caller called it, it cannot claim another type.
 */
export function cleanFilename(name: unknown, extension: string): string {
  const ext = extension.toLowerCase().replace(/[^a-z0-9]/g, "");
  let text = typeof name === "string" ? name : "";
  // Only the last segment of anything that looks like a path.
  text = text.split(/[/\\]/).pop() ?? "";
  text = stripUnsafe(text.normalize("NFC")).replace(/\s+/g, " ").trim();
  text = text.replace(/^[.\-\s]+/, "");
  // The caller's extension goes; the content's is added below.
  const dot = text.lastIndexOf(".");
  if (dot > 0) text = text.slice(0, dot);
  text = text.replace(/[.\s]+$/, "");
  // `CON`, `nul.tar`, `COM1 ` name devices on Windows.
  const stem = text.split(".")[0]?.trim() ?? "";
  if (RESERVED.test(stem)) text = `_${text}`;
  if (text === "") text = FALLBACK_NAME;
  const suffix = ext === "" ? "" : `.${ext}`;
  text = cutBytes(text, FILENAME_MAX_BYTES - utf8Length(suffix)).replace(/[.\s]+$/, "");
  if (text === "") text = FALLBACK_NAME;
  return `${text}${suffix}`;
}
