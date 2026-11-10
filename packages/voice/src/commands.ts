// `/voice join | leave | consent | golive start | stop | status`. The agent module adds
// `/voice mode`.

import { type ActuatorRegistry, deniedText } from "@miyoria/actions";
import {
  type AnyComponentRoute,
  ArgKind,
  argSpec,
  type CardBlock,
  type CommandRegistry,
  type CommandReply,
  ComponentResult,
  cardReply,
  commandSpec,
  componentId,
  type Invocation,
  MAX_SESSION_TTL_MS,
  notice,
} from "@miyoria/commands";
import { getLogger } from "@miyoria/kernel";
import { isJsonObject, type JsonObject, Principals } from "@miyoria/types";
import { GoLiveJoinError } from "./actions.js";
import type { Consent, ConsentPolicy } from "./consent.js";
import type { GoLiveState } from "./link/conn.js";
import type { VoiceLink } from "./link/link.js";

const log = getLogger("voice.commands");

/** Paths registered by `registerCommands`. */
export const PATHS = [
  "voice join",
  "voice leave",
  "voice consent",
  "voice golive start",
  "voice golive stop",
  "voice golive status",
] as const;

const NODE_GOLIVE = "voice.golive";

const GOLIVE_STATE_TEXT: Record<GoLiveState, string> = {
  starting: "連線中",
  live: "直播中",
  stopped: "未直播",
  failed: "失敗",
};

const R = {
  consentOn: "voice:consent:on",
  consentOff: "voice:consent:off",
  goliveStart: "voice:golive:start",
  goliveStop: "voice:golive:stop",
} as const;

/** The privacy notice shown when she joins a voice channel. */
export function joinAnnouncement(policy: ConsentPolicy): string {
  switch (policy) {
    case "opt-out":
      return "她會聽這個語音頻道裡的對話。不想被收音的話，請使用 `/me` " + "或下方的按鈕。";
    case "opt-in":
      return (
        "她只會聽已同意的人說話。要讓她聽到你，請使用 `/me` 或下方的按鈕" +
        "（可隨時在 `/me` 取消）。"
      );
  }
}

function consentButtons(): CardBlock {
  return {
    type: "buttons",
    buttons: [
      { id: componentId(R.consentOn), label: "允許收音", style: "success" },
      { id: componentId(R.consentOff), label: "停止收音", style: "secondary" },
    ],
  };
}

function joinedCard(policy: ConsentPolicy, extra: string | null = null): CommandReply {
  const blocks: CardBlock[] = [{ type: "text", text: joinAnnouncement(policy) }];
  if (extra) blocks.push({ type: "text", text: extra });
  blocks.push(consentButtons());
  // Everyone may press the consent buttons (each sets their own choice) until they expire.
  return cardReply(blocks, {
    title: "她已加入語音頻道",
    accent: "success",
    session: { initiatorOnly: false, ttlMs: MAX_SESSION_TTL_MS },
  });
}

function consentReply(allowed: boolean, changed: boolean): CommandReply {
  const text = allowed ? "她在語音頻道中會聽你說話。" : "她在語音頻道中不會聽你說話。";
  return notice(changed ? "success" : "info", changed ? `已更新：${text}` : `目前設定：${text}`);
}

function guildOf(inv: Invocation): string | null {
  return inv.context.scope;
}

const IN_GUILD_ONLY = () => notice("warn", "這個指令只能在伺服器中使用。");
const NODE_OFFLINE = () =>
  notice("warn", "她的語音帳號目前不在線上。", "請確認直播機上的 voice node 已啟動。");

function nodeReady(link: VoiceLink, inv: Invocation): boolean {
  const self = link.selfAccount();
  return link.isConnected() && self !== null && self.platform === inv.invoker.platform;
}

/** Registers the voice commands. Undo with `unregisterCommands`. */
export function registerCommands(
  registry: CommandRegistry,
  link: VoiceLink,
  consent: Consent,
  goliveSource: string,
  actuators: ActuatorRegistry,
): void {
  const policy = consent.policy;

  /** Runs a capability for the invoker, overriding her judgment (the gate still applies). */
  const act = (inv: Invocation, capability: string, args: JsonObject) =>
    actuators.invoke({
      principal: Principals.command(inv.invoker, inv.context),
      capability,
      args: { guild: guildOf(inv), ...args },
      why: `/${inv.path.join(" ")}`,
      turn: null,
    });

  const goliveStart = async (inv: Invocation, sourceArg: string | null): Promise<CommandReply> => {
    const guild = guildOf(inv);
    if (guild === null) return IN_GUILD_ONLY();
    if (!nodeReady(link, inv)) return NODE_OFFLINE();
    if (link.isStreaming(guild)) return notice("warn", "Go Live 已經在進行中。");
    const source = (sourceArg ?? goliveSource).trim();
    if (source === "") {
      return notice(
        "warn",
        "沒有推流來源。",
        "請提供 source，或設定 [modules.voice] golive_source。",
      );
    }
    // Not in voice yet: the capability joins the invoker's channel first.
    const outcome = await act(inv, "stream.start", { source });
    if (outcome.status === "denied") {
      return notice("warn", deniedText(outcome.decision.stage), outcome.decision.reason);
    }
    if (outcome.status === "failed") {
      log.warn({ err: outcome.error, guild, source }, "go live start failed");
      return outcome.cause instanceof GoLiveJoinError
        ? notice("error", "無法加入語音頻道。請先進入一個語音頻道。", outcome.error)
        : notice("error", "無法開始 Go Live。", outcome.error);
    }
    const data = outcome.result.data;
    const joined = isJsonObject(data) && data.joined === true;
    const started = "已開始 Go Live，OBS 畫面連上後就會顯示。";
    return joined
      ? joinedCard(policy, started)
      : cardReply(
          [
            { type: "text", text: started },
            {
              type: "buttons",
              buttons: [{ id: componentId(R.goliveStop), label: "結束 Go Live", style: "danger" }],
            },
          ],
          { title: "Go Live", accent: "success" },
        );
  };

  const goliveStop = async (inv: Invocation): Promise<CommandReply> => {
    const guild = guildOf(inv);
    if (guild === null) return IN_GUILD_ONLY();
    if (!link.isStreaming(guild)) return notice("info", "目前沒有在 Go Live。");
    const outcome = await act(inv, "stream.stop", {});
    if (outcome.status === "denied") {
      return notice("warn", deniedText(outcome.decision.stage), outcome.decision.reason);
    }
    if (outcome.status === "failed") {
      log.warn({ err: outcome.error, guild }, "go live stop failed");
      return notice("error", "無法結束 Go Live。", outcome.error);
    }
    return notice("success", "已結束 Go Live。");
  };

  const goliveStatus = (inv: Invocation): CommandReply => {
    const guild = guildOf(inv);
    if (guild === null) return IN_GUILD_ONLY();
    const status = link.golive(guild);
    const state = status?.state ?? "stopped";
    const detail = status ? (status.error ?? status.reason) : null;
    const running = state === "starting" || state === "live";
    const blocks: CardBlock[] = [{ type: "text", text: `狀態：${GOLIVE_STATE_TEXT[state]}` }];
    if (detail) blocks.push({ type: "muted", text: detail });
    blocks.push({
      type: "buttons",
      buttons: running
        ? [{ id: componentId(R.goliveStop), label: "結束 Go Live", style: "danger" }]
        : [{ id: componentId(R.goliveStart), label: "開始 Go Live", style: "primary" }],
    });
    return cardReply(blocks, {
      title: "Go Live",
      accent: running ? "success" : "neutral",
      session: {},
    });
  };

  const consentRoutes: AnyComponentRoute[] = [
    {
      route: R.consentOn,
      handle: async (inv) => {
        await consent.set(inv.invoker, true);
        return ComponentResult.reply(consentReply(true, true));
      },
    },
    {
      route: R.consentOff,
      handle: async (inv) => {
        await consent.set(inv.invoker, false);
        return ComponentResult.reply(consentReply(false, true));
      },
    },
  ];

  registry.register(
    commandSpec("voice join", "讓她加入你所在的語音頻道", { permission: "voice.join" }),
    async (inv) => {
      const guild = guildOf(inv);
      if (guild === null) return IN_GUILD_ONLY();
      if (!nodeReady(link, inv)) return NODE_OFFLINE();
      const outcome = await act(inv, "voice.join", {});
      if (outcome.status === "denied") {
        return notice("warn", deniedText(outcome.decision.stage), outcome.decision.reason);
      }
      if (outcome.status === "failed") {
        log.warn({ err: outcome.error, guild }, "join failed");
        return notice("error", "無法加入語音頻道。請先進入一個語音頻道。", outcome.error);
      }
      return joinedCard(policy);
    },
  );

  registry.register(
    commandSpec("voice leave", "讓她離開語音頻道", { permission: "voice.leave" }),
    async (inv) => {
      const guild = guildOf(inv);
      if (guild === null) return IN_GUILD_ONLY();
      if (link.channel(guild) === null) return notice("info", "她目前不在語音頻道中。");
      const outcome = await act(inv, "voice.leave", {});
      if (outcome.status === "denied") {
        return notice("warn", deniedText(outcome.decision.stage), outcome.decision.reason);
      }
      if (outcome.status === "failed") {
        log.warn({ err: outcome.error, guild }, "leave failed");
        return notice("error", "無法離開語音頻道。", outcome.error);
      }
      return notice("success", "她已離開語音頻道。");
    },
  );

  registry.register(
    commandSpec("voice consent", "查看或設定她在語音頻道中能不能聽你說話", {
      args: [
        argSpec(
          "state",
          "on = 可以聽，off = 不要聽（省略 = 查看目前設定）",
          ArgKind.choice(["on", "off"]),
          {
            required: false,
          },
        ),
      ],
      permission: "voice.consent",
      ephemeral: true,
    }),
    async (inv) => {
      const state = inv.str("state");
      if (state === null) {
        const allowed = await consent.allowed(inv.invoker);
        const reply = consentReply(allowed, false);
        reply.card?.blocks.push(consentButtons());
        return reply;
      }
      const allowed = state === "on";
      await consent.set(inv.invoker, allowed);
      return consentReply(allowed, true);
    },
    { components: consentRoutes },
  );

  registry.register(
    commandSpec("voice golive start", "把直播畫面送進語音頻道（Discord Go Live）", {
      args: [
        argSpec(
          "source",
          "RTMP / SRT 來源（預設為 [modules.voice] golive_source）",
          ArgKind.string,
          {
            required: false,
          },
        ),
      ],
      permission: NODE_GOLIVE,
    }),
    (inv) => goliveStart(inv, inv.str("source")),
  );

  registry.register(
    commandSpec("voice golive stop", "結束 Discord Go Live 推流", { permission: NODE_GOLIVE }),
    goliveStop,
  );

  registry.register(
    commandSpec("voice golive status", "查看 Go Live 的狀態", {
      permission: "voice.golive.view",
    }),
    goliveStatus,
    {
      components: [
        {
          route: R.goliveStart,
          permission: NODE_GOLIVE,
          ephemeral: false,
          handle: async (inv) => ComponentResult.reply(await goliveStart(inv, null)),
        },
        {
          route: R.goliveStop,
          permission: NODE_GOLIVE,
          ephemeral: false,
          handle: async (inv) => ComponentResult.reply(await goliveStop(inv)),
        },
      ],
    },
  );
}

export function unregisterCommands(registry: CommandRegistry): void {
  for (const path of PATHS) registry.unregister(path);
}
