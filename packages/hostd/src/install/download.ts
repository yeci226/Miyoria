// One file of `[[install.files]]`, downloaded into the host's model folder (docs/design/v5-hostd.md
// §9): https only, from an allowlist of hosts (each redirect is checked too, and there are at most a
// few), into `<file>.part` with a Range request to continue an interrupted transfer, with a timeout
// when no data comes and retries with backoff, and checked against the descriptor's SHA-256 before
// the `.part` is renamed into place. A file that does not match is deleted. Nothing downloaded is
// ever run; the caller keeps every path inside the model folder.

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
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * Hosts a file may come from, the redirects included. A leading dot means "any name below it".
 * huggingface.co sends a download on to its CDN (`cdn-lfs*.huggingface.co`, `*.hf.co`); a github.com
 * release asset goes on to `objects.githubusercontent.com` or `release-assets.githubusercontent.com`;
 * `raw.githubusercontent.com` is the host the turn worker's Silero file is published on.
 */
export const DOWNLOAD_HOSTS: readonly string[] = [
  "huggingface.co",
  ".huggingface.co",
  ".hf.co",
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "raw.githubusercontent.com",
];

/** How many redirects one request may follow. */
export const MAX_REDIRECTS = 5;
/** The transfer is given up (and retried) after this long without a byte. */
export const IDLE_TIMEOUT_MS = 60_000;
/** The waits before the second, third and fourth attempt. */
export const RETRY_DELAYS_MS: readonly number[] = [2_000, 8_000, 30_000];

export type Fetch = typeof fetch;

export class DownloadError extends Error {
  override name = "DownloadError";

  constructor(
    message: string,
    /** Whether trying again may help (a dropped connection, a 5xx, a timeout). */
    readonly retryable = false,
  ) {
    super(message);
  }
}

export interface DownloadOptions {
  /** The expected SHA-256 (hex). */
  sha256: string;
  /** The expected size in bytes: a transfer that grows past it is stopped. */
  size?: number;
  fetchImpl?: Fetch;
  /** Replaces `DOWNLOAD_HOSTS` (tests). */
  allowedHosts?: readonly string[];
  signal?: AbortSignal;
  /** Progress lines for a terminal, at most about one a second. */
  onProgress?: (line: string) => void;
  /** The name progress lines and errors use (default: the destination). */
  label?: string;
  idleTimeoutMs?: number;
  retryDelaysMs?: readonly number[];
  maxRedirects?: number;
}

export interface DownloadOutcome {
  sha256: string;
  bytes: number;
}

/** `1.5 GB`, `9.0 MB`, `512 B`. */
export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${bytes} B` : `${value.toFixed(1)} ${units[unit]}`;
}

/** Whether a host name is on an allowlist (`.example.com` allows the names below it). */
export function hostAllowed(
  hostname: string,
  allowed: readonly string[] = DOWNLOAD_HOSTS,
): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return allowed.some((entry) => {
    const rule = entry.toLowerCase();
    return rule.startsWith(".") ? host.endsWith(rule) && host.length > rule.length : host === rule;
  });
}

/** Throws unless `url` is https, names no credentials and its host is allowed. */
export function checkDownloadUrl(url: string, allowed: readonly string[] = DOWNLOAD_HOSTS): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new DownloadError(`${url} 不是網址`);
  }
  if (parsed.protocol !== "https:") {
    throw new DownloadError(`${parsed.origin} 不是 https;只從 https 下載`);
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new DownloadError(`${parsed.hostname} 的網址裡有帳號密碼,不會下載`);
  }
  if (!hostAllowed(parsed.hostname, allowed)) {
    throw new DownloadError(`${parsed.hostname} 不在允許下載的主機清單上(${allowed.join("、")})`);
  }
  return parsed;
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

const REDIRECTS: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DownloadError("已取消"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DownloadError("已取消"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** The first byte of a `Content-Range: bytes 300-999/1000`, and the total when the server says it. */
function contentRange(header: string | null): { start: number; total?: number } | null {
  const m = header === null ? null : /^bytes\s+(\d+)-\d+\/(\d+|\*)$/i.exec(header.trim());
  if (m === null) return null;
  return {
    start: Number(m[1]),
    ...(m[2] !== "*" ? { total: Number(m[2]) } : {}),
  };
}

interface Attempt {
  url: string;
  part: string;
  label: string;
  options: DownloadOptions;
  allowed: readonly string[];
}

/** One request, following at most `maxRedirects` redirects, each checked like the first URL. */
async function follow(attempt: Attempt, have: number, signal: AbortSignal): Promise<Response> {
  const fetchImpl = attempt.options.fetchImpl ?? fetch;
  const max = attempt.options.maxRedirects ?? MAX_REDIRECTS;
  let current = attempt.url;
  for (let hop = 0; hop <= max; hop++) {
    checkDownloadUrl(current, attempt.allowed);
    const res = await fetchImpl(current, {
      redirect: "manual",
      signal,
      ...(have > 0 ? { headers: { range: `bytes=${have}-` } } : {}),
    });
    if (!REDIRECTS.has(res.status)) return res;
    const location = res.headers.get("location");
    await res.body?.cancel().catch(() => undefined);
    if (location === null) throw new DownloadError(`HTTP ${res.status} 沒有給轉址的位置`);
    current = new URL(location, current).href;
  }
  throw new DownloadError(`轉址超過 ${max} 次,不再跟下去`);
}

/** Moves the bytes of one attempt into `<dest>.part`. Resolves when the part looks complete. */
async function transfer(attempt: Attempt): Promise<void> {
  const { part, options, label } = attempt;
  const size = options.size;
  let have = existsSync(part) ? statSync(part).size : 0;
  if (size !== undefined && have > size) {
    rmSync(part, { force: true });
    have = 0;
  }
  if (size !== undefined && have === size) return; // transferred before, not checked yet

  const idle = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
  const controller = new AbortController();
  const signal =
    options.signal !== undefined
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, idle);
  };
  let tooBig = false;
  try {
    arm();
    const res = await follow(attempt, have, signal);
    arm();
    if (res.status === 416 && have > 0) {
      await res.body?.cancel().catch(() => undefined);
      rmSync(part, { force: true });
      throw new DownloadError("伺服器不接受續傳的位置,重新下載", true);
    }
    let append = false;
    let total: number | undefined;
    if (res.status === 206) {
      const range = contentRange(res.headers.get("content-range"));
      if (range === null || range.start !== have) {
        await res.body?.cancel().catch(() => undefined);
        rmSync(part, { force: true });
        throw new DownloadError("伺服器續傳的位置不對,重新下載", true);
      }
      append = true;
      total = range.total;
    } else if (res.status === 200) {
      have = 0;
      const length = Number(res.headers.get("content-length") ?? Number.NaN);
      if (Number.isFinite(length)) total = length;
    } else {
      await res.body?.cancel().catch(() => undefined);
      throw new DownloadError(`HTTP ${res.status}`, retryableStatus(res.status));
    }
    if (size !== undefined && total !== undefined && total !== size) {
      await res.body?.cancel().catch(() => undefined);
      rmSync(part, { force: true });
      throw new DownloadError(
        `伺服器上的檔案是 ${total} bytes,service.toml 寫的是 ${size} bytes(來源換了檔案?)`,
      );
    }
    if (res.body === null) throw new DownloadError("伺服器沒有送內容", true);
    const expected = size ?? total;

    let written = have;
    let lastReport = 0;
    let lastBytes = have;
    let lastTime = Date.now();
    const report = (force: boolean) => {
      if (options.onProgress === undefined) return;
      const now = Date.now();
      if (!force && now - lastReport < 1000) return;
      const seconds = Math.max((now - lastTime) / 1000, 0.001);
      const rate = (written - lastBytes) / seconds;
      lastReport = now;
      lastBytes = written;
      lastTime = now;
      const pct =
        expected !== undefined && expected > 0
          ? `${Math.floor((written / expected) * 100)}%  `
          : "";
      options.onProgress(
        `${label}  ${pct}${formatBytes(written)}${expected !== undefined ? ` / ${formatBytes(expected)}` : ""}  ${formatBytes(rate)}/s`,
      );
    };
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        written += chunk.length;
        arm();
        if (size !== undefined && written > size) {
          tooBig = true;
          done(new DownloadError(`收到的資料比 service.toml 寫的 ${size} bytes 還多,停止下載`));
          return;
        }
        report(false);
        done(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(res.body as never),
      counter,
      createWriteStream(part, { flags: append ? "a" : "w" }),
      { signal },
    );
    report(true);
    if (expected !== undefined && written < expected) {
      throw new DownloadError(`只收到 ${written} / ${expected} bytes`, true);
    }
  } catch (error) {
    if (tooBig) rmSync(part, { force: true });
    if (error instanceof DownloadError) throw error;
    if (timedOut) throw new DownloadError(`超過 ${Math.round(idle / 1000)} 秒沒有收到資料`, true);
    if (options.signal?.aborted) throw new DownloadError("已取消");
    throw new DownloadError(
      `連線中斷:${error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error)}`,
      true,
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Downloads `url` to `dest` (absolute) and returns its checksum and size. An earlier `<dest>.part`
 * is continued; a `dest` already there is replaced only by a download that matches `sha256`. A
 * download that does not match is deleted and the call throws.
 */
export async function downloadFile(
  url: string,
  dest: string,
  options: DownloadOptions,
): Promise<DownloadOutcome> {
  const allowed = options.allowedHosts ?? DOWNLOAD_HOSTS;
  checkDownloadUrl(url, allowed);
  const expected = options.sha256.toLowerCase();
  const label = options.label ?? dest;
  mkdirSync(dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  const attempt: Attempt = { url, part, label, options, allowed };
  const delays = options.retryDelaysMs ?? RETRY_DELAYS_MS;

  for (let tried = 0; ; tried++) {
    try {
      await transfer(attempt);
      break;
    } catch (error) {
      const failure =
        error instanceof DownloadError ? error : new DownloadError(String(error), true);
      const delay = delays[tried];
      if (!failure.retryable || delay === undefined || options.signal?.aborted) {
        throw new DownloadError(`${label}:${failure.message}`, failure.retryable);
      }
      options.onProgress?.(
        `${label}  ${failure.message};${Math.round(delay / 1000)} 秒後重試(第 ${tried + 2} 次)`,
      );
      await sleep(delay, options.signal);
    }
  }

  const actual = await fileSha256(part);
  if (actual !== expected) {
    rmSync(part, { force: true });
    throw new DownloadError(
      `${label}:SHA-256 是 ${actual},service.toml 寫的是 ${expected};下載的檔案已刪除`,
    );
  }
  const bytes = statSync(part).size;
  renameSync(part, dest);
  return { sha256: actual, bytes };
}
