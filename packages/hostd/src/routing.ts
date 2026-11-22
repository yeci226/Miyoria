// What this host reports of each service's `[routing]` (docs/design/v5-hostd.md §15): whether its
// `needs` hold here (ready, or the reason), the hash of what makes its results differ between hosts
// (`variant`), what the host's owner allows (`accept`, `concurrency` in `host.toml`, which Core
// cannot change), and the load its health answer reports.

import { createHash } from "node:crypto";
import {
  closeSync,
  type Dirent,
  existsSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import type {
  HostServiceConfig,
  HostServiceLoad,
  HostServiceRouting,
} from "@miyoria/contracts/host";
import type { CatalogEntry } from "./catalog.js";

/** What a `[routing]` path means on this host. */
export interface RoutingPaths {
  /** The checkout holding the catalog: paths are relative to it (as `install.manual`). */
  root: string;
  workspace: string;
  state: string;
  models: string;
}

/** Bytes read from each end of a file for its fingerprint. */
const SAMPLE_BYTES = 1024 * 1024;
/** Files of a folder that are fingerprinted one by one; beyond that only their names and sizes. */
const MAX_SAMPLED_FILES = 64;
/** Files of a folder looked at at all. */
const MAX_LISTED_FILES = 4096;

/** A `[routing]` path on this host, as `install.manual` paths are resolved. */
export function routingPath(
  entry: CatalogEntry,
  override: HostServiceConfig,
  paths: RoutingPaths,
  path: string,
): string {
  const voice =
    override.env.TTS_DEFAULT_VOICE ??
    entry.descriptor.run?.env.TTS_DEFAULT_VOICE ??
    "deepseek-chan";
  const text = path
    .replaceAll("{voice}", voice)
    .replaceAll("{state}", paths.state)
    .replaceAll("{models}", paths.models)
    .replaceAll("{workspace}", paths.workspace)
    .replaceAll("{service}", entry.dir);
  return resolve(paths.root, text);
}

/** Every file below `dir`, relative and with `/`, sorted; at most `MAX_LISTED_FILES`. */
function filesBelow(dir: string): string[] {
  const out: string[] = [];
  const walk = (folder: string) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (out.length >= MAX_LISTED_FILES) return;
      const full = join(folder, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) out.push(relative(dir, full).replaceAll("\\", "/"));
    }
  };
  walk(dir);
  return out;
}

/**
 * The variant hashes, with a cache of each file's sample by its size and modification time: a
 * model of a few GB is read once (its first and last MiB), not on every report.
 */
export class VariantHasher {
  readonly #samples = new Map<string, { key: string; hash: string }>();

  /** A short hash of the env values and the files; the same on two hosts with the same model. */
  hash(
    env: ReadonlyArray<readonly [string, string | undefined]>,
    files: readonly string[],
  ): string {
    const lines: string[] = [];
    for (const [name, value] of env) lines.push(`env ${name}=${value ?? ""}`);
    files.forEach((file, i) => {
      lines.push(...this.#describe(`#${i}`, file));
    });
    return createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 16);
  }

  #describe(label: string, path: string): string[] {
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(path);
    } catch {
      return [`${label} missing`];
    }
    if (stat.isFile()) return [`${label} ${this.#sample(path, stat.size, stat.mtimeMs)}`];
    if (!stat.isDirectory()) return [`${label} other`];
    const files = filesBelow(path);
    return files.map((name, i) => {
      const full = join(path, name);
      let size = -1;
      let mtime = 0;
      try {
        const s = statSync(full);
        size = s.size;
        mtime = s.mtimeMs;
      } catch {
        return `${label}/${name} missing`;
      }
      return i < MAX_SAMPLED_FILES
        ? `${label}/${name} ${this.#sample(full, size, mtime)}`
        : `${label}/${name} ${size}`;
    });
  }

  /** `<size>:<sha256 of the first and last MiB>`; cached by size and modification time. */
  #sample(file: string, size: number, mtime: number): string {
    const key = `${size}:${mtime}`;
    const cached = this.#samples.get(file);
    if (cached?.key === key) return cached.hash;
    const hash = createHash("sha256");
    let fd: number | null = null;
    try {
      fd = openSync(file, "r");
      const head = Buffer.alloc(Math.min(SAMPLE_BYTES, size));
      readSync(fd, head, 0, head.length, 0);
      hash.update(head);
      if (size > SAMPLE_BYTES) {
        const tail = Buffer.alloc(Math.min(SAMPLE_BYTES, size - SAMPLE_BYTES));
        readSync(fd, tail, 0, tail.length, size - tail.length);
        hash.update(tail);
      }
    } catch {
      return `${size}:unreadable`;
    } finally {
      if (fd !== null) closeSync(fd);
    }
    const value = `${size}:${hash.digest("hex").slice(0, 16)}`;
    this.#samples.set(file, { key, hash: value });
    return value;
  }
}

/** What evaluating a service's routing needs from the daemon. */
export interface RoutingContext {
  paths: RoutingPaths;
  /** The service's environment value of a name: `host.toml` env, then the descriptor's, then the daemon's. */
  env(name: string): string | undefined;
  /** The card's total memory in MB; `null` when it cannot be read. */
  gpuTotalMb(): number | null;
  hasher: VariantHasher;
}

/** One decimal, as people read GB. */
function gb(mb: number): string {
  return (mb / 1024).toFixed(1);
}

/** `[routing]` of a service as it applies on this host; `undefined` without the table. */
export function serviceRouting(
  entry: CatalogEntry | null,
  override: HostServiceConfig,
  ctx: RoutingContext,
): HostServiceRouting | undefined {
  const routing = entry?.descriptor.routing;
  if (entry === null || routing === undefined) return undefined;
  const reasons: string[] = [];
  for (const file of routing.needs.files) {
    if (!existsSync(routingPath(entry, override, ctx.paths, file))) reasons.push(`缺少 ${file}`);
  }
  const vram = routing.needs.vram_gb;
  if (vram !== undefined) {
    // A card not read (yet) does not hold the service back: before the first reading, or on a
    // machine whose card cannot be read, the worker itself still falls back as it always did.
    const total = ctx.gpuTotalMb();
    if (total !== null && total / 1024 < vram) {
      reasons.push(`顯卡只有 ${gb(total)} GB,需要 ${vram} GB`);
    }
  }
  const owner = override.concurrency;
  const variant = routing.variant;
  return {
    class: routing.class,
    latency: routing.latency,
    concurrency: owner === undefined ? routing.concurrency : Math.min(owner, routing.concurrency),
    queue: routing.queue,
    yields_to: routing.yields_to,
    ready: reasons.length === 0,
    ...(reasons.length > 0 ? { reason: reasons.join(";") } : {}),
    ...(variant !== undefined
      ? {
          variant: ctx.hasher.hash(
            variant.env.map((name) => [name, ctx.env(name)] as const),
            variant.files.map((file) => routingPath(entry, override, ctx.paths, file)),
          ),
        }
      : {}),
    accept: override.accept !== false,
    ...(owner !== undefined ? { owner_concurrency: owner } : {}),
    ...(routing.unit_s !== undefined ? { unit_s: routing.unit_s } : {}),
    ...(routing.result_mb !== undefined ? { result_mb: routing.result_mb } : {}),
  };
}

/** A load reading: what the health answer said and when (epoch ms of this machine). */
export interface LoadReading {
  running: number;
  queued: number;
  at: number;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

/**
 * The load in a health answer: `running` (or `busy: true` for one unit) and `queued`. `null` when
 * it says neither, as a worker that does not report its load.
 */
export function loadOf(body: unknown): { running: number; queued: number } | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const b = body as { running?: unknown; busy?: unknown; queued?: unknown };
  const running = count(b.running) ?? (typeof b.busy === "boolean" ? (b.busy ? 1 : 0) : null);
  const queued = count(b.queued);
  if (running === null && queued === null) return null;
  return { running: running ?? 0, queued: queued ?? 0 };
}

/** The reading as the report carries it. */
export function loadStatus(
  reading: LoadReading,
  now: number,
  outside: string | undefined,
): HostServiceLoad {
  return {
    running: reading.running,
    queued: reading.queued,
    age_ms: Math.max(0, now - reading.at),
    ...(outside !== undefined ? { outside } : {}),
  };
}
