// Permission nodes: pattern matching and the grants of the built-in roles.
//
// This is the single definition of what a node means. The `auth` module seeds its built-in roles
// from `BUILTIN_ROLES`, and the fallback `Permissions` (used when `auth` is not running) checks
// the same lists, so a node never means different things with or without `auth`.
//
// | Role | Rank | Grants |
// |---|---|---|
// | owner | 100 | `*` |
// | admin | 80 | moderator plus `admin.*`, `module.*`, `memory.*`, `stream.*` |
// | moderator | 60 | trusted plus `voice.*`, `queue.*`, `game.*`, `stream.scene`, setting changes, time-limited rules, ... |
// | trusted | 40 | user plus `chat.*`, `tools.*`, `queue.priority`, `game.suggest`, `stream.clip` |
// | user | 20 | restricted plus joining voice, queue requests and votes, `tools.web`, `tools.file`, views of settings, ... |
// | restricted | 10 | `help`, `me.*`, `memory.self.*`, `voice.consent` |
// | blocked | 0 | nothing |

/**
 * Does `pattern` cover `node`?
 *
 * - `"*"` covers every node.
 * - `"queue.*"` covers `"queue"` and everything below it (`"queue.skip"`, `"queue.skip.self"`),
 *   but not `"queuex"`.
 * - Anything else must match exactly.
 *
 * Patterns can be checked against patterns: `"admin.*"` covers `"admin.role.*"`.
 */
export function matches(pattern: string, node: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -2);
    return (
      node === prefix || (node.startsWith(prefix) && node.slice(prefix.length).startsWith("."))
    );
  }
  return pattern === node;
}

/** `node` is granted by `grants` and not denied by `denies` (a deny beats a grant). */
export function granted(
  grants: readonly string[],
  denies: readonly string[],
  node: string,
): boolean {
  return !denies.some((p) => matches(p, node)) && grants.some((p) => matches(p, node));
}

/** `admin.*` and `owner.*` nodes (audited, Discord's `/admin` gate). */
export function isAdminNode(node: string): boolean {
  const root = node.split(".")[0];
  return root === "admin" || root === "owner";
}

/** Self-service privacy controls; kept even for `restricted`. */
const PRIVACY: readonly string[] = ["help", "help.*", "me.*", "memory.self.*", "voice.consent"];

/** `web_search` / `web_read`: members may ask her to look things up (trusted and above have `tools.*`). */
export const WEB_TOOL = "tools.web";

/**
 * Members may send her files to read (text, code, PDF, Office documents). Reading happens in the
 * code sandbox and what a file says is data, never instructions; `[modules.sandbox.files]` limits
 * how many a person may send. Revoke it from a role (or a person) to make her ignore their files.
 */
export const FILE_READ = "tools.file";

/**
 * `remind_me`: members may ask her to remind them of something. The timer only brings the matter
 * back to her (a proposal to the main line); it posts nothing by itself, and `[modules.mind]`
 * caps how many one person may have.
 */
export const REMIND_TOOL = "tools.remind";

const EVERYDAY: readonly string[] = [
  "chat.talk",
  "link.*",
  "voice.join",
  "voice.leave",
  "voice.mode.view",
  "voice.golive.view",
  "channel.mode.view",
  "channel.activeness.view",
  "queue.request",
  "queue.list",
  "queue.vote",
  "queue.song.request",
  "queue.song.list",
  "queue.song.play",
  "game.status",
  "stream.status",
  WEB_TOOL,
  FILE_READ,
  REMIND_TOOL,
];

/** Trusted people may ask her to run code in the sandbox (she can still decline). */
export const SANDBOX_CODE_RUN = "sandbox.code.run";

const TRUSTED_EXTRA: readonly string[] = [
  "chat.*",
  "tools.*",
  "queue.priority",
  "game.suggest",
  "stream.clip",
  SANDBOX_CODE_RUN,
];

/** Moderators may make rules for a limited time (§9); the owner's stay the owner's. */
export const DIRECTIVE_MODERATE = "admin.directive.*";

const MODERATOR_EXTRA: readonly string[] = [
  DIRECTIVE_MODERATE,
  "voice.*",
  "queue.*",
  "game.*",
  "stream.scene",
  "admin.channel.*",
  "admin.voice.*",
  "admin.person.block",
  "admin.persona.view",
  "admin.role.list",
  "admin.role.whois",
  "admin.audit.view",
];

const ADMIN_EXTRA: readonly string[] = ["admin.*", "module.*", "memory.*", "stream.*"];

/** MCP tools can do anything their server can; below admin they need an explicit override. */
const NO_MCP: readonly string[] = ["tools.mcp.*"];

export interface BuiltinRole {
  name: string;
  rank: number;
  grants: string[];
  denies: string[];
}

function role(
  name: string,
  rank: number,
  grants: readonly (readonly string[])[],
  denies: readonly string[],
): BuiltinRole {
  return { name, rank, grants: grants.flat(), denies: [...denies] };
}

/** The seven built-in roles, highest rank first. */
export function builtinRoleGrants(): BuiltinRole[] {
  return [
    role("owner", 100, [["*"]], []),
    role("admin", 80, [PRIVACY, EVERYDAY, TRUSTED_EXTRA, MODERATOR_EXTRA, ADMIN_EXTRA], []),
    role("moderator", 60, [PRIVACY, EVERYDAY, TRUSTED_EXTRA, MODERATOR_EXTRA], NO_MCP),
    role("trusted", 40, [PRIVACY, EVERYDAY, TRUSTED_EXTRA], NO_MCP),
    role("user", 20, [PRIVACY, EVERYDAY], []),
    role("restricted", 10, [PRIVACY], []),
    role("blocked", 0, [], []),
  ];
}

/** The built-in role named `name`. */
export function builtinRole(name: string): BuiltinRole | undefined {
  return builtinRoleGrants().find((r) => r.name === name);
}
