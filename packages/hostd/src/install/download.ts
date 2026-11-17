// Single files a descriptor lists in `[[install.files]]`: downloaded into the host's model folder
// from an allowlist of hosts and nowhere else, resumable (`<file>.part` plus a Range request), and
// checked against the descriptor's `sha256` when it has one. An existing file is never replaced.

import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/** Hosts a file may come from. The URL the descriptor names is checked, not the redirects. */
export const DOWNLOAD_HOSTS = ["huggingface.co", "raw.githubusercontent.com"] as const;

export type Fetch = typeof fetch;

export class DownloadError extends Error {
  override name = "DownloadError";
}

export interface DownloadOptions {
  fetchImpl?: Fetch;
  /** The expected SHA-256 (hex). */
  sha256?: string;
  /** Replaces `DOWNLOAD_HOSTS` (tests use a local server). */
  allowedHosts?: readonly string[];
  signal?: AbortSignal;
}

/** The SHA-256 of a file, hex. */
export function fileSha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

async function checkSum(file: string, expected: string | undefined, what: string): Promise<void> {
  if (expected === undefined) return;
  const actual = await fileSha256(file);
  if (actual !== expected.toLowerCase()) {
    throw new DownloadError(`${what}: SHA-256 is ${actual}, the descriptor says ${expected}`);
  }
}

/**
 * Downloads `url` to `dest` (absolute) and returns what it did. An existing `dest` is kept (and
 * checked against `sha256` when given). A checksum mismatch deletes the download and throws.
 */
export async function downloadFile(
  url: string,
  dest: string,
  options: DownloadOptions = {},
): Promise<"downloaded" | "exists"> {
  const fetchImpl = options.fetchImpl ?? fetch;
  if (existsSync(dest)) {
    await checkSum(dest, options.sha256, `${dest} exists but`);
    return "exists";
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new DownloadError(`${url} is not a URL`);
  }
  const allowed = options.allowedHosts ?? DOWNLOAD_HOSTS;
  if (!allowed.includes(parsed.hostname)) {
    throw new DownloadError(`${parsed.hostname} is not on the list of hosts files may come from`);
  }
  mkdirSync(dirname(dest), { recursive: true });
  const part = `${dest}.part`;

  for (let attempt = 0; attempt < 2; attempt++) {
    const have = existsSync(part) ? statSync(part).size : 0;
    const res = await fetchImpl(url, {
      ...(have > 0 ? { headers: { range: `bytes=${have}-` } } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
    if (res.status === 416 && have > 0) {
      // The part is longer than the file or the file changed: start again.
      rmSync(part, { force: true });
      continue;
    }
    if (!res.ok || res.body === null) throw new DownloadError(`HTTP ${res.status} for ${url}`);
    const resumed = res.status === 206;
    const total = Number(res.headers.get("content-length") ?? "0") + (resumed ? have : 0);
    await pipeline(
      Readable.fromWeb(res.body as never),
      createWriteStream(part, { flags: resumed ? "a" : "w" }),
    );
    const size = statSync(part).size;
    if (total > 0 && size !== total) {
      throw new DownloadError(
        `incomplete (${size} of ${total} bytes); running it again continues the download`,
      );
    }
    try {
      await checkSum(part, options.sha256, url);
    } catch (error) {
      rmSync(part, { force: true });
      throw error;
    }
    renameSync(part, dest);
    return "downloaded";
  }
  throw new DownloadError(`the server refused to resume ${url}`);
}
