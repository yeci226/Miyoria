// The plan the old launcher computed from `[stack]` and `[machine]`: what ran where, with which
// command, folder and environment. The launcher is gone (hostd runs the services from their
// `service.toml`); the plan stays for `host migrate` and the pin test of the descriptors
// (`test/descriptors.test.ts`), and goes with `[stack]` and `[machine]` (docs/design/v5-hostd.md §12).

import { dirname, join, resolve } from "node:path";
import { workerBaseEnv } from "@miyoria/hostd";
import type { Config } from "@miyoria/runtime/kernel";
import { isJsonObject } from "@miyoria/types";
import { offloadUrls, parseBind, pythonPath, type Stack, startOrder, workerUrl } from "./config.js";
import { isLoopback } from "./roles.js";

export class PlanError extends Error {
  override readonly name = "PlanError";
}

export interface ServiceSpec {
  /** `core`, `voice-node`, `stage` or the worker's name. */
  name: string;
  kind: "worker" | "core" | "voice-node" | "stage";
  command: string;
  args: string[];
  cwd: string;
  /** The child's whole environment. */
  env: Record<string, string | undefined>;
  logFile: string;
  /** Answers 200 when ready; without one the service counts as up after a while. */
  health: string | null;
  /** Where to reach it, for the summary. */
  url: string | null;
  timeoutMs: number;
  /** Environment variable names set for this service (never values). */
  envKeys: string[];
  port: number | null;
  host: string;
}

export interface PlanInput {
  config: Config;
  configPath: string;
  stack: Stack;
  root: string | null;
  nodeExec?: { execPath: string; execArgv: string[]; script: string };
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
}

/** `[modules.api] bind` as host, port and base URL; `null` when the API is off. */
export function apiHealth(config: Config): { url: string; host: string; port: number } | null {
  const section = config.module("api");
  if (!section.enabled) return null;
  const bind =
    isJsonObject(section.config) && typeof section.config.bind === "string"
      ? section.config.bind
      : "127.0.0.1:7878";
  const parsed = parseBind(bind);
  if (!parsed) return null;
  const host = parsed.host === "0.0.0.0" ? "127.0.0.1" : parsed.host;
  return { url: `http://${host}:${parsed.port}`, host: parsed.host, port: parsed.port };
}

/** `[stage] overlay_bind`. */
export function stageOverlayBind(config: Config): string {
  const stage = config.section("stage");
  return isJsonObject(stage) && typeof stage.overlay_bind === "string"
    ? stage.overlay_bind
    : "127.0.0.1:7884";
}

/** Core's Voice Link address for the voice node, only when `[machine.hosts]` puts core elsewhere. */
export function voiceLinkUrl(config: Config, stack: Stack): string | null {
  const host = stack.machine?.hosts.core;
  if (host === undefined || isLoopback(host)) return null;
  const modules = config.section("modules");
  const link = isJsonObject(modules) ? modules["voice.link"] : undefined;
  const bind = isJsonObject(link) && typeof link.bind === "string" ? link.bind : "127.0.0.1:7879";
  const port = parseBind(bind)?.port ?? 7879;
  return `ws://${host}:${port}/voice-link`;
}

/** What the old launcher started, in order. No side effects. */
export function buildPlan(input: PlanInput): ServiceSpec[] {
  const { config, configPath, stack, root } = input;
  const platform = input.platform ?? process.platform;
  const env = input.env ?? process.env;
  const logs = join(dirname(resolve(configPath)), "data", "stack", "logs");
  const exec = input.nodeExec ?? {
    execPath: process.execPath,
    execArgv: process.execArgv,
    script: process.argv[1] ?? "",
  };
  const specs: ServiceSpec[] = [];

  if (stack.workers.length > 0 && root === null) {
    throw new PlanError(
      "[stack.workers] 要在 Miyoria 的原始碼資料夾裡用(找不到 workers/ 和 pnpm-workspace.yaml)",
    );
  }
  for (const w of startOrder(stack.workers)) {
    const workerEnv: Record<string, string> = {
      ...workerBaseEnv(env),
      HOST: w.host,
      PORT: String(w.port),
    };
    const urls = offloadUrls(w, stack.workers);
    if (urls !== "") workerEnv.SING_OFFLOAD_URLS = urls;
    const base = root as string;
    // The voices folder is relative to the repo, not to wherever the worker's working directory is.
    if (w.name === "tts" && stack.machine !== null) {
      workerEnv.VOICES_DIR = join(base, "workers", "voices");
    }
    Object.assign(workerEnv, w.env);
    specs.push({
      name: w.name,
      kind: "worker",
      command: pythonPath(join(base, w.venv), platform),
      args: [w.entry],
      cwd: join(base, "workers", w.dir),
      env: workerEnv,
      logFile: join(logs, `${w.name}.log`),
      health: `${workerUrl(w)}/health`,
      url: workerUrl(w),
      timeoutMs: (w.startTimeoutSecs ?? stack.startTimeoutSecs) * 1000,
      envKeys: Object.keys(workerEnv).filter(
        (k) =>
          k in w.env ||
          k === "SING_OFFLOAD_URLS" ||
          k === "PORT" ||
          k === "VOICES_DIR" ||
          k === "HOST",
      ),
      port: w.port,
      host: w.host,
    });
  }

  const self = (sub: string) => ({
    command: exec.execPath,
    args: [...exec.execArgv, exec.script, sub, "-c", configPath],
  });
  if (stack.core) {
    const api = apiHealth(config);
    specs.push({
      name: "core",
      kind: "core",
      ...self("core"),
      cwd: dirname(resolve(configPath)),
      env: { ...env },
      logFile: join(logs, "core.log"),
      health: api ? `${api.url}/api/health` : null,
      url: api ? `${api.url}/` : null,
      timeoutMs: stack.startTimeoutSecs * 1000,
      envKeys: [],
      port: api?.port ?? null,
      host: api?.host ?? "127.0.0.1",
    });
  }
  if (stack.voiceNode) {
    if (root === null) throw new PlanError("voice node 要在原始碼資料夾裡用(apps/voice-node)");
    // The node reads VOICE_LINK_URL from its own environment; when core is on another computer
    // the address comes from `[machine.hosts]` (the node's .env still holds the token).
    const link = voiceLinkUrl(config, stack);
    specs.push({
      name: "voice-node",
      kind: "voice-node",
      command: "pnpm",
      args: ["start"],
      cwd: join(root, "apps", "voice-node"),
      env: link ? { ...env, VOICE_LINK_URL: link } : { ...env },
      logFile: join(logs, "voice-node.log"),
      health: null,
      url: null,
      timeoutMs: stack.startTimeoutSecs * 1000,
      envKeys: link ? ["VOICE_LINK_URL"] : [],
      port: null,
      host: "127.0.0.1",
    });
  }
  if (stack.stage) {
    const overlay = parseBind(stageOverlayBind(config)) ?? { host: "127.0.0.1", port: 7884 };
    specs.push({
      name: "stage",
      kind: "stage",
      ...self("stage"),
      cwd: dirname(resolve(configPath)),
      env: { ...env },
      logFile: join(logs, "stage.log"),
      health: null,
      url: `http://${overlay.host === "0.0.0.0" ? "127.0.0.1" : overlay.host}:${overlay.port}/overlay/`,
      timeoutMs: stack.startTimeoutSecs * 1000,
      envKeys: [],
      port: overlay.port,
      host: overlay.host,
    });
  }
  return specs;
}
