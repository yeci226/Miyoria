// Panels: one message that holds a whole feature's controls.
//
// A panel command (`/miyo`, `/song`, `/me i`, `/admin i`) answers with a card that has a page
// selector, status lines and the controls of the current page. Every control runs an existing
// command (its `path`) through the registry, so permission nodes, argument checks, auditing and
// replies stay where the feature put them. A control is shown only when the command exists and
// the invoker's node allows it; the same checks run again when it is pressed, because component
// ids can be forged.
//
// A panel is public or private like any command (`CommandSpec.ephemeral`, overridable in the
// configuration). A private panel is the invoker's own message. A public one is shared: anyone
// in the channel can press it, and a press always runs as the presser with the presser's own
// permissions. What the shared message shows never depends on private data: status lines of
// private commands are left out, and answers of private commands (and any press by someone
// other than the opener) are ephemeral messages to the presser, never written into it.
//
// Controls:
//
// - a button runs the command, or opens a modal for its arguments first;
// - a choice select offers the choices of one argument and runs the command with the pick;
// - `confirm` puts a red confirm card in front.
//
// Answers: failures are ephemeral notices; a plain success notice is written into the panel
// itself; a rich answer (a list, a file, a card with controls) is a message of its own, public
// when the command declares itself public. Replies from the commands are system text, never
// her voice.
//
// Component ids: `mi:<command>:<route>:<page>:<action>:<target>`; `target` is the person the
// panel is focused on (`-` for none).

import { createHash } from "node:crypto";
import { errorMessage, getLogger, type ServiceLookup, withTimeout } from "@miyoria/kernel";
import {
  type AnyComponentRoute,
  ComponentInvocation,
  ComponentResult,
  componentId,
  defineRoute,
} from "./components.js";
import { UserResolverKey } from "./direct.js";
import type { CommandRegistry } from "./registry.js";
import {
  type ButtonStyle,
  type CardBlock,
  type CardButton,
  type CommandReply,
  cardReply,
  confirm,
  notice,
} from "./reply.js";
import {
  type ArgValue,
  type CommandSpec,
  type Invocation,
  type InvocationData,
  type ResolvedUser,
  splitPath,
} from "./spec.js";

const log = getLogger("commands.panel");

/** How long a status line may take before the panel shows it as unavailable. */
export const STATUS_TIMEOUT_MS = 2_500;
const STATUS_MAX_CHARS = 700;
/** No target in a component id. */
const NO_TARGET = "-";

/** A modal text field that fills one argument of the command. */
export interface FieldAsk {
  /** Argument name of the command; also the field id. */
  arg: string;
  label: string;
  style?: "short" | "paragraph";
  placeholder?: string;
  /** Default: the command's own `required`. */
  required?: boolean;
  maxLength?: number;
}

export interface PanelAction {
  /** Unique within the panel; `[a-z0-9-]`. */
  id: string;
  label: string;
  /** The command this control runs, e.g. `"voice join"`. */
  path: string;
  style?: ButtonStyle;
  /** Fixed arguments. */
  args?: Record<string, ArgValue>;
  /** Ask for arguments in a modal first. */
  ask?: { title: string; fields: FieldAsk[] };
  /** A select with the choices of this argument (the label of each value comes from `labels`). */
  choice?: { arg: string; placeholder: string; labels?: Readonly<Record<string, string>> };
  /** Ask before running (red confirm card). */
  confirm?: string;
  /**
   * The argument that names the person the panel is focused on. Without a focus the control is
   * hidden; a modal field for the argument starts out filled with the focus.
   */
  target?: string;
}

export interface StatusLine {
  /** A view command (no side effects) whose answer is shown on the page. */
  path: string;
  label: string;
  args?: Record<string, ArgValue>;
}

export interface PanelPage {
  /** `[a-z0-9-]`. */
  id: string;
  label: string;
  /** One line in the page selector. */
  description: string;
  intro?: readonly string[];
  status?: readonly StatusLine[];
  actions: readonly PanelAction[];
  /** Show the page even when none of its controls is available to the invoker. */
  alwaysVisible?: boolean;
  /** Add a refresh button. */
  refresh?: boolean;
  /** The page works on a person: show a control to pick one. */
  focusable?: boolean;
  /** Extra blocks after the controls (links, hints). */
  extra?: (view: PanelView) => CardBlock[];
}

export interface PanelDef {
  /** The slash command: one lowercase word. */
  command: string;
  title: string;
  description: string;
  pages: readonly PanelPage[];
  /** The command's own arguments (e.g. `/admin i user:`). */
  args?: CommandSpec["args"];
  permission?: string;
  /** `true` = the panel is private to whoever opens it. Default `false` (public). */
  ephemeral?: boolean;
  /** Where a call with these arguments starts. */
  open?: (inv: Invocation) => Promise<PanelStart> | PanelStart;
  /** Lists commands no page has a control for, as a page of its own. */
  rest?: { id: string; label: string; description: string };
}

export interface PanelStart {
  page?: string;
  target?: string | null;
  note?: string | null;
}

/** What a page render knows. */
export interface PanelView {
  registry: CommandRegistry;
  inv: Invocation;
  target: string | null;
}

interface Usable {
  action: PanelAction;
  spec: CommandSpec;
}

interface PageState {
  page: PanelPage;
  usable: Usable[];
}

// ---- running commands ---------------------------------------------------------------------

const REFUSE_UNRESOLVED = notice(
  "warn",
  "無法確認對方的身分組，操作已取消。",
  "請稍後再試，或確認她看得到對方。",
);

/**
 * Runs the command `path` for the invoker of `inv`, as if they had typed it. Commands that take
 * a person other than the invoker get that person's roles from the platform first; when that
 * fails the call is refused, because rank checks would otherwise treat the person as a plain
 * member.
 */
export async function runCommand(
  registry: CommandRegistry,
  services: ServiceLookup | null,
  inv: Invocation,
  path: string,
  args: Record<string, ArgValue>,
  /** `audit: false` for a read the panel makes by itself (see `DispatchIo.audit`). */
  options: { audit?: boolean } = {},
): Promise<CommandReply> {
  const words = splitPath(path);
  const spec = registry.get(words);
  const resolved: Record<string, ResolvedUser> = { ...inv.resolved_users };
  if (spec) {
    const others = spec.args
      .filter((a) => a.kind.type === "user")
      .map((a) => args[a.name])
      .filter((v): v is string => typeof v === "string" && v !== "")
      .map((v) => mentionedId(v))
      .filter((id) => id !== inv.invoker.id);
    const missing = others.filter((id) => !Object.hasOwn(resolved, id));
    if (missing.length > 0 && inv.context.scope !== null) {
      const resolver = services?.get(UserResolverKey);
      try {
        const found = resolver ? await resolver.resolveUsers(inv.context, missing) : {};
        Object.assign(resolved, found);
      } catch (error) {
        log.warn({ path, error: errorMessage(error) }, "cannot resolve users for a panel action");
      }
      if (missing.some((id) => !Object.hasOwn(resolved, id))) return REFUSE_UNRESOLVED;
    }
  }
  const data: InvocationData = {
    path: words,
    args,
    invoker: inv.invoker,
    invoker_display_name: inv.invoker_display_name,
    context: inv.context,
    invoker_is_guild_admin: inv.invoker_is_guild_admin,
    platform_roles: inv.platform_roles,
    resolved_users: resolved,
  };
  return registry.dispatch(data, {
    ...(inv.canFollowUp() ? { followUp: (reply: CommandReply) => inv.followUp(reply) } : {}),
    ...(options.audit === false ? { audit: false } : {}),
  });
}

/** `<@123>` / `<@!123>` / `123` → `123`. */
function mentionedId(raw: string): string {
  const match = /^<@!?(\d+)>$/u.exec(raw.trim());
  return match?.[1] ?? raw.trim();
}

// ---- views --------------------------------------------------------------------------------

function memo(inv: Invocation): (node: string) => Promise<boolean> {
  const cache = new Map<string, Promise<boolean>>();
  return (node) => {
    if (node === "") return Promise.resolve(true);
    let hit = cache.get(node);
    if (!hit) {
      hit = inv.allowed(node);
      cache.set(node, hit);
    }
    return hit;
  };
}

async function usableActions(
  view: PanelView,
  page: PanelPage,
  allowed: (node: string) => Promise<boolean>,
): Promise<Usable[]> {
  const out: Usable[] = [];
  for (const action of page.actions) {
    if (action.target !== undefined && view.target === null && action.ask === undefined) continue;
    const spec = view.registry.get(splitPath(action.path));
    if (!spec || !(await allowed(spec.permission))) continue;
    out.push({ action, spec });
  }
  return out;
}

function clip(text: string, max: number): string {
  const chars = [...text.trim()];
  return chars.length <= max ? chars.join("") : `${chars.slice(0, max - 1).join("")}…`;
}

async function statusBlock(
  view: PanelView,
  services: ServiceLookup | null,
  line: StatusLine,
  allowed: (node: string) => Promise<boolean>,
  shared: boolean,
): Promise<CardBlock | null> {
  const spec = view.registry.get(splitPath(line.path));
  if (!spec || !(await allowed(spec.permission))) return null;
  // A shared message is read by everyone: only what the channel may see goes into it.
  if (shared && spec.ephemeral) return null;
  const reply = await withTimeout(
    // Drawing a page is not something anyone did: no audit entry per refresh.
    runCommand(
      view.registry,
      services,
      view.inv,
      line.path,
      { ...line.args },
      { audit: false },
    ).catch((error: unknown) => {
      log.debug({ path: line.path, error: errorMessage(error) }, "status line failed");
      return null;
    }),
    STATUS_TIMEOUT_MS,
  );
  if (reply === undefined) return { type: "muted", text: `${line.label}：讀取逾時` };
  if (reply === null || reply.tone === "warn" || reply.tone === "error") return null;
  return { type: "text", text: `**${line.label}**\n${clip(reply.text, STATUS_MAX_CHARS)}` };
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** The pages the invoker can use, each with its usable controls. */
async function pageStates(
  def: PanelDef,
  view: PanelView,
  allowed: (node: string) => Promise<boolean>,
): Promise<PageState[]> {
  const out: PageState[] = [];
  for (const page of def.pages) {
    const usable = await usableActions(view, page, allowed);
    if (usable.length > 0 || page.alwaysVisible) out.push({ page, usable });
  }
  return out;
}

// ---- the runner page (commands without a control) ---------------------------------------

/** Short stable key of a command path, for component ids (paths may hold any letters). */
export function pathKey(path: string): string {
  return createHash("sha1").update(splitPath(path).join(" ")).digest("hex").slice(0, 12);
}

const MAX_RUNNER = 25;

async function restCommands(view: PanelView, mapped: ReadonlySet<string>): Promise<CommandSpec[]> {
  const permitted = await view.registry.permitted(view.inv);
  return permitted.filter((s) => !mapped.has(s.path.join(" ")));
}

/** A modal for the arguments of a command that has no control on any page. */
function restModal(spec: CommandSpec, id: string) {
  const args = spec.args.slice(0, 5).map((a) => ({
    id: a.name,
    label: a.name,
    placeholder: [
      a.description,
      a.kind.type === "choice" ? `（${a.kind.choices.join(" / ")}）` : "",
    ]
      .join("")
      .slice(0, 100),
    required: a.required,
  }));
  return { id, title: `/${spec.path.join(" ")}`.slice(0, 45), fields: args };
}

// ---- rendering ----------------------------------------------------------------------------

export interface PanelOptions {
  services: ServiceLookup | null;
  /** Command paths other panels have controls for, so the runner page leaves them out. */
  mapped: ReadonlySet<string>;
}

interface PanelRoutes {
  page: string;
  focus: string;
  do: string;
  pdo: string;
  ask: string;
  pask: string;
  sel: string;
  psel: string;
  yes: string;
  pyes: string;
  more: string;
  moreAsk: string;
}

/** Everything a panel does, built once per registration. */
class Panel {
  readonly routes: PanelRoutes;

  constructor(
    readonly def: PanelDef,
    readonly registry: CommandRegistry,
    readonly options: PanelOptions,
  ) {
    const c = def.command;
    this.routes = {
      page: `${c}:page`,
      focus: `${c}:focus`,
      do: `${c}:do`,
      pdo: `${c}:pdo`,
      ask: `${c}:ask`,
      pask: `${c}:pask`,
      sel: `${c}:sel`,
      psel: `${c}:psel`,
      yes: `${c}:yes`,
      pyes: `${c}:pyes`,
      more: `${c}:more`,
      moreAsk: `${c}:moreask`,
    };
  }

  #id(route: string, page: string, action: string, target: string | null): string {
    return componentId(route, page, action, target ?? NO_TARGET);
  }

  /** Whether the panel itself is a public command. */
  #panelPublic(): boolean {
    const spec = this.registry.panelSpec(this.def.command);
    return spec !== undefined && !spec.ephemeral;
  }

  /**
   * `true` when the command answers the channel, not just the invoker. A private panel keeps
   * everything private: it is the invoker's own space.
   */
  #public(spec: CommandSpec): boolean {
    return this.#panelPublic() && !spec.ephemeral;
  }

  /**
   * Whether the message this view is drawn into is shared with the channel: a public panel
   * seen by its opener. Opening a panel asks the registry; a press reads the session (a public
   * panel's session is not initiator-only). Anyone else gets a private copy.
   */
  #shared(inv: Invocation): boolean {
    if (inv instanceof ComponentInvocation) {
      const session = inv.session;
      return (
        session !== null && !session.initiator_only && sameAccount(session.initiator, inv.invoker)
      );
    }
    return this.#panelPublic();
  }

  /** Replaces the panel message, unless it is not the presser's: then a private copy. */
  #update(inv: ComponentInvocation, reply: CommandReply): ComponentResult {
    const session = inv.session;
    if (session !== null && !sameAccount(session.initiator, inv.invoker)) {
      return ComponentResult.reply({ ...reply, ephemeral: true });
    }
    return ComponentResult.update(reply);
  }

  async render(
    inv: Invocation,
    pageId: string | null,
    target: string | null,
    note: string | null = null,
  ): Promise<CommandReply> {
    const view: PanelView = { registry: this.registry, inv, target };
    const allowed = memo(inv);
    const shared = this.#shared(inv);
    const states = await pageStates(this.def, view, allowed);
    const rest = this.def.rest ? await restCommands(view, this.options.mapped) : [];
    const restVisible = this.def.rest !== undefined && rest.length > 0;
    if (states.length === 0 && !restVisible) {
      return notice("warn", "你沒有可以使用的項目。", "需要的權限由管理者設定。");
    }
    const isRest = restVisible && pageId === this.def.rest?.id;
    const current = isRest ? null : (states.find((s) => s.page.id === pageId) ?? states[0] ?? null);
    const blocks: CardBlock[] = [];
    if (note) blocks.push({ type: "text", text: note }, { type: "separator" });

    if (current) {
      const { page, usable } = current;
      blocks.push({ type: "text", text: `**${page.label}**　${page.description}` });
      if (page.intro && page.intro.length > 0) {
        blocks.push({ type: "muted", text: page.intro.join("\n") });
      }
      if (page.focusable) blocks.push(...this.#focusBlocks(page, target));
      const lines = await Promise.all(
        (page.status ?? []).map((line) =>
          statusBlock(view, this.options.services, line, allowed, shared),
        ),
      );
      for (const line of lines) if (line) blocks.push(line);
      blocks.push(...this.#controls(page, usable, target));
      if (page.extra) blocks.push(...page.extra(view));
    } else if (this.def.rest) {
      blocks.push(...this.#restBlocks(rest));
    }

    const options = [
      ...states.map((s) => ({
        label: s.page.label,
        value: s.page.id,
        description: s.page.description,
        default: s.page.id === current?.page.id,
      })),
      ...(restVisible && this.def.rest
        ? [
            {
              label: this.def.rest.label,
              value: this.def.rest.id,
              description: this.def.rest.description,
              default: isRest,
            },
          ]
        : []),
    ];
    if (options.length > 1) {
      blocks.push({ type: "separator" });
      blocks.push({
        type: "select",
        select: {
          id: componentId(this.routes.page, NO_TARGET, target ?? NO_TARGET),
          placeholder: "切換分類",
          options,
        },
      });
    }
    // A shared panel is open to everyone's presses; a private one only to its opener.
    return cardReply(blocks, {
      title: this.def.title,
      accent: "neutral",
      session: { initiatorOnly: !shared },
    });
  }

  #focusBlocks(page: PanelPage, target: string | null): CardBlock[] {
    const who = target === null ? "尚未指定對象" : `目前對象：<@${target}>`;
    return [
      {
        type: "section",
        text: who,
        button: {
          id: this.#id(this.routes.do, page.id, "focus", target),
          label: target === null ? "指定對象" : "換一個對象",
          style: "secondary",
        },
      },
    ];
  }

  #controls(page: PanelPage, usable: readonly Usable[], target: string | null): CardBlock[] {
    const blocks: CardBlock[] = [];
    const buttons: CardButton[] = [];
    const selects: CardBlock[] = [];
    for (const { action, spec } of usable) {
      if (action.choice) {
        selects.push(this.#choiceSelect(page, action, spec, target));
        continue;
      }
      const route = this.#public(spec) ? this.routes.pdo : this.routes.do;
      buttons.push({
        id: this.#id(route, page.id, action.id, target),
        label: action.label,
        style: action.style ?? "secondary",
      });
    }
    if (page.refresh) {
      buttons.push({
        id: componentId(this.routes.page, page.id, target ?? NO_TARGET),
        label: "重新整理",
        style: "secondary",
      });
    }
    if (buttons.length > 0 || selects.length > 0) blocks.push({ type: "separator" });
    for (const row of chunk(buttons, 5)) blocks.push({ type: "buttons", buttons: row });
    blocks.push(...selects);
    return blocks;
  }

  #choiceSelect(
    page: PanelPage,
    action: PanelAction,
    spec: CommandSpec,
    target: string | null,
  ): CardBlock {
    const choice = action.choice as NonNullable<PanelAction["choice"]>;
    const arg = spec.args.find((a) => a.name === choice.arg);
    const values = arg?.kind.type === "choice" ? arg.kind.choices : [];
    return {
      type: "select",
      select: {
        id: this.#id(
          this.#public(spec) ? this.routes.psel : this.routes.sel,
          page.id,
          action.id,
          target,
        ),
        placeholder: choice.placeholder,
        options: values.map((v) => ({ label: choice.labels?.[v] ?? v, value: v })),
      },
    };
  }

  #restBlocks(rest: readonly CommandSpec[]): CardBlock[] {
    const meta = this.def.rest as NonNullable<PanelDef["rest"]>;
    const shown = rest.slice(0, MAX_RUNNER);
    const blocks: CardBlock[] = [{ type: "text", text: `**${meta.label}**　${meta.description}` }];
    if (rest.length > shown.length) {
      blocks.push({ type: "muted", text: `還有 ${rest.length - shown.length} 個沒有列出。` });
    }
    blocks.push({
      type: "select",
      select: {
        id: componentId(this.routes.more),
        placeholder: "選擇指令…",
        options: shown.map((s) => ({
          label: `/${s.path.join(" ")}`,
          value: s.path.join(" "),
          description: s.description,
        })),
      },
    });
    return blocks;
  }

  // ---- interactions ------------------------------------------------------------------

  /** The reply of a finished action: into the panel, or a message of its own. */
  async #finish(
    inv: ComponentInvocation,
    reply: CommandReply,
    page: string,
    target: string | null,
    isPublic: boolean,
  ): Promise<ComponentResult> {
    if (reply.tone === "warn" || reply.tone === "error") return ComponentResult.reply(reply);
    // Into the panel only when the panel is the presser's own private message.
    if (isPublic || !plain(reply) || this.#shared(inv)) return ComponentResult.reply(reply);
    return this.#update(inv, await this.render(inv, page, target, reply.text));
  }

  #find(pageId: string, actionId: string): { page: PanelPage; action: PanelAction } | null {
    const page = this.def.pages.find((p) => p.id === pageId);
    const action = page?.actions.find((a) => a.id === actionId);
    return page && action ? { page, action } : null;
  }

  /** Revalidates a control: the command exists and the invoker may run it. */
  async #check(inv: ComponentInvocation, action: PanelAction): Promise<CommandSpec | null> {
    const spec = this.registry.get(splitPath(action.path));
    if (!spec) return null;
    return (await memo(inv)(spec.permission)) ? spec : null;
  }

  #args(action: PanelAction, target: string | null): Record<string, ArgValue> | null {
    const args: Record<string, ArgValue> = { ...action.args };
    if (action.target !== undefined && action.ask === undefined) {
      if (target === null) return null;
      args[action.target] = target;
    }
    return args;
  }

  routesList(): AnyComponentRoute[] {
    const R = this.routes;
    const parseRef = (p: readonly string[]) => {
      const [page, action, target] = p;
      if (!page || !action) return null;
      const t = target === undefined || target === NO_TARGET ? null : target;
      return { page, action, target: t };
    };
    type Ref = NonNullable<ReturnType<typeof parseRef>>;
    const common = { requiresSession: true } as const;

    const press = (isPublic: boolean) =>
      defineRoute<Ref>({
        route: isPublic ? R.pdo : R.do,
        ...common,
        ephemeral: !isPublic,
        parse: parseRef,
        handle: async (inv, ref) => this.#press(inv, ref, isPublic),
      });
    const submit = (isPublic: boolean) =>
      defineRoute<Ref>({
        route: isPublic ? R.pask : R.ask,
        ...common,
        ephemeral: !isPublic,
        parse: parseRef,
        handle: async (inv, ref) => this.#submit(inv, ref, isPublic),
      });
    const accept = (isPublic: boolean) =>
      defineRoute<Ref>({
        route: isPublic ? R.pyes : R.yes,
        ...common,
        ephemeral: !isPublic,
        parse: parseRef,
        handle: async (inv, ref) => this.#run(inv, ref, {}, isPublic),
      });

    const choose = (isPublic: boolean) =>
      defineRoute<Ref>({
        route: isPublic ? R.psel : R.sel,
        ...common,
        ephemeral: !isPublic,
        parse: parseRef,
        handle: async (inv, ref) => {
          const found = this.#find(ref.page, ref.action);
          const value = inv.values[0];
          if (!found?.action.choice || value === undefined) {
            return ComponentResult.reply(notice("error", "控制項資料無效。"));
          }
          return this.#run(inv, ref, { [found.action.choice.arg]: value }, isPublic);
        },
      });

    return [
      defineRoute<{ page: string | null; target: string | null }>({
        route: R.page,
        ...common,
        parse: (p) => ({
          page: p[0] === undefined || p[0] === NO_TARGET ? null : p[0],
          target: p[1] === undefined || p[1] === NO_TARGET ? null : p[1],
        }),
        handle: async (inv, { page, target }) =>
          this.#update(inv, await this.render(inv, page ?? inv.values[0] ?? null, target)),
      }),
      press(false),
      press(true),
      submit(false),
      submit(true),
      accept(false),
      accept(true),
      choose(false),
      choose(true),
      defineRoute<Ref>({
        route: R.focus,
        ...common,
        ephemeral: true,
        parse: parseRef,
        handle: async (inv, ref) => {
          const raw = inv.field("user");
          const id = mentionedId(raw);
          if (!/^[A-Za-z0-9_.@-]{1,40}$/u.test(id) || id === NO_TARGET) {
            return ComponentResult.reply(notice("warn", "請輸入對方的使用者 ID 或 @提及。"));
          }
          return this.#update(inv, await this.render(inv, ref.page, id));
        },
      }),
      ...(this.def.rest ? this.#restRoutes() : []),
    ];
  }

  async #press(
    inv: ComponentInvocation,
    ref: { page: string; action: string; target: string | null },
    isPublic: boolean,
  ): Promise<ComponentResult> {
    if (ref.action === "focus") {
      return ComponentResult.modal({
        id: this.#id(this.routes.focus, ref.page, "focus", ref.target),
        title: "指定對象",
        fields: [
          {
            id: "user",
            label: "使用者 ID 或 @提及",
            placeholder: "開啟開發者模式後，對使用者按右鍵複製 ID",
            ...(ref.target ? { value: ref.target } : {}),
          },
        ],
      });
    }
    const found = this.#find(ref.page, ref.action);
    if (!found) return ComponentResult.reply(notice("warn", "這個控制項已失效，請重新開啟面板。"));
    const { action } = found;
    const spec = await this.#check(inv, action);
    if (!spec) return ComponentResult.reply(notice("error", "你不能進行這個操作。"));
    if (action.ask) {
      const route = isPublic ? this.routes.pask : this.routes.ask;
      return ComponentResult.modal({
        id: this.#id(route, ref.page, ref.action, ref.target),
        title: action.ask.title,
        fields: action.ask.fields.map((f) => {
          const arg = spec.args.find((a) => a.name === f.arg);
          return {
            id: f.arg,
            label: f.label,
            ...(f.style ? { style: f.style } : {}),
            ...(f.placeholder ? { placeholder: f.placeholder } : {}),
            required: f.required ?? arg?.required ?? true,
            ...(f.maxLength ? { maxLength: f.maxLength } : {}),
            ...(action.target === f.arg && ref.target ? { value: ref.target } : {}),
          };
        }),
      });
    }
    if (action.confirm) {
      const route = isPublic ? this.routes.pyes : this.routes.yes;
      const card = confirm({
        title: action.label,
        text: action.confirm,
        confirmId: this.#id(route, ref.page, ref.action, ref.target),
        cancelId: componentId(this.routes.page, ref.page, ref.target ?? NO_TARGET),
        confirmLabel: action.label,
      });
      // The confirm card is for the presser alone: never over a shared panel.
      return this.#shared(inv) ? ComponentResult.reply(card) : this.#update(inv, card);
    }
    return this.#run(inv, ref, {}, isPublic);
  }

  async #submit(
    inv: ComponentInvocation,
    ref: { page: string; action: string; target: string | null },
    isPublic: boolean,
  ): Promise<ComponentResult> {
    const found = this.#find(ref.page, ref.action);
    if (!found?.action.ask) return ComponentResult.reply(notice("error", "控制項資料無效。"));
    const extra: Record<string, ArgValue> = {};
    for (const field of found.action.ask.fields) {
      const value = inv.field(field.arg);
      if (value !== "") extra[field.arg] = value;
    }
    return this.#run(inv, ref, extra, isPublic);
  }

  async #run(
    inv: ComponentInvocation,
    ref: { page: string; action: string; target: string | null },
    extra: Record<string, ArgValue>,
    isPublic: boolean,
  ): Promise<ComponentResult> {
    const found = this.#find(ref.page, ref.action);
    if (!found) return ComponentResult.reply(notice("warn", "這個控制項已失效，請重新開啟面板。"));
    const { action } = found;
    const spec = await this.#check(inv, action);
    if (!spec) return ComponentResult.reply(notice("error", "你不能進行這個操作。"));
    const args = this.#args(action, ref.target);
    if (args === null) return ComponentResult.reply(notice("warn", "請先指定對象。"));
    const reply = await runCommand(this.registry, this.options.services, inv, action.path, {
      ...args,
      ...extra,
    });
    return this.#finish(inv, reply, ref.page, ref.target, isPublic && this.#public(spec));
  }

  #restRoutes(): AnyComponentRoute[] {
    const R = this.routes;
    const rest = this.def.rest as NonNullable<PanelDef["rest"]>;
    const resolve = async (inv: ComponentInvocation, key: string) => {
      const view: PanelView = { registry: this.registry, inv, target: null };
      const specs = await restCommands(view, this.options.mapped);
      return specs.find((s) => pathKey(s.path.join(" ")) === key) ?? null;
    };
    return [
      defineRoute<readonly string[]>({
        route: R.more,
        requiresSession: true,
        ephemeral: true,
        handle: async (inv) => {
          const view: PanelView = { registry: this.registry, inv, target: null };
          const path = inv.values[0];
          const spec = (await restCommands(view, this.options.mapped)).find(
            (s) => s.path.join(" ") === path,
          );
          if (!spec) return ComponentResult.reply(notice("warn", "找不到這個指令。"));
          if (spec.args.length === 0) {
            const reply = await runCommand(
              this.registry,
              this.options.services,
              inv,
              spec.path.join(" "),
              {},
            );
            return this.#finish(inv, reply, rest.id, null, this.#public(spec));
          }
          return ComponentResult.modal(
            restModal(spec, componentId(R.moreAsk, pathKey(spec.path.join(" ")))),
          );
        },
      }),
      defineRoute<string>({
        route: R.moreAsk,
        requiresSession: true,
        ephemeral: true,
        parse: (p) => p[0] ?? null,
        handle: async (inv, key) => {
          const spec = await resolve(inv, key);
          if (!spec) return ComponentResult.reply(notice("warn", "找不到這個指令。"));
          const args: Record<string, ArgValue> = {};
          for (const arg of spec.args.slice(0, 5)) {
            const value = inv.field(arg.name);
            if (value !== "") args[arg.name] = value;
          }
          const reply = await runCommand(
            this.registry,
            this.options.services,
            inv,
            spec.path.join(" "),
            args,
          );
          return this.#finish(inv, reply, rest.id, null, this.#public(spec));
        },
      }),
    ];
  }
}

function sameAccount(a: { platform: string; id: string }, b: { platform: string; id: string }) {
  return a.platform === b.platform && a.id === b.id;
}

/** A success / info notice with nothing to press: it fits into the panel as a line. */
function plain(reply: CommandReply): boolean {
  if (!reply.card || reply.files || reply.session) return false;
  return reply.card.blocks.every((b) => b.type === "text" || b.type === "muted");
}

/**
 * Registers the panel command `def.command` with its routes. The panel is open to every member
 * (`permission` ""): what it shows follows the presser's permission nodes.
 */
export function registerPanelCommand(
  registry: CommandRegistry,
  def: PanelDef,
  options: PanelOptions,
): void {
  const panel = new Panel(def, registry, options);
  const spec: CommandSpec = {
    path: [def.command],
    description: def.description,
    args: [...(def.args ?? [])],
    permission: def.permission ?? "",
    ephemeral: def.ephemeral ?? false,
  };
  registry.registerPanel(
    spec,
    async (inv) => {
      const start = (await def.open?.(inv)) ?? {};
      return panel.render(inv, start.page ?? null, start.target ?? null, start.note ?? null);
    },
    { components: panel.routesList() },
  );
}

/** Every command path a panel page has a control or status line for. */
export function mappedPaths(defs: readonly PanelDef[]): Set<string> {
  const out = new Set<string>();
  for (const def of defs) {
    for (const page of def.pages) {
      for (const action of page.actions) out.add(splitPath(action.path).join(" "));
      for (const line of page.status ?? []) out.add(splitPath(line.path).join(" "));
    }
  }
  return out;
}
