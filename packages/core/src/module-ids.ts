// Module ids the core knows about, in boot order (legacy `boot.rs` `MODULES`). Kept free of
// imports so the CLI can list configured modules without loading any module package.

import type { Config } from "@miyoria/kernel";

/** Every module the core knows about, for `miyoria module list`. */
export const MODULE_IDS: readonly string[] = [
  "facts",
  "moderation",
  "llm",
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
  "social",
  "mood",
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
  "share",
  "watch",
  "mcp",
  "stage.link",
  "web",
  "sandbox",
  "imagegen",
  "skills",
  "live",
  "party",
  "extensions",
  "platform.discord.bot",
  "recorder",
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
 * Modules that are off unless their section says `enabled = true` (a missing section or a
 * missing `enabled` key means disabled): high-risk ones, and ones that need a server of their own
 * (`imagegen` needs ComfyUI).
 */
export const OPT_IN_MODULES: readonly string[] = ["sandbox", "share", "watch", "imagegen"];

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
