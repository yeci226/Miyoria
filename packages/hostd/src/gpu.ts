// Reading the graphics card: one reader for `host.info` and for the GPU arbiter (§8 of
// docs/design/v5-hostd.md, docs/design/v5-gpu.md §3.3). It must agree with what the Python workers
// read (`workers/device_memory.py`): the same card (the first of `CUDA_VISIBLE_DEVICES` when that
// is a number, else 0) and the same "free" (the device's own number, every process counted).
//
// Two ways behind one interface:
// - NVML through `koffi` (`nvml.dll` on Windows, also from `NVIDIA Corporation\NVSMI`;
//   `libnvidia-ml.so.1` on Linux): the calls device_memory.py makes. Loaded on the first read;
//   a missing library, driver or `koffi` itself only means this way is not there.
// - `nvidia-smi` when NVML cannot be loaded.
//
// Measured on the owner's RTX 4070 SUPER (Windows, 2026-11-16, 500 and 100 reads): NVML 0.004 ms
// a read (p99 0.03 ms), `nvidia-smi` 59 ms (p95 63 ms). The arbiter reads before decisions and at
// most once a second while a stage runs, so NVML needs no cache; concurrent `nvidia-smi` reads
// share one run and are not cached beyond it.
//
// NVML's `used` counts the memory the driver reserves; `nvidia-smi`'s `memory.used` does not
// (10722 against 10438 MB on that card at the same moment), while both `free` agree to the MB.
// So "free" is always the device's free, and "used" is `total − free` for `nvidia-smi`.

import { execa } from "execa";

/** One reading of the card. */
export interface GpuSample {
  name: string;
  total_mb: number;
  used_mb: number;
  /** Free on the device; older readers left it out (then `total − used`). */
  free_mb?: number;
}

/** Reads the card; `null` when it cannot be read (no card, no driver, a failed read). */
export type GpuReader = () => Promise<GpuSample | null>;

/** What the GPU arbiter asks for: the whole device, other processes included. */
export interface DeviceReading {
  cuda: boolean;
  total_mb: number | null;
  free_mb: number | null;
  name: string;
}

const MB = 2 ** 20;

/** The card CUDA calls device 0: the first of `CUDA_VISIBLE_DEVICES` when that is a number. */
export function cudaIndex(env: Readonly<Record<string, string | undefined>>): number {
  const first = (env.CUDA_VISIBLE_DEVICES ?? "").split(",")[0]?.trim() ?? "";
  return /^\d+$/.test(first) ? Number(first) : 0;
}

/** Free memory of a sample: the device's own number when the reader had it. */
export function freeOf(sample: GpuSample): number {
  return sample.free_mb ?? sample.total_mb - sample.used_mb;
}

/**
 * `nvidia-smi --query-gpu=index,name,memory.total,memory.used,memory.free
 * --format=csv,noheader,nounits`: the line of card `index`. A name may hold commas.
 */
export function parseNvidiaSmi(text: string, index = 0): GpuSample | null {
  for (const line of text.split(/\r?\n/)) {
    // nvidia-smi separates the fields with ", ".
    const parts = line.split(", ").map((p) => p.trim());
    if (parts.length < 5) continue;
    const at = Number(parts[0]);
    const total = Number(parts[parts.length - 3]);
    const free = Number(parts[parts.length - 1]);
    const name = parts.slice(1, -3).join(", ");
    if (!Number.isInteger(at) || at !== index) continue;
    if (!Number.isFinite(total) || !Number.isFinite(free) || name === "") return null;
    return { name, total_mb: total, used_mb: total - free, free_mb: free };
  }
  return null;
}

/** What `nvmlDeviceGetMemoryInfo` and `nvmlDeviceGetName` filled in. */
export interface NvmlRaw {
  total: number | bigint;
  free: number | bigint;
  used: number | bigint;
  /** The name buffer, NUL-terminated. */
  name: Uint8Array;
}

/** A sample from NVML's numbers, in whole MB as device_memory.py counts them (`bytes // MB`). */
export function fromNvml(raw: NvmlRaw): GpuSample {
  const mb = (v: number | bigint) => Math.floor(Number(v) / MB);
  const end = raw.name.indexOf(0);
  const name = Buffer.from(raw.name.subarray(0, end < 0 ? raw.name.length : end)).toString("utf8");
  return { name, total_mb: mb(raw.total), used_mb: mb(raw.used), free_mb: mb(raw.free) };
}

/** The NVML calls a read needs; one per process. */
export interface NvmlBinding {
  /** NVML's numbers of card `index`; `null` when NVML says no. */
  read(index: number): NvmlRaw | null;
  close(): void;
}

/** Where NVML may be, in the order device_memory.py tries them. */
export function nvmlLibraries(
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  if (platform !== "win32") return ["libnvidia-ml.so.1"];
  const programFiles = env.ProgramFiles ?? env.PROGRAMFILES ?? "C:\\Program Files";
  return ["nvml.dll", `${programFiles}\\NVIDIA Corporation\\NVSMI\\nvml.dll`];
}

/**
 * Loads NVML through `koffi` and initialises it; `null` when `koffi`, the library or the driver
 * is missing. Only read-only queries: init, a device handle, its memory and its name, shutdown.
 */
export async function loadNvml(libraries: readonly string[]): Promise<NvmlBinding | null> {
  let koffi: typeof import("koffi").default;
  try {
    koffi = (await import("koffi")).default;
  } catch {
    return null;
  }
  for (const file of libraries) {
    try {
      const lib = koffi.load(file);
      const device = koffi.pointer(koffi.opaque());
      const memory = koffi.struct({ total: "uint64_t", free: "uint64_t", used: "uint64_t" });
      const init = lib.func("nvmlInit_v2", "int", []);
      const shutdown = lib.func("nvmlShutdown", "int", []);
      const handleOf = lib.func("nvmlDeviceGetHandleByIndex_v2", "int", [
        "uint",
        koffi.out(koffi.pointer(device)),
      ]);
      const memoryOf = lib.func("nvmlDeviceGetMemoryInfo", "int", [
        device,
        koffi.out(koffi.pointer(memory)),
      ]);
      const nameOf = lib.func("nvmlDeviceGetName", "int", [device, "uint8_t *", "uint"]);
      if (init() !== 0) {
        lib.unload();
        continue;
      }
      let open = true;
      return {
        read(index) {
          if (!open) return null;
          const handle: unknown[] = [null];
          if (handleOf(index, handle) !== 0) return null;
          const mem: { total?: number | bigint; free?: number | bigint; used?: number | bigint } =
            {};
          if (memoryOf(handle[0], mem) !== 0) return null;
          const name = new Uint8Array(96);
          nameOf(handle[0], name, name.length);
          return { total: mem.total ?? 0, free: mem.free ?? 0, used: mem.used ?? 0, name };
        },
        close() {
          if (!open) return;
          open = false;
          shutdown();
        },
      };
    } catch {
      // not this file; the next one, or no NVML
    }
  }
  return null;
}

/** Reads card `index` with `nvidia-smi`; `null` when the program is missing or fails. */
export function nvidiaSmiReader(index = 0): GpuReader {
  let running: Promise<GpuSample | null> | null = null;
  return () => {
    running ??= execa(
      "nvidia-smi",
      [
        "--query-gpu=index,name,memory.total,memory.used,memory.free",
        "--format=csv,noheader,nounits",
      ],
      { reject: false, timeout: 5000, windowsHide: true, stdin: "ignore" },
    )
      .then((result) =>
        result.failed || typeof result.stdout !== "string"
          ? null
          : parseNvidiaSmi(result.stdout, index),
      )
      .catch(() => null)
      .finally(() => {
        running = null;
      });
    return running;
  };
}

export interface CardReaderOptions {
  /** Which card: device_memory.py's choice from `CUDA_VISIBLE_DEVICES`. */
  index?: number;
  platform?: NodeJS.Platform;
  /** Where `ProgramFiles` is read (Windows). */
  env?: Readonly<Record<string, string | undefined>>;
  /** Loads NVML (tests replace it); `null` means there is none. */
  nvml?: () => Promise<NvmlBinding | null>;
  /** The fallback (tests replace it). */
  smi?: GpuReader;
}

/**
 * The card reader: NVML when it loads (tried once, at the first read), else `nvidia-smi`. `kind`
 * says which one is in use after the first read.
 */
export class CardReader {
  readonly #index: number;
  readonly #nvmlLoad: () => Promise<NvmlBinding | null>;
  readonly #smi: GpuReader;
  #nvml: Promise<NvmlBinding | null> | null = null;
  #kind: "nvml" | "nvidia-smi" | null = null;

  constructor(options: CardReaderOptions = {}) {
    const platform = options.platform ?? process.platform;
    const env = options.env ?? process.env;
    this.#index = options.index ?? 0;
    this.#nvmlLoad = options.nvml ?? (() => loadNvml(nvmlLibraries(platform, env)));
    this.#smi = options.smi ?? nvidiaSmiReader(this.#index);
  }

  /** `nvml` or `nvidia-smi`; `null` before the first read. */
  get kind(): "nvml" | "nvidia-smi" | null {
    return this.#kind;
  }

  readonly read: GpuReader = async () => {
    this.#nvml ??= this.#nvmlLoad().catch(() => null);
    const nvml = await this.#nvml;
    if (nvml === null) {
      this.#kind = "nvidia-smi";
      return this.#smi();
    }
    this.#kind = "nvml";
    try {
      const raw = nvml.read(this.#index);
      return raw === null ? null : fromNvml(raw);
    } catch {
      return null;
    }
  };

  /** Shuts NVML down (the daemon is closing). */
  async close(): Promise<void> {
    const nvml = this.#nvml === null ? null : await this.#nvml;
    nvml?.close();
  }
}

/** The arbiter's reading from a reader: throws when the card cannot be read. */
export function deviceReader(read: GpuReader): () => Promise<DeviceReading> {
  return async () => {
    const sample = await read();
    if (sample === null) throw new Error("the graphics card cannot be read");
    return { cuda: true, total_mb: sample.total_mb, free_mb: freeOf(sample), name: sample.name };
  };
}

/** Keeps one reading for `ttlMs`; concurrent reads share one call. */
export class GpuCache {
  readonly #read: GpuReader;
  readonly #ttlMs: number;
  #value: GpuSample | null = null;
  #at = Number.NEGATIVE_INFINITY;
  #pending: Promise<GpuSample | null> | null = null;

  constructor(read: GpuReader, ttlMs = 5000) {
    this.#read = read;
    this.#ttlMs = ttlMs;
  }

  /** The last reading, without waiting. */
  get last(): GpuSample | null {
    return this.#value;
  }

  get stale(): boolean {
    return Date.now() - this.#at > this.#ttlMs;
  }

  async read(): Promise<GpuSample | null> {
    if (!this.stale) return this.#value;
    if (this.#pending === null) {
      this.#pending = this.#read()
        .catch(() => null)
        .then((value) => {
          this.#value = value;
          this.#at = Date.now();
          this.#pending = null;
          return value;
        });
    }
    return this.#pending;
  }
}
