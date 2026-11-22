// Agent commands: `/channel mode`, `/channel activeness`, `/voice mode` and
// `/admin persona show`, registered in the `commands` module's registry when it is available.
//
// Settings are shown with a view node (`channel.mode.view`, ...) and changed with a separate
// one (`admin.channel.mode`, ...): the command's node lets you look, changing (the argument or
// the select on the card) also needs the change node.
//
// `/channel mode` sets the channel's level (關閉 / 只回提及 / 安靜 / 一般 / 活躍, and 每則都回 for
// tests), a ceiling on how much she talks there (`levels.ts`); `/voice mode` offers the modes
// that differ in voice. `/channel mode` and `/channel activeness` take `範圍: 這個頻道|整個伺服器`:
// the whole server's value is for its channels that have none of their own (v5-places.md).
//
// The voice module registers the other `voice` commands (`join`, `leave`, `consent`, `golive`).

import {
  ArgKind,
  argSpec,
  type CardBlock,
  type CommandRegistry,
  CommandRegistryKey,
  type CommandReply,
  type ComponentInvocation,
  ComponentResult,
  cardReply,
  commandSpec,
  componentId,
  type Invocation,
  notice,
} from "@miyoria/commands";
import { errorMessage, getLogger, type ServiceLookup } from "@miyoria/runtime/kernel";
import type { ContextKey } from "@miyoria/types";
import {
  type Activeness,
  CHANNEL_MODES,
  type ChannelMode,
  parseActiveness,
  parseChannelMode,
} from "./config.js";
import { type AgentHandle, type LevelScope, UnknownPlaceError } from "./handle.js";
import { modeDescription, modeLabel } from "./levels.js";
import type { PersonaHandle } from "./persona.js";
import { charCount } from "./util.js";

const log = getLogger("agent.commands");

export const PATHS = [
  "channel mode",
  "channel activeness",
  "admin persona show",
  "voice mode",
] as const;
const NOT_SAVED = "設定沒有寫入資料庫，重新啟動後會恢復原狀。";
/** In voice `quiet` and `lively` act like `normal`, so they are not offered there. */
const VOICE_MODES: readonly ChannelMode[] = ["off", "mention-only", "normal", "always"];
const LEVELS: readonly Activeness[] = ["low", "medium", "high"];
const LEVEL_NOTE =
  "等級是上限：她在等級之內自己決定要多話，有人請她安靜或多聊時她會自己調整（最多一天），但不會超過這裡的設定。";
const SPACE_NOTE = "整個伺服器的設定用在這個伺服器裡沒有自己設定的頻道。";

const NODES = {
  modeView: "channel.mode.view",
  modeSet: "admin.channel.mode",
  activenessView: "channel.activeness.view",
  activenessSet: "admin.channel.activeness",
  voiceView: "voice.mode.view",
  voiceSet: "admin.voice.mode",
} as const;

const R = {
  mode: "channel:mode:set",
  modeSpace: "channel:mode:space",
  activeness: "channel:activeness:set",
  activenessSpace: "channel:activeness:space",
  voice: "voice:mode:set",
} as const;

/**
 * Remembers which registry the commands went into, so they can be removed on stop and
 * re-registered when the `commands` module provides a different registry.
 */
export class AgentCommands {
  #installed: CommandRegistry | null = null;

  /** Registers the commands in the current `CommandRegistry` service, if any. */
  install(services: ServiceLookup, handle: AgentHandle, persona: PersonaHandle): void {
    const registry = services.get(CommandRegistryKey);
    if (!registry) {
      log.debug("no command registry, agent commands not registered");
      return;
    }
    if (this.#installed === registry) return;
    if (this.#installed) unregister(this.#installed);
    this.#installed = null;
    try {
      register(registry, handle, persona);
    } catch (error) {
      log.warn({ error: errorMessage(error) }, "could not register agent commands");
      unregister(registry);
      return;
    }
    this.#installed = registry;
  }

  uninstall(): void {
    if (this.#installed) unregister(this.#installed);
    this.#installed = null;
  }
}

function unregister(registry: CommandRegistry): void {
  for (const path of PATHS) registry.unregister(path);
}

export function activenessLabel(level: Activeness): string {
  switch (level) {
    case "low":
      return "低";
    case "medium":
      return "普通";
    case "high":
      return "高";
  }
}

function tryParse<T>(parse: (s: string) => T, value: string): T | null {
  try {
    return parse(value);
  } catch {
    return null;
  }
}

/** `null` when saved, else the error. */
async function save(op: Promise<void>): Promise<unknown> {
  try {
    await op;
    return null;
  } catch (error) {
    return error ?? new Error("unknown error");
  }
}

function cannotChange(node: string): CommandReply {
  return notice("error", "你沒有變更這項設定的權限。", `需要權限：${node}`);
}

/** The option that says where a level is set: this channel (default) or the whole server. */
export const SCOPE_ARG = "範圍";
export const SCOPE_ROOM = "這個頻道";
export const SCOPE_SPACE = "整個伺服器";
const SCOPES = [SCOPE_ROOM, SCOPE_SPACE] as const;
const UNKNOWN_ROOM =
  "她還不認得這個頻道（這裡還沒有人說過話），設定只到重新啟動為止；有人在這裡說句話後再設定一次就會保存。";
const NO_SERVER = "私訊裡沒有伺服器，只能設定這個頻道。";
const UNKNOWN_SERVER = "她還不認得這個伺服器，沒辦法設定整個伺服器。";

/** One setting: how to read, label and write it in a context. */
interface Setting<T extends string> {
  title: string;
  /** e.g. "這個頻道的聊天模式". */
  subject: string;
  values: readonly T[];
  label: (value: T) => string;
  /** One line about a value (the select's option description). */
  describe?: (value: T) => string;
  /** Shown under the current value. */
  hint?: string;
  parse: (raw: string) => T;
  current: (ctx: ContextKey) => T;
  /** Where the current value comes from, in words (`（已自訂）`). */
  source: (ctx: ContextKey) => string;
  set: (ctx: ContextKey, value: T | null, by: string) => Promise<void>;
  setNode: string;
  route: string;
  /** Where it is set; `space`: the whole server `ctx` is in. */
  scope: LevelScope;
}

function settingCard<T extends string>(
  s: Setting<T>,
  ctx: ContextKey,
  note: string | null = null,
): CommandReply {
  const current = s.current(ctx);
  const blocks: CardBlock[] = [
    { type: "text", text: `${s.subject}：\`${current}\` ${s.label(current)}${s.source(ctx)}` },
  ];
  const about = s.describe?.(current);
  if (about || s.hint) {
    blocks.push({ type: "muted", text: [about, s.hint].filter(Boolean).join("\n") });
  }
  if (note) blocks.push({ type: "muted", text: note });
  blocks.push({
    type: "select",
    select: {
      id: componentId(s.route),
      placeholder: "變更設定…",
      options: [
        ...s.values.map((v) => ({
          label: `${s.label(v)}（${v}）`,
          value: v,
          ...(s.describe ? { description: s.describe(v) } : {}),
          default: v === current,
        })),
        { label: "恢復預設", value: "reset" },
      ],
    },
  });
  return cardReply(blocks, { title: s.title, accent: "neutral", session: {} });
}

async function change<T extends string>(
  s: Setting<T>,
  ctx: ContextKey,
  raw: string,
  by: string,
): Promise<CommandReply> {
  let value: T | null = null;
  if (raw !== "reset") {
    value = tryParse(s.parse, raw);
    if (value === null) return notice("warn", `不認得的設定值 \`${raw}\`。`);
  }
  const saved = await save(s.set(ctx, value, by));
  if (saved instanceof UnknownPlaceError && s.scope === "space") {
    return notice("warn", UNKNOWN_SERVER);
  }
  if (saved !== null) log.warn({ error: errorMessage(saved) }, "could not persist agent setting");
  const current = s.current(ctx);
  const text =
    value === null
      ? `已將${s.subject}恢復為預設：\`${current}\` ${s.label(current)}。`
      : `已將${s.subject}設為 \`${current}\` ${s.label(current)}。`;
  const note =
    saved === null ? null : saved instanceof UnknownPlaceError ? UNKNOWN_ROOM : NOT_SAVED;
  return notice("success", text, note);
}

type Found<T extends string> = { s: Setting<T>; ctx: ContextKey } | CommandReply;

/** Who changed it, for the place setting's record. */
const byOf = (inv: Invocation): string => `${inv.invoker.platform}:${inv.invoker.id}`;

/** The command handler: show the card, or change the value when an argument was given. */
function settingCommand<T extends string>(setting: (inv: Invocation) => Found<T>, arg: string) {
  return async (inv: Invocation): Promise<CommandReply> => {
    const found = setting(inv);
    if ("text" in found) return found;
    const { s, ctx } = found;
    const raw = inv.str(arg);
    if (raw === null) return settingCard(s, ctx);
    if (!(await inv.allowed(s.setNode))) return cannotChange(s.setNode);
    return change(s, ctx, raw, byOf(inv));
  };
}

/** The select on the card: changes the value and shows the updated card. */
function settingRoute<T extends string>(
  route: string,
  setNode: string,
  setting: (inv: Invocation) => Found<T>,
) {
  return {
    route,
    permission: setNode,
    handle: async (inv: ComponentInvocation): Promise<ComponentResult> => {
      const found = setting(inv);
      if ("text" in found) return ComponentResult.reply(found);
      const raw = inv.values[0];
      if (raw === undefined) return ComponentResult.update(settingCard(found.s, found.ctx));
      const result = await change(found.s, found.ctx, raw, byOf(inv));
      if (result.tone === "warn" || result.tone === "error") return ComponentResult.reply(result);
      return ComponentResult.update(settingCard(found.s, found.ctx, result.text));
    },
  };
}

/** The `範圍` option of `/channel mode` and `/channel activeness`. */
function scopeArg() {
  return argSpec(
    SCOPE_ARG,
    "設定這個頻道（預設），還是整個伺服器沒有自己設定的頻道",
    ArgKind.choice(SCOPES),
    {
      required: false,
    },
  );
}

/** Where the room's value comes from, in words. */
function roomSource(own: boolean, space: boolean): string {
  return own ? "（這個頻道自訂）" : space ? "（照整個伺服器的設定）" : "（預設）";
}

function register(registry: CommandRegistry, handle: AgentHandle, persona: PersonaHandle): void {
  const channelMode = (scope: LevelScope): Setting<ChannelMode> => ({
    title: "聊天等級",
    subject: scope === "space" ? "她在這個伺服器的聊天等級" : "她在這個頻道的聊天等級",
    values: CHANNEL_MODES,
    label: modeLabel,
    describe: modeDescription,
    hint: scope === "space" ? `${LEVEL_NOTE}\n${SPACE_NOTE}` : LEVEL_NOTE,
    parse: parseChannelMode,
    current: (ctx) =>
      scope === "space"
        ? (handle.spaceChannelMode(ctx) ?? handle.configuredSpaceMode(ctx))
        : handle.channelMode(ctx),
    source: (ctx) =>
      scope === "space"
        ? handle.spaceChannelMode(ctx) !== null
          ? "（已自訂）"
          : "（預設）"
        : roomSource(
            handle.channelModeOverride(ctx) !== null,
            handle.spaceChannelMode(ctx) !== null,
          ),
    set: (ctx, value, by) => handle.setChannelMode(ctx, value, { scope, by }),
    setNode: NODES.modeSet,
    route: scope === "space" ? R.modeSpace : R.mode,
    scope,
  });
  const activeness = (scope: LevelScope): Setting<Activeness> => ({
    title: "主動程度",
    subject: scope === "space" ? "她在這個伺服器主動發話的程度" : "她在這個頻道主動發話的程度",
    values: LEVELS,
    label: activenessLabel,
    ...(scope === "space" ? { hint: SPACE_NOTE } : {}),
    parse: parseActiveness,
    current: (ctx) =>
      scope === "space"
        ? (handle.spaceActiveness(ctx) ?? handle.configuredSpaceActiveness(ctx))
        : handle.activeness(ctx),
    source: (ctx) =>
      scope === "space"
        ? handle.spaceActiveness(ctx) !== null
          ? "（已自訂）"
          : "（預設）"
        : roomSource(handle.activenessOverride(ctx) !== null, handle.spaceActiveness(ctx) !== null),
    set: (ctx, value, by) => handle.setActiveness(ctx, value, { scope, by }),
    setNode: NODES.activenessSet,
    route: scope === "space" ? R.activenessSpace : R.activeness,
    scope,
  });
  const voiceMode: Setting<ChannelMode> = {
    title: "語音模式",
    subject: "她在語音頻道的聊天模式",
    values: VOICE_MODES,
    label: modeLabel,
    parse: parseChannelMode,
    current: (ctx) => handle.channelMode(ctx),
    source: (ctx) =>
      roomSource(handle.channelModeOverride(ctx) !== null, handle.spaceChannelMode(ctx) !== null),
    set: (ctx, value, by) => handle.setChannelMode(ctx, value, { by }),
    setNode: NODES.voiceSet,
    route: R.voice,
    scope: "room",
  };
  const modes = { room: channelMode("room"), space: channelMode("space") };
  const levels = { room: activeness("room"), space: activeness("space") };

  /** The setting the `範圍` option asks for; a server-wide one needs a server. */
  const scoped =
    <T extends string>(settings: { room: Setting<T>; space: Setting<T> }, fixed?: LevelScope) =>
    (inv: Invocation): Found<T> => {
      const asked = fixed ?? (inv.str(SCOPE_ARG) === SCOPE_SPACE ? "space" : "room");
      if (asked === "room") return { s: settings.room, ctx: inv.context };
      if (inv.context.scope === null) return notice("warn", NO_SERVER);
      if (!handle.perPlace) return notice("warn", UNKNOWN_SERVER);
      return { s: settings.space, ctx: inv.context };
    };
  const inVoice = (inv: Invocation): Found<ChannelMode> => {
    const guild = inv.context.scope;
    const ctx = guild === null ? null : handle.voiceContext(inv.context.platform, guild);
    if (ctx === null) {
      return notice(
        "warn",
        "她目前不在這個伺服器的語音頻道中。",
        "請先用 /miyo 的「加入我的語音頻道」。",
      );
    }
    return { s: voiceMode, ctx };
  };

  registry.register(
    commandSpec(
      "channel mode",
      "查看或設定她在這個頻道（或整個伺服器）的聊天等級（她多話的上限）",
      {
        args: [
          argSpec(
            "mode",
            "off 關閉 / mention-only 只回提及 / quiet 安靜 / normal 一般 / lively 活躍 / reset 恢復預設",
            ArgKind.choice([...CHANNEL_MODES, "reset"]),
            { required: false },
          ),
          scopeArg(),
        ],
        permission: NODES.modeView,
      },
    ),
    settingCommand(scoped(modes), "mode"),
    {
      components: [
        settingRoute(R.mode, NODES.modeSet, scoped(modes, "room")),
        settingRoute(R.modeSpace, NODES.modeSet, scoped(modes, "space")),
      ],
    },
  );

  registry.register(
    commandSpec(
      "channel activeness",
      "查看或設定她在這個頻道（或整個伺服器）主動發話的程度（不超過聊天等級）",
      {
        args: [
          argSpec(
            "level",
            "low / medium / high / reset（恢復預設）",
            ArgKind.choice([...LEVELS, "reset"]),
            { required: false },
          ),
          scopeArg(),
        ],
        permission: NODES.activenessView,
      },
    ),
    settingCommand(scoped(levels), "level"),
    {
      components: [
        settingRoute(R.activeness, NODES.activenessSet, scoped(levels, "room")),
        settingRoute(R.activenessSpace, NODES.activenessSet, scoped(levels, "space")),
      ],
    },
  );

  registry.register(
    commandSpec("voice mode", "查看或設定她在語音頻道的聊天模式", {
      args: [
        argSpec(
          "mode",
          "off 關閉 / mention-only 只回提及 / normal 一般 / always 每則都回 / reset 恢復預設",
          ArgKind.choice([...VOICE_MODES, "reset"]),
          { required: false },
        ),
      ],
      permission: NODES.voiceView,
    }),
    settingCommand(inVoice, "mode"),
    { components: [settingRoute(R.voice, NODES.voiceSet, inVoice)] },
  );

  registry.register(
    commandSpec("admin persona show", "列出她的人格段落與字數", {
      permission: "admin.persona.view",
      ephemeral: true,
    }),
    () => personaCard(persona),
  );
}

function personaCard(persona: PersonaHandle): CommandReply {
  return persona.read((p) => {
    const lines = p.sections.map((s) => `\`${s.key}\`　${charCount(s.body)} 字`);
    const blocks: CardBlock[] = [
      { type: "text", text: lines.length === 0 ? "沒有任何人格段落。" : lines.join("\n") },
    ];
    if (p.examples.length > 0)
      blocks.push({ type: "muted", text: `範例對話：${p.examples.length} 則` });
    return cardReply(blocks, { title: `人格：${p.id}`, accent: "neutral" });
  });
}
