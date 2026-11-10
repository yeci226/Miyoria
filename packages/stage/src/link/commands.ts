// `/stream start | stop | status | scene <name>` commands. Starting, stopping and switching
// scenes go through the actuator registry's gate (principal `command`, override).

import { type ActuatorRegistry, deniedText } from "@miyoria/actions";
import {
  type AnyComponentRoute,
  ArgKind,
  argSpec,
  type CardBlock,
  type Choice,
  type CommandRegistry,
  type CommandReply,
  ComponentResult,
  cardReply,
  commandSpec,
  componentId,
  type Invocation,
  notice,
} from "@miyoria/commands";
import { errorMessage, getLogger } from "@miyoria/kernel";
import { isJsonObject, type JsonObject, Principals } from "@miyoria/types";
import { defaultStageStatus, type StageStatus, type StreamAction } from "../protocol.js";
import type { StageLink } from "./link.js";

const log = getLogger("stage.link");

/** Paths registered by `registerStreamCommands`. */
export const PATHS = ["stream start", "stream stop", "stream scene", "stream status"] as const;

const R = {
  start: "stream:start",
  stop: "stream:stop",
  scene: "stream:scene",
  refresh: "stream:refresh",
} as const;

const offline = () => notice("warn", "直播機目前沒有連線。", "請在直播機上執行 miyoria stage。");

/** One-line summary of a status. */
export function describeStatus(status: StageStatus): string {
  const on = (b: boolean) => (b ? "已連線" : "未連線");
  return `VTube Studio：${on(status.vts)}｜OBS：${on(status.obs)}｜場景：${status.scene ?? "—"}｜直播：${
    status.streaming ? "直播中" : "未直播"
  }`;
}

/**
 * OBS scene names the stage node reported, if its status carries them (`scenes`), plus the
 * current scene.
 */
export function sceneNames(status: StageStatus | null): string[] {
  const listed = (status as (StageStatus & { scenes?: unknown }) | null)?.scenes;
  const names = Array.isArray(listed)
    ? listed.filter((s): s is string => typeof s === "string")
    : [];
  if (status?.scene && !names.includes(status.scene)) names.unshift(status.scene);
  return names;
}

function statusCard(status: StageStatus, note: string | null = null): CommandReply {
  const blocks: CardBlock[] = [
    {
      type: "text",
      text: [
        `直播：${status.streaming ? "直播中" : "未直播"}`,
        `場景：${status.scene ?? "—"}`,
        `OBS：${status.obs ? "已連線" : "未連線"}　VTube Studio：${status.vts ? "已連線" : "未連線"}`,
      ].join("\n"),
    },
  ];
  if (note) blocks.push({ type: "muted", text: note });
  const scenes = sceneNames(status);
  if (scenes.length > 1) {
    blocks.push({
      type: "select",
      select: {
        id: componentId(R.scene),
        placeholder: "切換場景…",
        options: scenes.slice(0, 25).map((s) => ({
          label: s,
          value: s,
          default: s === status.scene,
        })),
      },
    });
  }
  blocks.push({
    type: "buttons",
    buttons: [
      status.streaming
        ? { id: componentId(R.stop), label: "停止直播", style: "danger" }
        : { id: componentId(R.start), label: "開始直播", style: "primary" },
      { id: componentId(R.refresh), label: "重新整理", style: "secondary" },
    ],
  });
  return cardReply(blocks, {
    title: "直播狀態",
    accent: status.streaming ? "success" : "neutral",
    session: {},
  });
}

/** Registers the stream commands. Undo with `unregisterStreamCommands`. */
export function registerStreamCommands(
  registry: CommandRegistry,
  link: StageLink,
  actuators: ActuatorRegistry,
): void {
  /** Runs a capability for the invoker, overriding her judgment (the gate still applies). */
  const act = (inv: Invocation, capability: string, args: JsonObject) =>
    actuators.invoke({
      principal: Principals.command(inv.invoker, inv.context),
      capability,
      args,
      why: `/${inv.path.join(" ")}`,
      turn: null,
    });

  const stream = async (inv: Invocation, action: StreamAction): Promise<CommandReply> => {
    // OBS streams to the listener Go Live opens, so OBS alone has nowhere to go. Where the voice
    // module is on, the whole broadcast starts and stops as one task; this is OBS only elsewhere.
    const broadcast = action === "start" ? "stream.start" : "stream.stop";
    const whole = actuators.get(broadcast) !== undefined && inv.context.scope !== null;
    if (!whole && !link.isConnected()) return offline();
    const outcome = await (whole ? act(inv, broadcast, {}) : act(inv, "stage.stream", { action }));
    if (outcome.status === "denied") {
      return notice("warn", deniedText(outcome.decision.stage), outcome.decision.reason);
    }
    if (outcome.status === "failed") {
      log.warn({ err: outcome.error, action }, "stream command failed");
      return notice(
        "error",
        action === "start" ? "無法開始直播。" : "無法停止直播。",
        outcome.error,
      );
    }
    if (whole) return notice("success", action === "start" ? "已開始直播。" : "已停止直播。");
    const status = link.status() ?? defaultStageStatus();
    const data = outcome.result.data;
    const streaming = isJsonObject(data) && data.streaming === true;
    if (streaming === (action === "start")) {
      return notice("success", action === "start" ? "已開始直播。" : "已停止直播。");
    }
    return notice("warn", "已送出指令，但 OBS 尚未回報狀態變更。", describeStatus(status));
  };

  const setScene = async (inv: Invocation, raw: string): Promise<CommandReply> => {
    if (!link.isConnected()) return offline();
    const name = raw.trim();
    if (name === "") return notice("warn", "請指定場景名稱。");
    const outcome = await act(inv, "stage.scene", { name });
    if (outcome.status === "denied") {
      return notice(
        "warn",
        outcome.decision.stage === "args"
          ? `沒有「${name}」這個場景。`
          : deniedText(outcome.decision.stage),
        outcome.decision.reason,
      );
    }
    if (outcome.status === "failed") {
      log.warn({ err: outcome.error, name }, "scene switch failed");
      return notice("error", `無法切換到場景「${name}」。`, outcome.error);
    }
    return notice("success", `已切換到場景「${name}」。`);
  };

  const currentStatus = async (): Promise<StageStatus> => {
    try {
      return await link.refreshStatus();
    } catch (error) {
      log.warn({ err: errorMessage(error) }, "status request failed");
      return link.status() ?? defaultStageStatus();
    }
  };

  /** After a button: errors are their own message, success refreshes the card. */
  const afterAction = async (reply: CommandReply): Promise<ComponentResult> => {
    if (reply.tone === "warn" || reply.tone === "error") return ComponentResult.reply(reply);
    return ComponentResult.update(statusCard(link.status() ?? (await currentStatus()), reply.text));
  };

  const routes: AnyComponentRoute[] = [
    {
      route: R.start,
      permission: "stream.start",
      handle: async (inv) => afterAction(await stream(inv, "start")),
    },
    {
      route: R.stop,
      permission: "stream.stop",
      handle: async (inv) => afterAction(await stream(inv, "stop")),
    },
    {
      route: R.scene,
      permission: "stream.scene",
      handle: async (inv) => afterAction(await setScene(inv, inv.values[0] ?? "")),
    },
    {
      route: R.refresh,
      handle: async () => {
        if (!link.isConnected()) return ComponentResult.reply(offline());
        return ComponentResult.update(statusCard(await currentStatus()));
      },
    },
  ];

  registry.register(
    commandSpec("stream start", "讓直播機的 OBS 開始直播", { permission: "stream.start" }),
    (inv) => stream(inv, "start"),
  );
  registry.register(
    commandSpec("stream stop", "讓直播機的 OBS 停止直播", { permission: "stream.stop" }),
    (inv) => stream(inv, "stop"),
  );

  const suggestScenes = (_inv: Invocation, value: string): Choice[] => {
    const q = value.trim().toLowerCase();
    return sceneNames(link.status())
      .filter((s) => q === "" || s.toLowerCase().includes(q))
      .map((s) => ({ name: s, value: s }));
  };
  registry.register(
    commandSpec("stream scene", "切換 OBS 場景", {
      args: [argSpec("name", "場景名稱", ArgKind.string)],
      permission: "stream.scene",
    }),
    (inv) => setScene(inv, inv.str("name") ?? ""),
    { autocomplete: { name: suggestScenes } },
  );

  registry.register(
    commandSpec("stream status", "查看直播機與 OBS 的狀態", {
      permission: "stream.status",
    }),
    async () => {
      if (!link.isConnected()) return offline();
      return statusCard(await currentStatus());
    },
    { components: routes },
  );
}

export function unregisterStreamCommands(registry: CommandRegistry): void {
  for (const path of PATHS) registry.unregister(path);
}
