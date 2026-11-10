// Machine roles: which services one computer runs. This file is the single place that names the
// roles and the services in them; rename a role here (and in the docs) and nothing else changes.
//
// `[machine]` in miyoria.toml picks the roles (or lists services by hand) for THIS computer:
//
//   [machine]
//   roles = ["core"]                  # broadcast | core | inference; several = one PC doing both
//   # services = ["core", "asr"]      # hand-picked services; replaces `roles` when given
//   [machine.hosts]
//   core = "127.0.0.1"                # address of the computer running core, as the others see it
//   inference = "127.0.0.1"           # address of the computer running asr / tts / sing

import type { Config } from "@miyoria/kernel";
import { isJsonObject } from "@miyoria/types";
import { z } from "zod";

export interface RoleInfo {
  /** Short label for prompts and docs. */
  label: string;
  /** Services in start order. */
  services: readonly string[];
  help: string;
}

export const ROLES = {
  broadcast: {
    label: "直播機",
    services: ["voice-node", "stage"],
    help: "串流用電腦:Discord 語音 + Go Live(voice node)、VTube Studio / OBS / overlay(stage)",
  },
  core: {
    label: "Bot 服務機",
    services: ["core", "turn"],
    help: "Discord bot、所有模組、資料庫、管理面板(core),判斷講完的 worker(turn),檔案沙箱用的 Docker",
  },
  inference: {
    label: "GPU 推論機",
    services: ["asr", "tts", "sing"],
    help: "全部 AI 模型:語音辨識(asr)、語音合成(tts)、唱歌(sing);三個要在同一台",
  },
} as const satisfies Record<string, RoleInfo>;

export type Role = keyof typeof ROLES;
export const ROLE_NAMES = Object.keys(ROLES) as Role[];

/** Every service, in the order `start` brings them up (models first, then core, then broadcast). */
export const SERVICE_ORDER = ["asr", "tts", "sing", "turn", "core", "voice-node", "stage"] as const;
export type ServiceName = (typeof SERVICE_ORDER)[number];

export const WORKER_SERVICES: readonly string[] = ["asr", "tts", "sing", "turn"];

export function isRole(name: string): name is Role {
  return (ROLE_NAMES as string[]).includes(name);
}

export function isService(name: string): name is ServiceName {
  return (SERVICE_ORDER as readonly string[]).includes(name);
}

export function roleOf(service: string): Role | null {
  for (const r of ROLE_NAMES)
    if ((ROLES[r].services as readonly string[]).includes(service)) return r;
  return null;
}

/** Services of the given roles, deduplicated and in start order. */
export function servicesOfRoles(roles: readonly Role[]): ServiceName[] {
  const set = new Set<string>(roles.flatMap((r) => ROLES[r].services));
  return SERVICE_ORDER.filter((s) => set.has(s));
}

export const ALL_SERVICES: readonly ServiceName[] = [...SERVICE_ORDER];

/**
 * Turns words from the command line (`core`, `inference,broadcast`, `all`, `asr`) into services.
 * Throws on a word that is neither a role, `all` nor a service.
 */
export function expandTargets(words: readonly string[]): ServiceName[] {
  const set = new Set<string>();
  for (const raw of words.flatMap((w) => w.split(","))) {
    const w = raw.trim();
    if (w === "") continue;
    if (w === "all") for (const s of SERVICE_ORDER) set.add(s);
    else if (isRole(w)) for (const s of ROLES[w].services) set.add(s);
    else if (isService(w)) set.add(w);
    else {
      throw new Error(
        `不認得 \`${w}\`;角色:${ROLE_NAMES.join("、")}(或 all);服務:${SERVICE_ORDER.join("、")}`,
      );
    }
  }
  return SERVICE_ORDER.filter((s) => set.has(s));
}

// ---- [machine] ---------------------------------------------------------------------------

export const LOOPBACK = "127.0.0.1";

const MachineSchema = z
  .object({
    roles: z.array(z.enum(ROLE_NAMES as [Role, ...Role[]])).default([]),
    /** Hand-picked services; when present it replaces `roles`. */
    services: z.array(z.enum(SERVICE_ORDER)).optional(),
    hosts: z
      .object({
        core: z.string().trim().min(1).default(LOOPBACK),
        inference: z.string().trim().min(1).default(LOOPBACK),
      })
      .strict()
      .prefault({}),
  })
  .strict();

export interface Machine {
  roles: Role[];
  /** The services this computer runs, in start order. */
  services: ServiceName[];
  hosts: { core: string; inference: string };
  /** `services` was written by hand instead of coming from `roles`. */
  custom: boolean;
}

/** `[machine]`, or `null` when the section is missing (old configs keep the `[stack]` behavior). */
export function machineConfig(config: Config): Machine | null {
  const section = config.section("machine");
  if (!isJsonObject(section)) return null;
  const raw = MachineSchema.parse(section);
  const custom = raw.services !== undefined;
  // The end-of-turn worker is only worth running when the voice module is set to use it.
  const services = custom
    ? SERVICE_ORDER.filter((s) => (raw.services as string[]).includes(s))
    : servicesOfRoles(raw.roles).filter((s) => s !== "turn" || turnWanted(config));
  return { roles: raw.roles, services, hosts: raw.hosts, custom };
}

/** `[modules.voice]` uses Smart Turn or Silero, so `workers/turn` is needed. */
export function turnWanted(config: Config): boolean {
  const voice = config.module("voice").config;
  return (
    isJsonObject(voice) && (voice.turn_engine === "smart-turn" || voice.vad_engine === "silero")
  );
}

export function isLoopback(host: string): boolean {
  return host === "localhost" || host === "::1" || host.startsWith("127.");
}

/** Roles whose services are all present in `services` (a custom pick can fill several). */
export function rolesCovered(services: readonly string[]): Role[] {
  return ROLE_NAMES.filter((r) => ROLES[r].services.every((s) => services.includes(s)));
}

/** Compact description for summaries: `core(Bot 服務機)`, or the service list for a custom pick. */
export function describeMachine(m: Machine): string {
  if (m.custom) return `自訂:${m.services.join("、")}`;
  if (m.roles.length === 0) return "(沒有選角色)";
  return m.roles.map((r) => `${r}(${ROLES[r].label})`).join(" + ");
}
