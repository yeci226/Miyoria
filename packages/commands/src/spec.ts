import type { AccountRef, ContextKey, Subject } from "@miyoria/types";
import type { CommandReply } from "./reply.js";

/** Thrown for malformed command specs, conflicting registrations and bad account strings. */
export class CommandError extends Error {
  override readonly name = "CommandError";
}

/**
 * The argument type. Serialized like Rust `#[serde(tag = "type", content = "choices")]`:
 * `{ type: "string" }`, `{ type: "choice", choices: [...] }`.
 */
export type ArgKind =
  | { type: "string" }
  | { type: "integer" }
  | { type: "boolean" }
  /** A string restricted to one of the listed values. */
  | { type: "choice"; choices: string[] }
  /**
   * A platform account id (Discord: user option). Text mentions such as `<@123>` are reduced
   * to the id.
   */
  | { type: "user" }
  /**
   * A platform role id (Discord: role option). Text mentions such as `<@&123>` are reduced to
   * the id.
   */
  | { type: "role" };

/** Constructors for `ArgKind` (Rust `ArgKind::String`, `ArgKind::Choice(..)`, ...). */
export const ArgKind = {
  string: { type: "string" },
  integer: { type: "integer" },
  boolean: { type: "boolean" },
  user: { type: "user" },
  role: { type: "role" },
  choice: (choices: readonly string[]): ArgKind => ({ type: "choice", choices: [...choices] }),
} as const;

export interface ArgSpec {
  name: string;
  description: string;
  kind: ArgKind;
  required: boolean;
  /**
   * The platform asks for suggestions while the user types (Discord autocomplete). Set by the
   * registry for string arguments that have an autocomplete handler.
   */
  autocomplete?: boolean;
}

/** `ArgSpec::new` (required) / `.optional()` (`{ required: false }`). */
export function argSpec(
  name: string,
  description: string,
  kind: ArgKind,
  options: { required?: boolean } = {},
): ArgSpec {
  return { name, description, kind, required: options.required ?? true };
}

/**
 * Declares one command. Platforms map it to their own syntax, e.g. Discord turns
 * `["admin", "module", "list"]` into `/admin module list`.
 */
export interface CommandSpec {
  /** One to three lowercase words, e.g. `["admin", "module", "list"]`. */
  path: string[];
  description: string;
  args: ArgSpec[];
  /** Permission node, e.g. `"admin.module.toggle"` (`""` = everyone). See `nodes.ts`. */
  permission: string;
  /**
   * Visibility of the reply: `true` = only the invoker sees it (private settings, admin),
   * `false` = the channel sees it (the default). `[modules.commands.visibility]` overrides it.
   * Warnings and errors are always ephemeral; see `replyEphemeral`.
   */
  ephemeral: boolean;
}

export interface CommandSpecOptions {
  args?: readonly ArgSpec[];
  permission?: string;
  ephemeral?: boolean;
}

/** `CommandSpec::new`. `path` is space separated, e.g. `"admin module list"`. */
export function commandSpec(
  path: string,
  description: string,
  options: CommandSpecOptions = {},
): CommandSpec {
  return {
    path: splitPath(path),
    description,
    args: [...(options.args ?? [])],
    permission: options.permission ?? "",
    ephemeral: options.ephemeral ?? false,
  };
}

/** Where a top-level command may be used and who sees it by default. */
export interface GroupInfo {
  description: string;
  /** Only in servers (Discord: no DM context). */
  guild_only: boolean;
  /**
   * Platform-native first gate (Discord: `default_member_permissions`). `manage_guild` hides the
   * command from members without Manage Server; the permission node is still checked.
   */
  member_permission: "manage_guild" | null;
}

/** The path joined with spaces. */
export function commandName(spec: Pick<CommandSpec, "path">): string {
  return spec.path.join(" ");
}

/** Splits a space separated command path. */
export function splitPath(path: string): string[] {
  return path.split(/\s+/u).filter((word) => word !== "");
}

/** Untagged like the Rust serde enum: a JSON string, integer or boolean. */
export type ArgValue = string | number | boolean;

/** Guild membership details of a user passed as an argument. */
export interface ResolvedUser {
  display_name: string;
  platform_roles: string[];
  is_guild_admin: boolean;
}

/** One command call, normalized by the platform that received it (the wire shape). */
export interface InvocationData {
  path: string[];
  args: Record<string, ArgValue>;
  invoker: AccountRef;
  invoker_display_name: string;
  context: ContextKey;
  /** The invoker administers the guild / server the command was sent in. */
  invoker_is_guild_admin: boolean;
  /** Platform role ids (e.g. Discord role ids) of the invoker in that guild. Default `[]`. */
  platform_roles?: string[];
  /**
   * What the platform knows about accounts passed in `user` arguments, keyed by account id.
   * Default `{}`.
   */
  resolved_users?: Record<string, ResolvedUser>;
}

function own<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** Checks another permission node for the invoker (bound by the registry). */
export type NodeCheck = (node: string) => Promise<boolean>;

/** Sends an extra message while a handler runs (bound by the platform, where supported). */
export type FollowUp = (reply: CommandReply) => Promise<void>;

/** An `InvocationData` with defaults applied and the Rust helper methods. */
export class Invocation implements InvocationData {
  path: string[];
  args: Record<string, ArgValue>;
  invoker: AccountRef;
  invoker_display_name: string;
  context: ContextKey;
  invoker_is_guild_admin: boolean;
  platform_roles: string[];
  resolved_users: Record<string, ResolvedUser>;
  #check: NodeCheck | null = null;
  #followUp: FollowUp | null = null;

  constructor(data: InvocationData) {
    this.path = [...data.path];
    this.args = { ...data.args };
    this.invoker = data.invoker;
    this.invoker_display_name = data.invoker_display_name;
    this.context = data.context;
    this.invoker_is_guild_admin = data.invoker_is_guild_admin;
    this.platform_roles = [...(data.platform_roles ?? [])];
    this.resolved_users = { ...(data.resolved_users ?? {}) };
  }

  /** `Invocation::new`: no arguments or guild details. `path` is space separated. */
  static create(path: string, invoker: AccountRef, context: ContextKey): Invocation {
    return new Invocation({
      path: splitPath(path),
      args: {},
      invoker,
      invoker_display_name: invoker.id,
      context,
      invoker_is_guild_admin: false,
    });
  }

  static from(data: InvocationData): Invocation {
    return data instanceof Invocation ? data : new Invocation(data);
  }

  /** `with_arg`: sets an argument and returns `this`. */
  withArg(name: string, value: ArgValue): this {
    this.args[name] = value;
    return this;
  }

  /** @internal Set by the registry before the handler runs. */
  bindCheck(check: NodeCheck): void {
    this.#check = check;
  }

  /** @internal Set by the platform. */
  bindFollowUp(followUp: FollowUp | null): void {
    this.#followUp = followUp;
  }

  /**
   * May the invoker use `node`? For checks that depend on the arguments (e.g. tagging someone
   * `owner` needs `owner.person.tag`); the command's own node was checked already.
   */
  allowed(node: string): Promise<boolean> {
    return this.#check ? this.#check(node) : Promise.resolve(false);
  }

  /** Whether `followUp` works on this platform. */
  canFollowUp(): boolean {
    return this.#followUp !== null;
  }

  /** Sends an extra message (e.g. a backup file before a destructive step). */
  async followUp(reply: CommandReply): Promise<void> {
    if (!this.#followUp) throw new CommandError("this platform cannot send follow-up messages");
    await this.#followUp(reply);
  }

  /** The invoker as an authorization subject in the invocation's context. */
  subject(): Subject {
    return {
      account: this.invoker,
      context: this.context,
      platform_roles: [...this.platform_roles],
      is_guild_admin: this.invoker_is_guild_admin,
    };
  }

  /**
   * `account` as a subject in this context, using the platform's details from
   * `resolved_users` (or the invoker's own).
   */
  subjectFor(account: AccountRef): Subject {
    if (account.platform === this.invoker.platform && account.id === this.invoker.id) {
      return this.subject();
    }
    const resolved =
      account.platform === this.context.platform ? own(this.resolved_users, account.id) : undefined;
    return {
      account,
      context: this.context,
      platform_roles: [...(resolved?.platform_roles ?? [])],
      is_guild_admin: resolved?.is_guild_admin ?? false,
    };
  }

  /**
   * A `user` argument as an account. Bare ids belong to the invoker's platform;
   * `"platform:id"` names another one.
   */
  account(name: string): AccountRef | null {
    const raw = this.str(name)?.trim();
    if (!raw) return null;
    const colon = raw.indexOf(":");
    if (colon > 0 && colon < raw.length - 1) {
      return { platform: raw.slice(0, colon), id: raw.slice(colon + 1) };
    }
    return { platform: this.invoker.platform, id: raw };
  }

  str(name: string): string | null {
    const value = own(this.args, name);
    return typeof value === "string" ? value : null;
  }

  int(name: string): number | null {
    const value = own(this.args, name);
    return typeof value === "number" ? value : null;
  }

  bool(name: string): boolean | null {
    const value = own(this.args, name);
    return typeof value === "boolean" ? value : null;
  }
}
