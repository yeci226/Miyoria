import { getLogger, type ServiceLookup } from "@miyoria/kernel";
import { type AuditLog, AuditLogKey } from "@miyoria/store";
import {
  AuthorizerKey,
  type Clock,
  contextKeyString,
  type JsonObject,
  newId,
  type ServiceKey,
  type Subject,
  serviceKey,
  systemClock,
  toTimestamp,
} from "@miyoria/types";
import {
  type AnyComponentRoute,
  type AutocompleteHandler,
  type Choice,
  ComponentInvocation,
  type ComponentInvocationData,
  type ComponentResult,
  componentSegments,
  validateRoute,
} from "./components.js";
import { MAX_MENUS_PER_TARGET, MENU_ROOT, type MenuSpec, menuCommandSpec } from "./menu.js";
import { isAdminNode } from "./nodes.js";
import { Permissions } from "./perms.js";
import { type CommandReply, notice, replyEphemeral } from "./reply.js";
import {
  type ArgValue,
  CommandError,
  type CommandSpec,
  commandName,
  type FollowUp,
  type GroupInfo,
  Invocation,
  type InvocationData,
  splitPath,
} from "./spec.js";
import { COMMAND_GROUPS, groupInfo, SLASH_REGROUP } from "./tree.js";

const log = getLogger("commands.registry");

/** Real path to the path Discord shows it under, and back (see `SLASH_REGROUP`). */
const PRESENTED = new Map(Object.entries(SLASH_REGROUP));
const REAL = new Map([...PRESENTED].map(([real, shown]) => [shown, real]));

/**
 * Optional service run before a permission check, so an `Authorizer` that loads data lazily
 * (e.g. per-guild role mappings) can fetch it first.
 */
export interface AuthorizerPreload {
  preload(subject: Subject): Promise<void>;
}

export const AuthorizerPreloadKey = serviceKey<AuthorizerPreload>("AuthorizerPreload");

/** The command registry service, provided by the `commands` module. */
export const CommandRegistryKey = serviceKey<CommandRegistry>("CommandRegistry");

/** Prefix of a panel's route owner (command keys never contain `/`). */
const PANEL_OWNER = "/";

/**
 * The subcommand that opens a panel whose command also has subcommands (`/me i`, `/admin i`):
 * Discord cannot run a command with subcommands bare. Always listed first.
 */
export const PANEL_SUBCOMMAND = "i";

/** Who sees a command's replies (`[modules.commands.visibility]`). */
export type Visibility = "public" | "private";

/** Deepest supported command path (Discord: group / subcommand group / subcommand). */
export const MAX_PATH_DEPTH = 3;
const MAX_NAME_LEN = 32;
/** Discord: a context menu name is 1 to 32 characters. */
const MAX_MENU_NAME = 32;
/** Discord shows at most 25 autocomplete suggestions. */
const MAX_CHOICES = 25;

export type HandlerResult = CommandReply | Promise<CommandReply>;
export type CommandHandler = (invocation: Invocation) => HandlerResult;

/** A user-facing argument problem (zh-TW), thrown by `normalizeArgs`. */
export class CommandArgError extends Error {
  override readonly name = "CommandArgError";
}

/** What a command brings besides its handler. */
export interface RegisterOptions {
  /** Buttons, selects and modals of the command's replies. */
  components?: readonly AnyComponentRoute[];
  /** Suggestion handlers of string arguments, by argument name. */
  autocomplete?: Readonly<Record<string, AutocompleteHandler>>;
}

interface Entry {
  spec: CommandSpec;
  handler: CommandHandler;
  routes: AnyComponentRoute[];
  autocomplete: Map<string, AutocompleteHandler>;
}

/** The answer to a component interaction, with the visibility of `reply` answers. */
export interface ComponentOutcome {
  result: ComponentResult;
  ephemeral: boolean;
}

/** What the platform can do for a handler while it runs. */
export interface DispatchIo {
  /** Sends an extra message (see `Invocation.followUp`). */
  followUp?: FollowUp;
  /**
   * `false`: leave no audit entry, whatever the outcome. For a read the platform runs by itself
   * (a panel's status lines are drawn on every refresh); what a person did is audited as usual.
   */
  audit?: boolean;
}

// ---- system text --------------------------------------------------------------------------

export const TEXT = {
  unknownCommand: (name: string) => `找不到指令「/${name}」。`,
  denied: "你沒有使用這個指令的權限。",
  deniedDetail: (node: string) => `需要權限：${node}`,
  badArgs: (message: string) => `參數有誤：${message}。`,
  staleControl: "這個控制項已失效，請重新執行指令。",
  expired: "這個面板已過期，請重新執行指令。",
  notInitiator: "只有執行指令的人可以操作這個面板。",
  badControl: "控制項資料無效。",
  refused: "你不能進行這個操作。",
} as const;

/**
 * Observes `CommandRegistry.version()` changes, like a Rust `watch::Receiver`: several changes
 * in a row are reported once. Iterate it with `for await`, or call `changed()`.
 */
export class VersionSubscription implements AsyncIterable<number> {
  readonly #registry: CommandRegistry;
  readonly #waiters: Array<(version: number | null) => void> = [];
  #seen: number;
  #closed = false;

  /** @internal Created by `CommandRegistry.subscribe`. */
  constructor(registry: CommandRegistry, seen: number, signal?: AbortSignal) {
    this.#registry = registry;
    this.#seen = seen;
    if (signal?.aborted) this.close();
    else signal?.addEventListener("abort", () => this.close(), { once: true });
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** The current version, without marking it as seen. */
  current(): number {
    return this.#registry.version();
  }

  /**
   * Resolves with the new version once it differs from the last one seen (marking it seen), or
   * with `null` when the subscription is closed.
   */
  changed(): Promise<number | null> {
    if (this.#closed) return Promise.resolve(null);
    const version = this.#registry.version();
    if (version !== this.#seen) {
      this.#seen = version;
      return Promise.resolve(version);
    }
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  /** @internal */
  notify(version: number): void {
    if (this.#closed || this.#waiters.length === 0) return;
    this.#seen = version;
    for (const resolve of this.#waiters.splice(0)) resolve(version);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#registry.unsubscribe(this);
    for (const resolve of this.#waiters.splice(0)) resolve(null);
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<number> {
    try {
      for (;;) {
        const version = await this.changed();
        if (version === null) return;
        yield version;
      }
    } finally {
      this.close();
    }
  }
}

export interface CommandRegistryOptions {
  /** Where `Authorizer`, `AuthorizerPreload` and `AuditLog` are looked up at dispatch time. */
  services?: ServiceLookup;
  /** Time source for audit entries. */
  clock?: Clock;
}

/**
 * Every registered command and its component routes. Provided as the `CommandRegistryKey`
 * service by the `commands` module; other modules may register commands at any time and
 * platforms watch `subscribe()` to re-sync.
 */
export class CommandRegistry {
  readonly #perms: Permissions;
  #services: ServiceLookup | null;
  readonly #clock: Clock;
  readonly #entries = new Map<string, Entry>();
  readonly #panels = new Map<string, Entry>();
  /** Context menu entries by id; their commands live at `["menu", id]` (see `menu.ts`). */
  readonly #menus = new Map<string, { menu: MenuSpec; entry: Entry }>();
  readonly #visibility = new Map<string, Visibility>();
  readonly #groups = new Map<string, GroupInfo>();
  readonly #routes = new Map<string, { owner: string; route: AnyComponentRoute }>();
  readonly #subscriptions = new Set<VersionSubscription>();
  #version = 0;

  constructor(perms: Permissions = new Permissions(), options: CommandRegistryOptions = {}) {
    this.#perms = perms;
    this.#services = options.services ?? null;
    this.#clock = options.clock ?? systemClock;
    for (const [path, init] of Object.entries(COMMAND_GROUPS)) {
      this.#groups.set(path, groupInfo(init));
    }
  }

  /**
   * Looks up the `Authorizer` (falling back to the own `Permissions`), `AuthorizerPreload` and
   * `AuditLog` services through `services` whenever a command is dispatched.
   */
  withServices(services: ServiceLookup): this {
    this.#services = services;
    return this;
  }

  permissions(): Permissions {
    return this.#perms;
  }

  /**
   * Registers (or replaces) the command at `spec.path` with its component routes and
   * autocomplete handlers.
   *
   * Throws `CommandError` if the spec is malformed, if its path is a prefix of another
   * command's path (or the other way round), which hierarchical platforms cannot represent, or
   * if one of its component routes belongs to another command.
   */
  register(spec: CommandSpec, handler: CommandHandler, options: RegisterOptions = {}): void {
    validateSpec(spec);
    const key = spec.path.join(" ");
    if (spec.path[0] === MENU_ROOT) {
      throw new CommandError(`command \`${commandName(spec)}\`: \`${MENU_ROOT}\` is reserved`);
    }
    if (
      spec.path.length === 2 &&
      spec.path[1] === PANEL_SUBCOMMAND &&
      this.#panels.has(spec.path[0] as string)
    ) {
      throw new CommandError(
        `command \`${commandName(spec)}\`: \`${PANEL_SUBCOMMAND}\` opens the panel of \`${spec.path[0]}\``,
      );
    }
    for (const other of this.#entries.values()) {
      const path = other.spec.path;
      if (path.join(" ") !== key && (startsWith(path, spec.path) || startsWith(spec.path, path))) {
        throw new CommandError(
          `command \`${commandName(spec)}\` conflicts with \`${commandName(other.spec)}\``,
        );
      }
    }
    this.#store(this.#entries, key, key, spec, handler, options);
  }

  /**
   * Registers a panel command: a top-level command (one word) whose reply is a panel of
   * controls that run other registered commands. Panels live beside the command tree: when
   * the command has subcommands the panel is its `i` subcommand (`/me i` next to `me profile`),
   * otherwise it is the bare command (`/miyo`). See `panelPath`.
   */
  registerPanel(spec: CommandSpec, handler: CommandHandler, options: RegisterOptions = {}): void {
    validateSpec(spec);
    if (spec.path.length !== 1) {
      throw new CommandError(`panel \`${commandName(spec)}\` must be a top-level command`);
    }
    const key = spec.path.join(" ");
    this.#store(this.#panels, key, `${PANEL_OWNER}${key}`, spec, handler, options);
  }

  /** Removes a panel command (and its component routes). */
  unregisterPanel(path: string): boolean {
    const key = splitPath(path).join(" ");
    const removed = this.#panels.delete(key);
    if (removed) {
      this.#dropRoutes(`${PANEL_OWNER}${key}`);
      this.#bump();
    }
    return removed;
  }

  /**
   * Registers (or replaces) a context menu entry. Throws `CommandError` for a bad name or id,
   * or when the platform's limit per target would be passed.
   */
  registerMenu(menu: MenuSpec, handler: CommandHandler): void {
    const length = [...menu.name].length;
    if (length < 1 || length > MAX_MENU_NAME) {
      throw new CommandError(
        `menu \`${menu.id}\`: the name must be 1 to ${MAX_MENU_NAME} characters`,
      );
    }
    const spec = menuCommandSpec(menu);
    validateSpec(spec);
    const same = [...this.#menus.values()].filter(
      (m) => m.menu.target === menu.target && m.menu.id !== menu.id,
    );
    if (same.length >= MAX_MENUS_PER_TARGET) {
      throw new CommandError(
        `menu \`${menu.id}\`: at most ${MAX_MENUS_PER_TARGET} ${menu.target} menus`,
      );
    }
    if (same.some((m) => m.menu.name === menu.name)) {
      throw new CommandError(`menu \`${menu.id}\`: the name \`${menu.name}\` is taken`);
    }
    const scratch = new Map<string, Entry>();
    this.#store(scratch, spec.path.join(" "), spec.path.join(" "), spec, handler, {});
    const entry = scratch.get(spec.path.join(" ")) as Entry;
    this.#menus.set(menu.id, { menu: { ...menu }, entry });
  }

  /** Removes a context menu entry. */
  unregisterMenu(id: string): boolean {
    const removed = this.#menus.delete(id);
    if (removed) this.#bump();
    return removed;
  }

  /** The context menu entries, by target then name. */
  menus(): MenuSpec[] {
    return [...this.#menus.values()]
      .map((m) => ({ ...m.menu }))
      .sort((a, b) => a.target.localeCompare(b.target) || a.name.localeCompare(b.name));
  }

  /** The menu entry named `name` for `target`, as the platform shows it. */
  menuByName(target: MenuSpec["target"], name: string): MenuSpec | undefined {
    return this.menus().find((m) => m.target === target && m.name === name);
  }

  #store(
    into: Map<string, Entry>,
    key: string,
    owner: string,
    spec: CommandSpec,
    handler: CommandHandler,
    options: RegisterOptions,
  ): void {
    const routes = [...(options.components ?? [])];
    const seen = new Set<string>();
    for (const route of routes) {
      validateRoute(route.route);
      if (seen.has(route.route)) {
        throw new CommandError(
          `command \`${commandName(spec)}\` declares route \`${route.route}\` twice`,
        );
      }
      seen.add(route.route);
      const taken = this.#routes.get(route.route);
      if (taken && taken.owner !== owner) {
        throw new CommandError(
          `component route \`${route.route}\` of \`${commandName(spec)}\` is already used by \`${taken.owner}\``,
        );
      }
    }
    const stored = structuredClone(spec);
    const autocomplete = new Map(Object.entries(options.autocomplete ?? {}));
    for (const [name] of autocomplete) {
      const arg = stored.args.find((a) => a.name === name);
      if (arg?.kind.type !== "string") {
        throw new CommandError(
          `command \`${commandName(spec)}\`: autocomplete needs a string argument \`${name}\``,
        );
      }
      arg.autocomplete = true;
    }
    for (const arg of stored.args) {
      if (arg.autocomplete && !autocomplete.has(arg.name)) delete arg.autocomplete;
    }

    this.#dropRoutes(owner);
    for (const route of routes) this.#routes.set(route.route, { owner, route });
    into.set(key, { spec: stored, handler, routes, autocomplete });
    this.#bump();
  }

  /** Removes the command at the space separated `path` (and its component routes). */
  unregister(path: string): boolean {
    const key = splitPath(path).join(" ");
    const removed = this.#entries.delete(key);
    if (removed) {
      this.#dropRoutes(key);
      this.#bump();
    }
    return removed;
  }

  #dropRoutes(owner: string): void {
    for (const [name, route] of this.#routes) {
      if (route.owner === owner) this.#routes.delete(name);
    }
  }

  /**
   * Sets the description of a command group such as `"admin"` or `"admin module"` (platforms
   * need one for each parent level), keeping its other settings.
   */
  setGroupDescription(path: string, description: string): void {
    const key = splitPath(path).join(" ");
    const current = this.#groups.get(key);
    this.#groups.set(key, current ? { ...current, description } : groupInfo({ description }));
    this.#bump();
  }

  /** Sets a group's description and platform gates. */
  setGroup(path: string, info: Partial<GroupInfo> & { description: string }): void {
    this.#groups.set(splitPath(path).join(" "), groupInfo(info));
    this.#bump();
  }

  groupDescription(path: string | readonly string[]): string | undefined {
    return this.groupInfo(path)?.description;
  }

  groupInfo(path: string | readonly string[]): GroupInfo | undefined {
    const info = this.#groups.get(
      typeof path === "string" ? splitPath(path).join(" ") : path.join(" "),
    );
    return info ? { ...info } : undefined;
  }

  /** All registered commands (panels not included), ordered by path. */
  specs(): CommandSpec[] {
    return [...this.#entries.values()]
      .map((e) => e.spec)
      .sort((a, b) => comparePaths(a.path, b.path))
      .map((spec) => this.#view(spec));
  }

  /**
   * The commands a slash platform registers: the panels first (so `i` leads its level), then
   * every other command.
   */
  slashSpecs(): CommandSpec[] {
    const regrouped = this.specs().map((spec) => ({
      ...spec,
      path: this.slashPath(spec.path),
    }));
    return [...this.#panelSpecs(), ...regrouped];
  }

  /** The path a platform with a command tree shows `path` under (usually `path` itself). */
  slashPath(path: readonly string[]): string[] {
    const shown = PRESENTED.get(path.join(" "));
    return shown === undefined ? [...path] : splitPath(shown);
  }

  /** `path` as the registry knows it: a regrouped path (`me play quests`) becomes the real one. */
  #real(path: readonly string[]): string[] {
    const real = REAL.get(path.join(" "));
    return real === undefined ? [...path] : splitPath(real);
  }

  #panelSpecs(): CommandSpec[] {
    return [...this.#panels.values()]
      .map((e) => this.#view(e.spec, this.panelPath(e.spec.path[0] as string)))
      .sort((a, b) => comparePaths(a.path, b.path));
  }

  /**
   * The path that opens the panel of `command`: `[command, "i"]` when the command has
   * subcommands, else `[command]`.
   */
  panelPath(command: string): string[] {
    for (const entry of this.#entries.values()) {
      if (entry.spec.path[0] === command && entry.spec.path.length > 1) {
        return [command, PANEL_SUBCOMMAND];
      }
    }
    return [command];
  }

  /** A registered panel by its command word, with the path that opens it. */
  panelSpec(command: string): CommandSpec | undefined {
    const entry = this.#panels.get(command);
    return entry ? this.#view(entry.spec, this.panelPath(command)) : undefined;
  }

  /** A command or panel by path. */
  get(path: readonly string[]): CommandSpec | undefined {
    const real = this.#real(path);
    const entry = this.#find(real.join(" "));
    return entry ? this.#view(entry.spec, real) : undefined;
  }

  /** A panel at its opening path (`panelPath`), else a command. */
  #find(key: string): Entry | undefined {
    key = REAL.get(key) ?? key;
    const head = splitPath(key)[0];
    if (head === MENU_ROOT) return this.#menus.get(splitPath(key)[1] ?? "")?.entry;
    const panel = head === undefined ? undefined : this.#panels.get(head);
    if (panel && head !== undefined && this.panelPath(head).join(" ") === key) return panel;
    return this.#entries.get(key);
  }

  /** A copy of `spec` at `path` with the visibility the configuration gives it. */
  #view(spec: CommandSpec, path: readonly string[] = spec.path): CommandSpec {
    const out = structuredClone(spec);
    out.path = [...path];
    out.ephemeral = this.#ephemeralAt(path, spec.ephemeral);
    return out;
  }

  /**
   * Replaces the visibility overrides (`[modules.commands.visibility]`): command path or group
   * prefix (`"me wallet"`, `"me"`) to `public` / `private`. The longest matching key wins over
   * the command's own declaration. Warnings and errors stay ephemeral (`replyEphemeral`).
   */
  setVisibility(table: Readonly<Record<string, Visibility>>): void {
    this.#visibility.clear();
    for (const [path, visibility] of Object.entries(table)) {
      const key = splitPath(path).join(" ");
      if (key !== "") this.#visibility.set(key, visibility);
    }
    this.#bump();
  }

  /** Visibility keys that match no registered command, panel or group (typos). */
  unknownVisibility(): string[] {
    const paths: string[][] = [
      ...[...this.#entries.values()].map((e) => e.spec.path),
      ...[...this.#panels.keys()].map((c) => this.panelPath(c)),
      ...[...this.#panels.keys()].map((c) => [c]),
    ];
    return [...this.#visibility.keys()].filter((key) => {
      const words = key.split(" ");
      return !paths.some((path) => startsWith(path, words));
    });
  }

  #ephemeralAt(path: readonly string[], declared: boolean): boolean {
    for (let n = path.length; n >= 1; n--) {
      const hit = this.#visibility.get(path.slice(0, n).join(" "));
      if (hit !== undefined) return hit === "private";
    }
    return declared;
  }

  #owned(owner: string): Entry | undefined {
    return owner.startsWith(PANEL_OWNER)
      ? this.#panels.get(owner.slice(PANEL_OWNER.length))
      : this.#entries.get(owner);
  }

  /** Whether replies of the command that owns routes `owner` are ephemeral. */
  #ownerEphemeral(owner: string, entry: Entry): boolean {
    const path = owner.startsWith(PANEL_OWNER)
      ? this.panelPath(entry.spec.path[0] as string)
      : entry.spec.path;
    return this.#ephemeralAt(path, entry.spec.ephemeral);
  }

  /** Every registered component route name, sorted. */
  routes(): string[] {
    return [...this.#routes.keys()].sort();
  }

  /** Increases on every registration change. */
  version(): number {
    return this.#version;
  }

  /**
   * Watches for registration changes (commands or group descriptions). Close the returned
   * subscription (or pass a `signal`) when done.
   */
  subscribe(signal?: AbortSignal): VersionSubscription {
    const subscription = new VersionSubscription(this, this.#version, signal);
    if (!subscription.closed) this.#subscriptions.add(subscription);
    return subscription;
  }

  /** @internal */
  unsubscribe(subscription: VersionSubscription): void {
    this.#subscriptions.delete(subscription);
  }

  /**
   * Commands the invoker of `data` may run (its `path` and `args` are ignored). With `panels`
   * the panels come first; a panel that has subcommands (`/me i`) is listed only when the
   * invoker may run one of them, so `/admin i` stays out of a plain member's list.
   */
  async permitted(
    data: InvocationData,
    options: { panels?: boolean } = {},
  ): Promise<CommandSpec[]> {
    const invocation = Invocation.from(data);
    const out: CommandSpec[] = [];
    for (const spec of this.specs()) {
      if (await this.#allows(invocation, spec.permission)) out.push(spec);
    }
    if (!options.panels) return out;
    const panels: CommandSpec[] = [];
    for (const spec of this.#panelSpecs()) {
      if (!(await this.#allows(invocation, spec.permission))) continue;
      const command = spec.path[0] as string;
      if (spec.path.length > 1 && !out.some((s) => s.path[0] === command)) continue;
      panels.push(spec);
    }
    return [...panels, ...out];
  }

  /**
   * Checks permissions and arguments, then runs the handler.
   *
   * Unknown commands, permission denials and invalid arguments become warning / error notices;
   * only handler failures are thrown.
   */
  async dispatch(data: InvocationData, io: DispatchIo = {}): Promise<CommandReply> {
    const invocation = Invocation.from(data);
    invocation.path = this.#real(invocation.path);
    const entry = this.#find(invocation.path.join(" "));
    if (!entry) return notice("warn", TEXT.unknownCommand(invocation.path.join(" ")));
    const { spec, handler } = entry;
    const audit =
      io.audit !== false && isAdminNode(spec.permission) ? this.#service(AuditLogKey) : undefined;
    if (!(await this.#allows(invocation, spec.permission))) {
      if (audit) await this.#appendAudit(audit, invocation, false, "denied");
      return denied(spec.permission);
    }
    try {
      invocation.args = normalizeArgs(spec, invocation.args);
    } catch (error) {
      if (error instanceof CommandArgError) return notice("warn", TEXT.badArgs(error.message));
      throw error;
    }
    invocation.bindCheck((node) => this.#allows(invocation, node));
    invocation.bindFollowUp(io.followUp ?? null);
    if (!audit) return await handler(invocation);
    const record = new Invocation(invocation);
    let reply: CommandReply;
    try {
      reply = await handler(invocation);
    } catch (error) {
      await this.#appendAudit(audit, record, false, null);
      throw error;
    }
    await this.#appendAudit(audit, record, true, null);
    return reply;
  }

  /**
   * Routes a button / select / modal interaction. Returns `null` for component ids Miyoria did
   * not make (they may belong to someone else). Refusals become ephemeral notices; handler
   * failures are thrown.
   */
  async dispatchComponent(
    data: ComponentInvocationData,
    io: DispatchIo = {},
  ): Promise<ComponentOutcome | null> {
    const segments = componentSegments(data.custom_id);
    if (segments === null) return null;
    const found = this.#findRoute(segments);
    const refuse = (reply: CommandReply): ComponentOutcome => ({
      result: { type: "reply", reply },
      ephemeral: true,
    });
    if (!found) return refuse(notice("warn", TEXT.staleControl));
    const { name, params, owner, route } = found;
    const entry = this.#owned(owner);
    if (!entry) return refuse(notice("warn", TEXT.staleControl));
    const inv = new ComponentInvocation(data, entry.spec.path, name, params);
    const nodes = [entry.spec.permission, ...(route.permission ? [route.permission] : [])];
    const auditNode = nodes.find(isAdminNode);
    const audit = auditNode !== undefined ? this.#service(AuditLogKey) : undefined;
    for (const node of nodes) {
      if (!(await this.#allows(inv, node))) {
        if (audit) await this.#appendAudit(audit, inv, false, "denied", name);
        return refuse(denied(node));
      }
    }
    const session = inv.session;
    if (route.requiresSession && session === null) return refuse(notice("warn", TEXT.expired));
    // A session binds a panel to its opener unless the panel is shared (a public reply). Either
    // way a press runs as the presser, with the presser's own permissions (`inv` is theirs).
    if (session?.initiator_only && !sameInvoker(session.initiator, inv)) {
      return refuse(notice("warn", TEXT.notInitiator));
    }
    const parsed = route.parse ? route.parse(params) : params;
    if (parsed === null) return refuse(notice("error", TEXT.badControl));
    if (route.require && !(await route.require(parsed, inv))) {
      return refuse(notice("error", TEXT.refused));
    }
    inv.bindCheck((node) => this.#allows(inv, node));
    inv.bindFollowUp(io.followUp ?? null);
    let result: ComponentResult;
    try {
      result = await route.handle(inv, parsed);
    } catch (error) {
      if (audit) await this.#appendAudit(audit, inv, false, null, name);
      throw error;
    }
    if (audit) await this.#appendAudit(audit, inv, true, null, name);
    // Replies follow the command's visibility; a route can only make them more private.
    const declared = this.#ownerEphemeral(owner, entry) || (route.ephemeral ?? false);
    const ephemeral = result.type === "reply" ? replyEphemeral(declared, result.reply) : true;
    return { result, ephemeral };
  }

  /** The longest registered route that prefixes `segments`. */
  #findRoute(
    segments: readonly string[],
  ): { name: string; params: string[]; owner: string; route: AnyComponentRoute } | null {
    for (let n = segments.length; n >= 1; n--) {
      const name = segments.slice(0, n).join(":");
      const hit = this.#routes.get(name);
      if (hit) return { name, params: segments.slice(n), owner: hit.owner, route: hit.route };
    }
    return null;
  }

  /**
   * Suggestions for argument `name` of the command in `data`, while the user typed `value`.
   * Empty when the command, the handler or the permission is missing.
   */
  async autocomplete(data: InvocationData, name: string, value: string): Promise<Choice[]> {
    const invocation = Invocation.from(data);
    invocation.path = this.#real(invocation.path);
    const entry = this.#find(invocation.path.join(" "));
    const handler = entry?.autocomplete.get(name);
    if (!entry || !handler) return [];
    if (!(await this.#allows(invocation, entry.spec.permission))) return [];
    invocation.bindCheck((node) => this.#allows(invocation, node));
    const choices = await handler(invocation, value);
    return choices.slice(0, MAX_CHOICES).map((c) => ({
      name: truncateChars(c.name, 100),
      value: truncateChars(c.value, 100),
    }));
  }

  /** Checks `node` with the `Authorizer` service if there is one, otherwise with `Permissions`. */
  async #allows(invocation: Invocation, node: string): Promise<boolean> {
    const authorizer = this.#service(AuthorizerKey);
    if (!authorizer) return this.#perms.allowsInvocation(invocation, node);
    const subject = invocation.subject();
    const preload = this.#service(AuthorizerPreloadKey);
    if (preload) await preload.preload(subject);
    return authorizer.allowsSubject(subject, node);
  }

  #service<T>(key: ServiceKey<T>): T | undefined {
    return this.#services?.get(key);
  }

  async #appendAudit(
    audit: AuditLog,
    inv: Invocation,
    ok: boolean,
    outcome: string | null,
    route: string | null = null,
  ): Promise<void> {
    const detail: JsonObject = {
      args: sortedArgs(inv.args),
      context: contextKeyString(inv.context),
    };
    if (route !== null) {
      detail.component = route;
      if (inv instanceof ComponentInvocation) {
        detail.params = [...inv.params];
        if (inv.values.length > 0) detail.values = [...inv.values];
      }
    }
    if (outcome !== null) detail.outcome = outcome;
    const entry = {
      id: newId(),
      at: toTimestamp(this.#clock.now()),
      actor: `${inv.invoker.platform}:${inv.invoker.id}`,
      action: inv.path.join(" "),
      target: contextKeyString(inv.context),
      detail,
      ok,
    };
    try {
      await audit.append(entry);
    } catch (err) {
      log.warn({ action: entry.action, err }, "cannot write audit entry");
    }
  }

  #bump(): void {
    this.#version += 1;
    for (const subscription of [...this.#subscriptions]) subscription.notify(this.#version);
  }
}

function denied(node: string): CommandReply {
  return notice("error", TEXT.denied, node === "" ? null : TEXT.deniedDetail(node));
}

function sameInvoker(initiator: { platform: string; id: string }, inv: Invocation): boolean {
  return initiator.platform === inv.invoker.platform && initiator.id === inv.invoker.id;
}

function truncateChars(s: string, max: number): string {
  const chars = [...s];
  return chars.length <= max ? s : `${chars.slice(0, max - 1).join("")}…`;
}

/** Args as a JSON object with ascending keys (Rust serialized a `BTreeMap`). */
function sortedArgs(args: Record<string, ArgValue>): JsonObject {
  const out: JsonObject = {};
  for (const key of Object.keys(args).sort()) out[key] = args[key] as ArgValue;
  return out;
}

function startsWith(path: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length <= path.length && prefix.every((word, i) => path[i] === word);
}

function comparePaths(a: readonly string[], b: readonly string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i] as string;
    const y = b[i] as string;
    if (x !== y) return x < y ? -1 : 1;
  }
  return a.length - b.length;
}

const VALID_NAME_CHAR = /^(?:(?![\p{Uppercase}])[\p{Alphabetic}\p{N}]|[-_])$/u;

function validName(name: string): boolean {
  const chars = [...name];
  return (
    chars.length >= 1 && chars.length <= MAX_NAME_LEN && chars.every((c) => VALID_NAME_CHAR.test(c))
  );
}

function validateSpec(spec: CommandSpec): void {
  const name = commandName(spec);
  if (spec.path.length === 0 || spec.path.length > MAX_PATH_DEPTH) {
    throw new CommandError(`command \`${name}\`: path must have 1 to ${MAX_PATH_DEPTH} words`);
  }
  const bad = spec.path.find((word) => !validName(word));
  if (bad !== undefined) throw new CommandError(`command \`${name}\`: invalid name \`${bad}\``);
  if (spec.description.trim() === "") {
    throw new CommandError(`command \`${name}\`: description is empty`);
  }
  const seen = new Set<string>();
  for (const arg of spec.args) {
    if (!validName(arg.name)) {
      throw new CommandError(`command \`${name}\`: invalid argument name \`${arg.name}\``);
    }
    if (seen.has(arg.name)) {
      throw new CommandError(`command \`${name}\`: duplicate argument \`${arg.name}\``);
    }
    seen.add(arg.name);
    if (arg.kind.type === "choice" && arg.kind.choices.length === 0) {
      throw new CommandError(`command \`${name}\`: argument \`${arg.name}\` has no choices`);
    }
  }
}

const INTEGER = /^[+-]?\d+$/;

/**
 * Validates `args` against the spec and coerces string values (from text platforms) to the
 * declared kinds. Throws `CommandArgError`; its message is user-facing.
 */
export function normalizeArgs(
  spec: CommandSpec,
  args: Readonly<Record<string, ArgValue>>,
): Record<string, ArgValue> {
  const unknown = Object.keys(args)
    .sort()
    .find((key) => !spec.args.some((a) => a.name === key));
  if (unknown !== undefined) throw new CommandArgError(`「${unknown}」不是這個指令的參數`);
  const out: Record<string, ArgValue> = {};
  for (const arg of spec.args) {
    const value = Object.hasOwn(args, arg.name) ? args[arg.name] : undefined;
    if (value === undefined) {
      if (arg.required) throw new CommandArgError(`缺少「${arg.name}」`);
      continue;
    }
    out[arg.name] = coerce(arg.name, arg.kind, value);
  }
  return out;
}

function coerce(
  name: string,
  kind: CommandSpec["args"][number]["kind"],
  value: ArgValue,
): ArgValue {
  switch (kind.type) {
    case "string":
      if (typeof value === "string") return value;
      break;
    case "integer":
      if (typeof value === "number" && Number.isSafeInteger(value)) return value;
      if (typeof value === "string") {
        const trimmed = value.trim();
        const parsed = Number(trimmed);
        if (INTEGER.test(trimmed) && Number.isSafeInteger(parsed)) return parsed;
        throw new CommandArgError(`「${name}」必須是整數`);
      }
      break;
    case "boolean":
      if (typeof value === "boolean") return value;
      if (typeof value === "string") {
        switch (value.trim().toLowerCase()) {
          case "true":
          case "yes":
          case "on":
          case "1":
            return true;
          case "false":
          case "no":
          case "off":
          case "0":
            return false;
          default:
            throw new CommandArgError(`「${name}」必須是 true 或 false`);
        }
      }
      break;
    case "user":
      if (typeof value === "string") {
        const id = mentionId(value, ["<@!", "<@"]);
        if (id === null) throw new CommandArgError(`「${name}」必須是一位使用者`);
        return id;
      }
      break;
    case "role":
      if (typeof value === "string") {
        const id = mentionId(value, ["<@&"]);
        if (id === null) throw new CommandArgError(`「${name}」必須是一個身分組`);
        return id;
      }
      break;
    case "choice":
      if (typeof value === "string") {
        if (kind.choices.includes(value)) return value;
        throw new CommandArgError(`「${name}」只能是 ${kind.choices.join("、")} 其中之一`);
      }
      break;
  }
  log.warn({ arg: name, kind, value }, "argument has the wrong type");
  throw new CommandArgError(`「${name}」的型別不正確`);
}

/**
 * `"<@123>"` (with one of `prefixes`) or a bare `"123"` / `"discord:123"` → the id part.
 * Rejects empty values and whitespace.
 */
function mentionId(raw: string, prefixes: readonly string[]): string | null {
  const trimmed = raw.trim();
  let id = trimmed;
  for (const prefix of prefixes) {
    if (
      trimmed.startsWith(prefix) &&
      trimmed.endsWith(">") &&
      trimmed.length >= prefix.length + 1
    ) {
      id = trimmed.slice(prefix.length, -1);
      break;
    }
  }
  return id !== "" && !/\s/u.test(id) && !/[<>@&]/u.test(id) ? id : null;
}
