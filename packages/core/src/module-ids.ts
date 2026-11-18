// Module ids the core knows about, in boot order. Kept free of
// imports so the CLI can list configured modules without loading any module package.

import type { Config } from "@miyoria/runtime/kernel";

/** Every module the core knows about, for `miyoria module list`. */
export const MODULE_IDS: readonly string[] = [
  "facts",
  "moderation",
  "llm",
  "cluster",
  "speech",
  "voice.link",
  "voice",
  "scheduler",
  "agent",
  "commands",
  "auth",
  "actions",
  "directive",
  "activity",
  "heart",
  "world",
  "self",
  "memory",
  "arbiter",
  "mind",
  "knowledge",
  "conversation",
  "reflect",
  "queue",
  "game",
  "game.chat",
  "sing",
  "watch",
  "mcp",
  "stage.link",
  "economy",
  "cards",
  "market",
  "karaoke",
  "web",
  "sandbox",
  "imagegen",
  "skills",
  "live",
  "party",
  "eval",
  "extensions",
  "platform.discord.bot",
  "replay",
  "api",
];

/** Modules that cannot run without `token` in their section; an empty token disables them. */
export const NEEDS_TOKEN: readonly string[] = [
  "platform.discord.bot",
  "api",
  "voice.link",
  "stage.link",
];

/**
 * Modules that cannot be turned off, in the config file or at runtime, and why: the agent owns her
 * mouth and the arbiter decides when she speaks, so nothing speaks while either is down; the heart
 * is who people are and how she feels about them (`SocialSignalsKey`), which the gate, the queue,
 * her prompt and her feel all read.
 */
export const REQUIRED_MODULE_REASONS: Readonly<Record<string, string>> = {
  agent: "nothing speaks while it is down",
  arbiter: "nothing speaks while it is down",
  heart: "who people are and how she feels about them live there",
};

/** The ids of `REQUIRED_MODULE_REASONS`. */
export const REQUIRED_MODULES: readonly string[] = Object.keys(REQUIRED_MODULE_REASONS);

/**
 * Modules that are off unless their section says `enabled = true` (a missing section or a
 * missing `enabled` key means disabled): high-risk ones, and ones that need a server of their own
 * (`imagegen` needs ComfyUI), and `watch`, which sends pictures of a friend's stream to a vision model.
 */
export const OPT_IN_MODULES: readonly string[] = ["sandbox", "imagegen", "watch"];

/** Whether the config file enables module `id` (`OPT_IN_MODULES` need `enabled = true`). */
export function moduleEnabled(config: Config, id: string): boolean {
  if (!OPT_IN_MODULES.includes(id)) return config.module(id).enabled;
  const modules = config.section("modules");
  if (modules === null || typeof modules !== "object" || Array.isArray(modules)) return false;
  const section = modules[id];
  if (section === null || typeof section !== "object" || Array.isArray(section)) return false;
  return section.enabled === true;
}

/** `(id, enabled)` of every known module as the config file says. */
export function configuredModules(config: Config): Array<[string, boolean]> {
  return MODULE_IDS.map((id) => [id, moduleEnabled(config, id)]);
}
