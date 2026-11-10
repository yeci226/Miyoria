import {
  defineManifest,
  errorMessage,
  type Module,
  type ModuleContext,
  type ModuleManifest,
  type ModuleStatus,
  type ServiceLookup,
  type Supervisor,
  SupervisorKey,
  sleep,
} from "@miyoria/kernel";
import { type AccountRef, AuthorizerKey, type ModuleId } from "@miyoria/types";
import { z } from "zod";
import {
  type AnyComponentRoute,
  type Choice,
  type ComponentInvocation,
  ComponentResult,
  componentId,
  defineRoute,
  intParam,
} from "./components.js";
import { registerHelp } from "./help.js";
import { registerPanels } from "./panels.js";
import { Permissions, parseAccount } from "./perms.js";
import { CommandRegistry, CommandRegistryKey, type Visibility } from "./registry.js";
import {
  type CardBlock,
  type CommandReply,
  cancelled,
  cardReply,
  confirm,
  notice,
  pageButtons,
  pageOf,
} from "./reply.js";
import { ArgKind, argSpec, commandSpec, type Invocation } from "./spec.js";

export { CommandRegistryKey } from "./registry.js";

/**
 * `[modules.commands]` config section.
 *
 * ```toml
 * [modules.commands]
 * owners = ["discord:123456789012345678"]
 *
 * # Who sees the replies of a command: "public" (the channel) or "private" (only the invoker).
 * # Key: a command path or a group prefix; the longest match wins over the declaration.
 * # Warnings and errors are always private.
 * [modules.commands.visibility]
 * "me wallet" = "private"
 * ```
 */
export const CommandsConfigSchema = z.object({
  /**
   * Accounts with the `owner` role, as `"platform:id"`. The one place to configure owners;
   * `[modules.auth] owners` is still read for compatibility.
   */
  owners: z.array(z.string()).default([]),
  /**
   * Link to the privacy policy, shown on `/me i` (privacy and memory pages). Without one the
   * panel says that none has been provided. Must be an `https://` URL.
   */
  privacy_policy_url: z
    .string()
    .refine((url) => /^https:\/\/\S+$/u.test(url), "must be an https:// URL")
    .nullable()
    .default(null),
  /**
   * Visibility overrides: command path (`"me wallet"`) or group prefix (`"me"`) to `"public"` /
   * `"private"`. Without an entry the command's own declaration applies. Warnings and errors
   * stay private either way.
   */
  visibility: z.record(z.string().min(1), z.enum(["public", "private"])).default({}),
});

export type CommandsConfig = z.output<typeof CommandsConfigSchema>;

export interface CommandsModuleOptions {
  /** More owners from elsewhere in the config (the app passes `[modules.auth] owners`). */
  owners?: readonly string[];
}

/**
 * Module `commands`: provides the `CommandRegistry` service and registers the built-in
 * commands (`help`, `admin module ...`) and the four panel commands (`/miyo`, `/song`,
 * `/me i`, `/admin i`; see `panels.ts`).
 *
 * The registry outlives restarts of this module, so commands other modules registered once at
 * their start stay registered. It also provides its `Permissions` as a fallback `Authorizer`
 * whenever no other module (normally `auth`) provides one, and puts it back after that module
 * stops.
 */
export class CommandsModule implements Module {
  static readonly ID = "commands";

  readonly manifest: ModuleManifest = defineManifest(CommandsModule.ID, "Commands", {
    description: "Cross-platform command framework and built-in commands",
    configSchema: CommandsConfigSchema,
  });

  readonly #extraOwners: readonly string[];
  #registry: CommandRegistry | null = null;

  constructor(options: CommandsModuleOptions = {}) {
    this.#extraOwners = [...(options.owners ?? [])];
  }

  async start(ctx: ModuleContext): Promise<void> {
    const config = ctx.config(CommandsConfigSchema);
    const owners = uniqueOwners([...config.owners, ...this.#extraOwners]);
    let registry = this.#registry;
    if (registry === null) {
      registry = new CommandRegistry(new Permissions(owners), {
        services: ctx.services,
        clock: ctx.clock,
      });
      this.#registry = registry;
    } else {
      registry.permissions().setOwners(owners);
      registry.withServices(ctx.services);
    }
    registry.setVisibility(config.visibility as Record<string, Visibility>);
    registerBuiltins(registry, ctx, { policyUrl: config.privacy_policy_url });
    if (Object.keys(config.visibility).length > 0) {
      const shown = registry;
      ctx.spawn("visibility-check", (signal) => warnUnknownVisibility(ctx, shown, signal));
    }
    ctx.provide(CommandRegistryKey, registry);
    const perms = registry.permissions();
    provideFallback(ctx, perms);

    const events = ctx.subscribe("system.module.state");
    ctx.spawn("authorizer-fallback", async () => {
      for await (const _ of events) provideFallback(ctx, perms);
    });
  }
}

/**
 * Other modules register their commands while the app boots, so the keys of the visibility
 * table are checked once the registry has been quiet for a while.
 */
async function warnUnknownVisibility(
  ctx: ModuleContext,
  registry: CommandRegistry,
  signal: AbortSignal,
): Promise<void> {
  let seen = -1;
  for (let round = 0; round < 12 && seen !== registry.version(); round++) {
    seen = registry.version();
    try {
      await sleep(VISIBILITY_QUIET_MS, signal);
    } catch {
      return; // the module stopped
    }
  }
  const unknown = registry.unknownVisibility();
  if (unknown.length > 0) {
    ctx.log.warn({ keys: unknown }, "[modules.commands.visibility] names no command, ignored");
  }
}

/** The registry counts as settled after this long without a registration. */
const VISIBILITY_QUIET_MS = 5_000;

function uniqueOwners(owners: readonly string[]): AccountRef[] {
  const out = new Map<string, AccountRef>();
  for (const raw of owners) {
    const account = parseAccount(raw);
    out.set(`${account.platform}:${account.id}`, account);
  }
  return [...out.values()];
}

function provideFallback(ctx: ModuleContext, fallback: Permissions): void {
  if (ctx.services.get(AuthorizerKey) === undefined) ctx.provide(AuthorizerKey, fallback);
}

// ---- admin module ... ----------------------------------------------------------------------

type Op = "enable" | "disable" | "restart";

const OP_LABEL: Record<Op, string> = { enable: "啟用", disable: "停用", restart: "重新啟動" };

const NODE_LIST = "admin.module.list";
const NODE_TOGGLE = "admin.module.toggle";
const NODE_RESTART = "admin.module.restart";
const PAGE_SIZE = 8;

const STATE_LABEL: Record<ModuleStatus["state"], string> = {
  disabled: "已停用",
  starting: "啟動中",
  running: "執行中",
  degraded: "降級",
  stopping: "停止中",
  stopped: "已停止",
  failed: "失敗",
};

const R = {
  page: "admin:module:page",
  restart: "admin:module:restart",
  enable: "admin:module:enable",
  disable: "admin:module:disable",
  confirmDisable: "admin:module:confirm-disable",
  cancel: "admin:module:cancel",
} as const;

/** `-` as a page parameter: the panel came from a slash command, answer with a notice. */
const NO_PAGE = "-";

/**
 * Registers `help`, `admin module list | enable | disable | restart` and the panels.
 *
 * The admin commands look up the `SupervisorKey` service when they run, so the app may provide
 * it after this module started.
 */
export function registerBuiltins(
  registry: CommandRegistry,
  ctx: { readonly services: ServiceLookup },
  options: { policyUrl?: string | null } = {},
): void {
  registerHelp(registry);
  registerPanels(registry, { services: ctx.services, policyUrl: options.policyUrl ?? null });
  const sup = () => ctx.services.get(SupervisorKey);
  const suggest = (inv: Invocation, value: string) => moduleChoices(sup(), inv, value);

  registry.register(
    commandSpec("admin module list", "列出她的所有模組與狀態", {
      permission: NODE_LIST,
      ephemeral: true,
    }),
    () => {
      const s = sup();
      return s ? moduleList(s, 0) : noSupervisor();
    },
    { components: listRoutes(sup) },
  );

  const idArg = () => argSpec("id", "模組 id，例如 llm", ArgKind.string);
  registry.register(
    commandSpec("admin module enable", "啟用一個模組", {
      args: [idArg()],
      permission: NODE_TOGGLE,
      ephemeral: true,
    }),
    async (inv) => {
      const s = sup();
      return s ? await runOp(s, "enable", moduleArg(inv)) : noSupervisor();
    },
    { autocomplete: { id: suggest } },
  );
  registry.register(
    commandSpec("admin module disable", "停用一個模組（依賴它的模組也會停止）", {
      args: [idArg()],
      permission: NODE_TOGGLE,
      ephemeral: true,
    }),
    (inv) => {
      const s = sup();
      return s ? confirmDisable(s, moduleArg(inv), NO_PAGE) : noSupervisor();
    },
    { autocomplete: { id: suggest } },
  );
  registry.register(
    commandSpec("admin module restart", "重新啟動一個模組", {
      args: [idArg()],
      permission: NODE_RESTART,
      ephemeral: true,
    }),
    async (inv) => {
      const s = sup();
      return s ? await runOp(s, "restart", moduleArg(inv)) : noSupervisor();
    },
    { autocomplete: { id: suggest } },
  );
}

function moduleArg(inv: Invocation): ModuleId {
  return (inv.str("id") ?? "").trim();
}

function moduleChoices(sup: Supervisor | undefined, _inv: Invocation, value: string): Choice[] {
  if (!sup) return [];
  const q = value.trim().toLowerCase();
  return sup
    .list()
    .filter((m) => q === "" || m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q))
    .map((m) => ({ name: `${m.id}（${STATE_LABEL[m.state]}）`, value: m.id }));
}

function pageParam(raw: string | undefined): number | typeof NO_PAGE | null {
  if (raw === NO_PAGE) return NO_PAGE;
  return intParam(raw);
}

function listRoutes(sup: () => Supervisor | undefined): AnyComponentRoute[] {
  const withSup = (
    body: (s: Supervisor) => Promise<ComponentResult> | ComponentResult,
  ): Promise<ComponentResult> | ComponentResult => {
    const s = sup();
    return s ? body(s) : ComponentResult.reply(noSupervisor());
  };
  return [
    { route: R.cancel, handle: () => ComponentResult.update(cancelled()) },
    defineRoute<number>({
      route: R.page,
      parse: (p) => intParam(p[0]),
      handle: (_inv, page) => withSup((s) => ComponentResult.update(moduleList(s, page))),
    }),
    defineRoute<{ id: string; page: number }>({
      route: R.restart,
      permission: NODE_RESTART,
      parse: (p) => idAndPage(p),
      handle: (_inv, { id, page }) =>
        withSup(async (s) => afterOp(s, await runOp(s, "restart", id), page)),
    }),
    defineRoute<{ id: string; page: number }>({
      route: R.enable,
      permission: NODE_TOGGLE,
      parse: (p) => idAndPage(p),
      handle: (_inv, { id, page }) =>
        withSup(async (s) => afterOp(s, await runOp(s, "enable", id), page)),
    }),
    defineRoute<number>({
      route: R.disable,
      permission: NODE_TOGGLE,
      parse: (p) => intParam(p[0]),
      handle: (inv: ComponentInvocation, page) =>
        withSup((s) => {
          const id = inv.values[0];
          if (id === undefined) return ComponentResult.update(moduleList(s, page));
          return ComponentResult.update(confirmDisable(s, id, String(page)));
        }),
    }),
    defineRoute<{ id: string; page: number | typeof NO_PAGE }>({
      route: R.confirmDisable,
      permission: NODE_TOGGLE,
      parse: (p) => {
        const page = pageParam(p[1]);
        return p[0] && page !== null ? { id: p[0], page } : null;
      },
      handle: (_inv, { id, page }) =>
        withSup(async (s) => {
          const reply = await runOp(s, "disable", id);
          if (page === NO_PAGE) return ComponentResult.update(reply);
          return afterOp(s, reply, page);
        }),
    }),
  ];
}

function idAndPage(params: readonly string[]): { id: string; page: number } | null {
  const page = intParam(params[1]);
  return params[0] && page !== null ? { id: params[0], page } : null;
}

/** After a list action: errors are their own (ephemeral) message, success refreshes the list. */
function afterOp(sup: Supervisor, reply: CommandReply, page: number): ComponentResult {
  if (reply.tone === "error" || reply.tone === "warn") return ComponentResult.reply(reply);
  const list = moduleList(sup, page);
  const card = list.card;
  if (card) card.blocks.unshift({ type: "muted", text: reply.text }, { type: "separator" });
  return ComponentResult.update({ ...list, text: `${reply.text}\n${list.text}` });
}

function confirmDisable(sup: Supervisor, id: ModuleId, page: string): CommandReply {
  if (id === "commands") return refuseCommandsDisable();
  const status = sup.list().find((m) => m.id === id);
  if (!status) return notice("warn", `找不到模組 ${code(id)}。`);
  return confirm({
    title: "停用模組",
    text: `確定要停用 ${code(id)} 嗎？依賴它的模組也會一起停止，直到重新啟用為止。`,
    confirmId: componentId(R.confirmDisable, id, page),
    cancelId: page === NO_PAGE ? componentId(R.cancel) : componentId(R.page, page),
    confirmLabel: "停用",
  });
}

function refuseCommandsDisable(): CommandReply {
  return notice(
    "warn",
    "無法從聊天平台停用 commands 模組，否則所有指令都會失效。",
    "請改用 CLI（miyoria module disable commands）或管理面板。",
  );
}

/** The paged module list with a restart / enable button per module and a disable select. */
export function moduleList(sup: Supervisor, page: number): CommandReply {
  const modules = sup.list();
  if (modules.length === 0) return notice("info", "目前沒有任何模組。");
  const view = pageOf(modules, page, PAGE_SIZE);
  const blocks: CardBlock[] = [];
  for (const m of view.items) {
    let text = `\`${m.id}\` ${m.name}　${STATE_LABEL[m.state]}`;
    const extra: string[] = [];
    if (m.recent_restarts > 0) extra.push(`最近重啟 ${m.recent_restarts} 次`);
    if (m.reason !== null) extra.push(m.reason);
    if (extra.length > 0) text += `\n-# ${extra.join("；")}`;
    blocks.push({
      type: "section",
      text,
      button: m.enabled
        ? { id: componentId(R.restart, m.id, view.page), label: "重新啟動", style: "secondary" }
        : { id: componentId(R.enable, m.id, view.page), label: "啟用", style: "success" },
    });
  }
  const disableable = view.items.filter((m) => m.enabled && m.id !== "commands");
  if (disableable.length > 0) {
    blocks.push({ type: "separator" });
    blocks.push({
      type: "select",
      select: {
        id: componentId(R.disable, view.page),
        placeholder: "停用模組…",
        options: disableable.map((m) => ({ label: m.id, value: m.id, description: m.name })),
      },
    });
  }
  blocks.push(...pageButtons(view, (p) => componentId(R.page, p)));
  return cardReply(blocks, {
    title: `模組（${modules.length}）`,
    accent: "neutral",
    session: {},
  });
}

async function runOp(sup: Supervisor, op: Op, id: ModuleId): Promise<CommandReply> {
  if (id === "") return notice("warn", "請指定模組 id。");
  if (op === "disable" && id === CommandsModule.ID) return refuseCommandsDisable();
  try {
    await sup[op](id);
  } catch (error) {
    return notice("error", `無法${OP_LABEL[op]}模組 ${code(id)}。`, errorMessage(error));
  }
  return notice("success", `已${OP_LABEL[op]}模組 ${code(id)}。`);
}

/** An identifier shown as inline code. */
function code(id: string): string {
  return `\`${id}\``;
}

function noSupervisor(): CommandReply {
  return notice("error", "目前無法管理模組。", "找不到 supervisor 服務。");
}

/** One line per module: `` `id` 名稱：狀態，最近重啟 N 次（原因） ``. */
export function formatModuleList(modules: readonly ModuleStatus[]): string {
  if (modules.length === 0) return "目前沒有任何模組。";
  let out = "模組狀態：";
  for (const m of modules) {
    out += `\n\`${m.id}\` ${m.name}：${STATE_LABEL[m.state]}`;
    if (m.recent_restarts > 0) out += `，最近重啟 ${m.recent_restarts} 次`;
    if (m.reason !== null) out += `（${m.reason}）`;
  }
  return out;
}
