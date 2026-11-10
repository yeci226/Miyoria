// Built-in roles. Each lists all of its nodes; roles do not inherit from each other.
//
// The grants are defined once, in `@miyoria/commands` (`nodes.ts`), so the fallback permissions
// used without this module mean exactly the same:
//
// | Role | Rank | Grants | Denies |
// |---|---|---|---|
// | owner | 100 | `*` | |
// | admin | 80 | everything below plus `admin.*`, `module.*`, `memory.*`, `stream.*` | |
// | moderator | 60 | trusted plus `voice.*`, `queue.*`, `game.*`, `stream.scene`, ... | `tools.mcp.*` |
// | trusted | 40 | user plus `chat.*`, `tools.*`, `queue.priority`, `game.suggest`, `stream.clip` | `tools.mcp.*` |
// | user | 20 | restricted plus `chat.talk`, `voice.join`, `queue.request`, `tools.web`, `tools.file`, views of settings, ... | |
// | restricted | 10 | `help`, `me.*`, `memory.self.*`, `voice.consent` | |
// | blocked | 0 | nothing | |

import {
  builtinRoleGrants,
  DIRECTIVE_MODERATE,
  FILE_READ,
  SANDBOX_CODE_RUN,
  WEB_TOOL,
} from "@miyoria/commands";
import type { RoleDefinition } from "@miyoria/store";

export const OWNER = "owner";
export const ADMIN = "admin";
export const MODERATOR = "moderator";
export const TRUSTED = "trusted";
export const USER = "user";
export const RESTRICTED = "restricted";
export const BLOCKED = "blocked";

/**
 * Roles at or below this rank are "blocked": an explicit assignment of one beats every other
 * role source except config owners, and such roles may not use commands without a permission
 * node.
 */
export const BLOCKED_RANK = 0;

/**
 * Lets a Discord-logged-in user into the admin panel (`/api/*` reads). `owner` and `admin` have
 * it through `*` / `admin.*`.
 */
export const PANEL_ACCESS = "admin.panel.access";
/** Lets a panel user make changes (every non-`GET` admin API route). */
export const PANEL_WRITE = "admin.panel.write";

/** The seven built-in roles, highest rank first. */
export function builtinRoles(): RoleDefinition[] {
  return builtinRoleGrants().map((r) => ({ ...r, builtin: true }));
}

// ---- upgrades of stored built-in roles -------------------------------------------------------

const V1_PRIVACY = [
  "ping",
  "help.*",
  "me.*",
  "memory.self.*",
  "memory.show.self",
  "memory.forget.self",
  "memory.export.self",
  "voice.consent",
];
const V1_EVERYDAY = [
  "chat.talk",
  "link.*",
  "voice.join",
  "voice.leave",
  "queue.request",
  "queue.list",
  "game.status",
  "stream.status",
];
const V1_TRUSTED = ["chat.*", "tools.*", "queue.priority", "game.suggest", "stream.clip"];
const V1_MODERATOR = [
  "voice.*",
  "queue.*",
  "game.*",
  "stream.scene",
  "memory.view.others",
  "admin.channel.*",
  "admin.voice.*",
  "admin.block.*",
  "admin.persona.view",
  "admin.role.list",
  "admin.role.whois",
  "admin.audit.view",
];
const V1_ADMIN = ["admin.*", "module.*", "memory.*", "stream.*"];

/**
 * Members may ask her to set timers (`remind_me`, v4 §8.3). Trusted and above have it through
 * `tools.*`; the member role lists it with the other low-risk everyday tools in
 * `@miyoria/commands` (`nodes.ts`). Named here so a stored role from before it is still upgraded.
 */
const REMIND_TOOL = "tools.remind";

/** The role's current grants without `removed` (the nodes a later version added). */
function without(name: string, removed: readonly string[]): string[] {
  const role = builtinRoleGrants().find((r) => r.name === name);
  return (role?.grants ?? []).filter((n) => !removed.includes(n));
}

/** A built-in role's grants before members could ask her to set timers. */
function beforeRemind(name: string): string[] {
  return without(name, [REMIND_TOOL]);
}

/** A built-in role's grants before moderators could make rules. */
function beforeDirectives(name: string): string[] {
  return without(name, [DIRECTIVE_MODERATE, WEB_TOOL, FILE_READ, REMIND_TOOL]);
}

/** A built-in role's grants before members could ask her to search the web. */
function beforeWeb(name: string): string[] {
  return without(name, [WEB_TOOL, FILE_READ, REMIND_TOOL]);
}

/** A built-in role's grants before members could send her files. */
function beforeFiles(name: string): string[] {
  return without(name, [FILE_READ, REMIND_TOOL]);
}

/** A built-in role's grants before trusted people could ask her to run code. */
function beforeSandbox(name: string): string[] {
  return beforeDirectives(name).filter((n) => n !== SANDBOX_CODE_RUN);
}

/** The same nodes, in any order: a store may hand them back sorted differently than they were seeded. */
const sameList = (a: readonly string[], b: readonly string[]) => {
  if (a.length !== b.length) return false;
  const x = [...a].sort();
  const y = [...b].sort();
  return x.every((n, i) => n === y[i]);
};

/**
 * Grants of the built-in roles as earlier versions seeded them, oldest first. A stored built-in
 * role that still has exactly these grants was never edited and is upgraded to the current
 * definition.
 */
const LEGACY: Readonly<Record<string, readonly (readonly string[])[]>> = {
  admin: [
    [...V1_PRIVACY, ...V1_EVERYDAY, ...V1_TRUSTED, ...V1_MODERATOR, ...V1_ADMIN],
    beforeSandbox("admin"),
    beforeDirectives("admin"),
    beforeWeb("admin"),
    beforeFiles("admin"),
    beforeRemind("admin"),
  ],
  moderator: [
    [...V1_PRIVACY, ...V1_EVERYDAY, ...V1_TRUSTED, ...V1_MODERATOR],
    beforeSandbox("moderator"),
    beforeDirectives("moderator"),
    beforeWeb("moderator"),
    beforeFiles("moderator"),
    beforeRemind("moderator"),
  ],
  trusted: [
    [...V1_PRIVACY, ...V1_EVERYDAY, ...V1_TRUSTED],
    beforeSandbox("trusted"),
    beforeWeb("trusted"),
    beforeFiles("trusted"),
    beforeRemind("trusted"),
  ],
  user: [
    [...V1_PRIVACY, ...V1_EVERYDAY],
    beforeWeb("user"),
    beforeFiles("user"),
    beforeRemind("user"),
  ],
  restricted: [V1_PRIVACY],
};

/**
 * The legacy lists that differ from today's role: a step that did not change a role (the node it
 * added is not in that role's grants) is no earlier version of it, and a stored role equal to the
 * current one is `current`, never an upgrade.
 */
export const LEGACY_BUILTIN_GRANTS: Readonly<Record<string, readonly (readonly string[])[]>> =
  Object.fromEntries(
    Object.entries(LEGACY).map(([name, lists]) => {
      const current = builtinRoleGrants().find((r) => r.name === name)?.grants ?? [];
      return [name, lists.filter((grants) => !sameList(grants, current))];
    }),
  );

/**
 * What to do with a stored role named like a built-in one: `current` (nothing to do),
 * `upgrade` (unedited legacy definition: replace it) or `edited` (left alone).
 */
export function builtinStatus(stored: RoleDefinition): "current" | "upgrade" | "edited" | null {
  const current = builtinRoles().find((r) => r.name === stored.name);
  if (!current) return null;
  if (
    stored.rank === current.rank &&
    sameList(stored.grants, current.grants) &&
    sameList(stored.denies, current.denies)
  ) {
    return "current";
  }
  const legacy = LEGACY_BUILTIN_GRANTS[stored.name] ?? [];
  if (
    stored.rank === current.rank &&
    sameList(stored.denies, current.denies) &&
    legacy.some((grants) => sameList(stored.grants, grants))
  ) {
    return "upgrade";
  }
  return "edited";
}
