// `[stack]` in miyoria.toml: what `miyoria up` starts and what `doctor --deep` checks. Every key is
// optional; without the section `up` starts the core only, like `miyoria core`.

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Config } from "@miyoria/kernel";
import { z } from "zod";
import {
  isLoopback,
  type Machine,
  machineConfig,
  type ServiceName,
  WORKER_SERVICES,
} from "./roles.js";

/**
 * Ports the bundled workers listen on when `port` is not given. `turn` (end-of-turn: Smart Turn
 * and Silero on the CPU) is optional: it needs model files that are not downloaded for you.
 */
export const WORKER_DEFAULT_PORT: Record<string, number> = {
  asr: 8003,
  tts: 8002,
  sing: 8005,
  turn: 8006,
};

export const WORKER_PORTS = WORKER_DEFAULT_PORT;

/** Ports of a `[stack.workers]` entry without `port` in a config that has no `[machine]`. */
const LEGACY_PORT: Record<string, number> = { ...WORKER_DEFAULT_PORT, asr: 8001 };

/**
 * What a worker runs with when `[machine]` picks it and `[stack.workers.<name>]` says nothing
 * (the setup that was verified on the 12 GB card: Qwen3-ASR 0.6B, faster-qwen3-tts, the sing worker
 * handing the GPU over from tts and asr). `[stack.workers.<name>]` overrides field by field; its
 * `env` is merged on top. `VOICES_DIR` is filled in when the plan is built (it needs the repo root).
 */
export interface WorkerDefault {
  venv: string;
  env: Record<string, string>;
  offload: string[];
}

export const WORKER_DEFAULTS: Record<string, WorkerDefault> = {
  asr: {
    venv: "workers/.venv-asr-qwen",
    env: { ASR_BACKEND: "qwen3", ASR_QWEN_SIZE: "0.6B" },
    offload: [],
  },
  tts: {
    venv: "workers/.venv-tts-faster",
    env: { TTS_DEFAULT_VOICE: "deepseek-chan" },
    offload: [],
  },
  sing: { venv: "workers/.venv-sing", env: {}, offload: ["tts", "asr"] },
  turn: { venv: "workers/.venv-turn", env: {}, offload: [] },
};

const WorkerSchema = z
  .object({
    /** Virtualenv folder, relative to the repo root (default `workers/.venv-<name>`). */
    venv: z.string().optional(),
    port: z.number().int().min(1).max(65535).optional(),
    /** Address to listen on (default: loopback; the inference machine's address when it serves others). */
    host: z.string().optional(),
    /** Folder under `workers/` holding the server (default: the worker's name). */
    dir: z.string().optional(),
    entry: z.string().default("server.py"),
    env: z.record(z.string(), z.string()).default({}),
    /** Workers that must drop their GPU models while this one runs (`SING_OFFLOAD_URLS`). */
    offload: z.array(z.string()).default([]),
    /** Rough VRAM the worker holds when loaded (MB); overrides the built-in estimate. */
    vram_mb: z.number().int().min(0).optional(),
    start_timeout_secs: z.number().int().min(5).optional(),
  })
  .strict();

const StackSchema = z
  .object({
    core: z.boolean().default(true),
    voice_node: z.boolean().default(false),
    stage: z.boolean().default(false),
    start_timeout_secs: z.number().int().min(5).default(180),
    workers: z.record(z.string(), WorkerSchema).default({}),
  })
  .strict();

export interface Worker {
  name: string;
  venv: string;
  port: number;
  host: string;
  dir: string;
  entry: string;
  /** Keys and values from the config; values are never printed. */
  env: Record<string, string>;
  offload: string[];
  vramMb: number | null;
  startTimeoutSecs: number | null;
}

export interface Stack {
  /** `[machine]`, or `null` for an old config that only has `[stack]`. */
  machine: Machine | null;
  core: boolean;
  voiceNode: boolean;
  stage: boolean;
  startTimeoutSecs: number;
  workers: Worker[];
}

/**
 * The services to run. With `[machine]` they come from its roles (or hand-picked services); an
 * explicit `services` list (the `start` command's targets) replaces that. Without `[machine]` and
 * without a list the old `[stack]` keys decide: core on, voice_node / stage off, workers as written.
 */
export function stackConfig(config: Config, services?: readonly string[]): Stack {
  const raw = config.get("stack", StackSchema);
  const machine = machineConfig(config);
  const selected: readonly string[] | null = services ?? machine?.services ?? null;

  const names =
    selected === null
      ? Object.keys(raw.workers)
      : WORKER_SERVICES.filter((n) => selected.includes(n));
  // A worker's listen address: the inference machine's own address when it serves other computers.
  const serves = machine !== null && !isLoopback(machine.hosts.inference);
  const defaultHost = serves ? machine.hosts.inference : "127.0.0.1";

  const workers = names.map((name): Worker => {
    const w = raw.workers[name];
    const d = WORKER_DEFAULTS[name];
    const port = w?.port ?? (selected === null ? LEGACY_PORT[name] : WORKER_DEFAULT_PORT[name]);
    if (port === undefined) throw new Error(`[stack.workers.${name}] 要設定 port`);
    return {
      name,
      venv: w?.venv ?? (selected === null ? undefined : d?.venv) ?? `workers/.venv-${name}`,
      port,
      host: w?.host ?? (selected === null ? "127.0.0.1" : defaultHost),
      dir: w?.dir ?? name,
      entry: w?.entry ?? "server.py",
      env: { ...(selected === null ? {} : (d?.env ?? {})), ...(w?.env ?? {}) },
      offload:
        w?.offload ??
        (selected === null ? [] : (d?.offload ?? []).filter((n) => names.includes(n))),
      vramMb: w?.vram_mb ?? null,
      startTimeoutSecs: w?.start_timeout_secs ?? null,
    };
  });
  const has = (s: ServiceName) => (selected === null ? null : selected.includes(s));
  return {
    machine,
    core: has("core") ?? raw.core,
    voiceNode: has("voice-node") ?? raw.voice_node,
    stage: has("stage") ?? raw.stage,
    startTimeoutSecs: raw.start_timeout_secs,
    workers,
  };
}

/** Workers in start order: the ones another worker offloads for come first. */
export function startOrder(workers: readonly Worker[]): Worker[] {
  const offloaded = new Set(workers.flatMap((w) => w.offload));
  return [...workers].sort((a, b) => Number(offloaded.has(b.name)) - Number(offloaded.has(a.name)));
}

export function workerUrl(w: Worker): string {
  return `http://${w.host === "0.0.0.0" ? "127.0.0.1" : w.host}:${w.port}`;
}

/** `SING_OFFLOAD_URLS` for a worker: its `offload` targets that exist in the stack. */
export function offloadUrls(w: Worker, workers: readonly Worker[]): string {
  return w.offload
    .map((n) => workers.find((x) => x.name === n))
    .filter((x): x is Worker => x !== undefined)
    .map(workerUrl)
    .join(",");
}

/** The repo checkout holding `workers/`, `apps/` and `extensions/`; `null` for an npm install. */
export function repoRoot(configPath: string): string | null {
  let dir = dirname(resolve(configPath));
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml")) && existsSync(join(dir, "workers"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Host and port of a `host:port` bind string. */
export function parseBind(bind: string): { host: string; port: number } | null {
  const colon = bind.lastIndexOf(":");
  if (colon <= 0) return null;
  const port = Number(bind.slice(colon + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: bind.slice(0, colon), port };
}

export function pythonPath(venv: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? join(venv, "Scripts", "python.exe") : join(venv, "bin", "python");
}
