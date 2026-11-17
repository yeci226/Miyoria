// `/admin autonomy pause | resume | status`, `/me privacy` and the approval card's buttons.

import {
  ArgKind,
  argSpec,
  type CommandRegistry,
  type CommandReply,
  ComponentResult,
  cardReply,
  commandSpec,
  defineRoute,
  notice,
} from "@miyoria/commands";
import { accountRefString, type EmergencyReport, type PresencePrivacy } from "@miyoria/types";
import type { ActuatorRegistry } from "./registry.js";
import { APPROVE_ROUTE, answeredCard, DENY_ROUTE } from "./review.js";

export const PATHS = [
  "admin autonomy pause",
  "admin autonomy resume",
  "admin autonomy status",
  "me privacy",
] as const;

export const NODE_TOGGLE = "admin.autonomy.toggle";
export const NODE_VIEW = "admin.autonomy.view";
export const NODE_APPROVE = "owner.autonomy.approve";
export const NODE_PRIVACY = "me.privacy";

async function statusReply(registry: ActuatorRegistry): Promise<CommandReply> {
  const cfg = registry.config;
  const pending = registry.escalations.list();
  const lines = [
    `狀態：${registry.paused ? "已緊急停止（她不回話，只有指令與面板能讓她行動）" : "運作中"}`,
    `能力：${registry.names().join("、") || "—"}`,
  ];
  if (cfg.forbidden.length > 0) lines.push(`禁止：${cfg.forbidden.join("、")}`);
  if (pending.length > 0) lines.push(`等待確認：${pending.map(([, s]) => s).join("、")}`);
  lines.push(...(await registry.statusLines()));
  return cardReply([{ type: "text", text: lines.join("\n") }], {
    title: "自主行動",
    accent: registry.paused ? "warn" : "success",
  });
}

function privacyText(dm: boolean, approach: boolean, presence: boolean | null): string {
  return [
    `私訊你：${dm ? "可以" : "不可以"}`,
    `主動找你（她自己發起的私訊等）：${approach ? "可以" : "不可以"}`,
    ...(presence === null
      ? []
      : [`看你在 Discord 上的狀態（在線、遊戲、音樂、自訂狀態）：${presence ? "可以" : "不可以"}`]),
  ].join("\n");
}

const STEP_LABELS: Readonly<Record<string, string>> = {
  pause: "暫停",
  silence: "閉嘴",
  song: "唱歌",
  stream: "直播",
  voice: "語音",
  game: "遊戲",
  resume: "恢復",
};

/** One line per step, so a step that did not work is seen. */
function stepLines(report: EmergencyReport): string {
  return report.steps
    .map((s) => `${s.ok ? "✓" : "✗"} ${STEP_LABELS[s.step] ?? s.step}：${s.detail}`)
    .join("\n");
}

/** Registers the commands; undo with `unregisterCommands`. */
export function registerCommands(
  registry: CommandRegistry,
  actuators: () => ActuatorRegistry,
  /** The `world` module's presence opt-out; `undefined` when it isn't running. */
  presence: () => PresencePrivacy | undefined = () => undefined,
): void {
  registry.register(
    commandSpec("admin autonomy pause", "緊急停止：她閉嘴、關台、離開語音、停遊戲", {
      permission: NODE_TOGGLE,
      ephemeral: true,
    }),
    async (inv) => {
      const who = accountRefString(inv.invoker);
      const report = await actuators().emergency.stop(`command:${who}`, who);
      const ok = report.steps.every((s) => s.ok);
      const title = ok ? "已緊急停止。" : "已緊急停止，但有步驟沒有成功。";
      return notice(ok ? "success" : "warn", title, stepLines(report));
    },
  );
  registry.register(
    commandSpec("admin autonomy resume", "解除緊急停止，讓她再開口和行動", {
      permission: NODE_TOGGLE,
      ephemeral: true,
    }),
    async (inv) => {
      const report = await actuators().emergency.resume(`command:${accountRefString(inv.invoker)}`);
      const ok = report.steps.every((s) => s.ok);
      return notice(
        ok ? "success" : "warn",
        ok ? "已解除緊急停止。" : "解除緊急停止時有問題。",
        "語音、直播和遊戲不會自動回來。",
      );
    },
  );

  const answer = (approved: boolean) =>
    defineRoute<string>({
      route: approved ? APPROVE_ROUTE : DENY_ROUTE,
      permission: NODE_APPROVE,
      parse: (params) => (params.length === 1 && params[0] ? params[0] : null),
      handle: (inv, id) => {
        const known = actuators().escalations.resolve(id, approved, inv.invoker);
        return ComponentResult.update(answeredCard(approved, known));
      },
    });
  registry.register(
    commandSpec("admin autonomy status", "查看她的自主行動狀態與能力", {
      permission: NODE_VIEW,
      ephemeral: true,
    }),
    () => statusReply(actuators()),
    { components: [answer(true), answer(false)] },
  );

  const onOff = (name: string, description: string) =>
    argSpec(name, description, ArgKind.choice(["on", "off"]), { required: false });
  registry.register(
    commandSpec("me privacy", "設定她能不能私訊你、主動找你、看你的狀態（省略 = 查看）", {
      args: [
        onOff("dm", "on = 可以私訊你，off = 不要"),
        onOff("approach", "on = 可以主動找你，off = 不要"),
        onOff("presence", "on = 可以看你在 Discord 上的狀態（在線、遊戲、音樂），off = 不要"),
      ],
      permission: NODE_PRIVACY,
      ephemeral: true,
    }),
    async (inv) => {
      const dm = inv.str("dm");
      const approach = inv.str("approach");
      const wantPresence = inv.str("presence");
      const privacy = actuators().privacy;
      const book = presence();
      if (wantPresence !== null) {
        if (!book) return notice("error", "狀態感知沒有啟用，這個設定目前不適用。");
        if (!book.loaded) return notice("error", "隱私設定暫時無法讀取，請稍後再試。");
        await book.setPresence(inv.invoker, wantPresence === "on");
      }
      const seen = (): boolean | null => (book?.loaded ? book.presenceAllowed(inv.invoker) : null);
      if (dm === null && approach === null) {
        const now = await privacy.get(inv.invoker);
        const text = privacyText(now.dm, now.approach, seen());
        return wantPresence === null
          ? notice("info", text)
          : notice("success", `已更新。\n${text}`);
      }
      const next = await privacy.set(inv.invoker, {
        ...(dm === null ? {} : { dm: dm === "on" }),
        ...(approach === null ? {} : { approach: approach === "on" }),
      });
      return notice("success", `已更新。\n${privacyText(next.dm, next.approach, seen())}`);
    },
  );
}

export function unregisterCommands(registry: CommandRegistry): void {
  for (const path of PATHS) registry.unregister(path);
}
