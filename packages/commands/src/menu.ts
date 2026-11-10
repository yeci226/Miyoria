// Context menu entries ("right click a message / a person"), declared like commands.
//
// A menu entry is a command that takes its one argument from what was clicked, so it runs through
// the registry's `dispatch` like every other command: permission node, argument checks, audit
// log, visibility. Its path is `["menu", id]`, kept apart from the slash tree (`specs()` and
// `slashSpecs()` never list it); a platform without context menus simply never calls it.
//
// Arguments the platform fills in:
//
// - message menus: `target` the id of the message, `author` the id of its author (when known).
//   The channel is the invocation's context.
// - user menus: `target` the person (a `user` argument; `resolved_users` carries their roles).

import { ArgKind, type ArgSpec, argSpec, type CommandSpec } from "./spec.js";

/** The first word of every menu command path. */
export const MENU_ROOT = "menu";

/** Discord allows five message and five user context commands per application. */
export const MAX_MENUS_PER_TARGET = 5;

export type MenuTarget = "message" | "user";

export interface MenuSpec {
  /** Lowercase, letters, digits, `-` and `_`: the second word of the path. */
  id: string;
  /** What the menu shows (1 to 32 characters; any case, spaces allowed). */
  name: string;
  target: MenuTarget;
  /** Permission node; `""` = everyone. */
  permission: string;
  /** Only the person who clicked sees the answer. */
  ephemeral: boolean;
}

/** The menu's arguments, as the platform passes them. */
export function menuArgs(target: MenuTarget): ArgSpec[] {
  return target === "message"
    ? [
        argSpec("target", "the message", ArgKind.string),
        argSpec("author", "who wrote it", ArgKind.string, { required: false }),
      ]
    : [argSpec("target", "the person", ArgKind.user)];
}

/** The command behind a menu entry. */
export function menuCommandSpec(menu: MenuSpec): CommandSpec {
  return {
    path: [MENU_ROOT, menu.id],
    description: menu.name,
    args: menuArgs(menu.target),
    permission: menu.permission,
    ephemeral: menu.ephemeral,
  };
}
