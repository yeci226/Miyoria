// `/watch start [user]` and `/watch stop`: someone makes her watch (or stop) without counting on
// the model to call `watch_start`. A model can answer "ok, I'm watching" and never call the tool,
// all the more once its own replies of that kind are in the conversation (2026-11-22). The
// command runs the same capabilities through the gate as her tools, so the streamer's privacy, the
// notice in the channel and every other check stay as they are.

import {
  ArgKind,
  argSpec,
  type CommandRegistry,
  type CommandReply,
  commandSpec,
  type Invocation,
  notice,
} from "@miyoria/commands";
import { type ActionOutcome, type ActuatorRegistry, deniedText } from "@miyoria/gate/actions";
import { type JsonObject, Principals } from "@miyoria/types";

export const PATHS = ["watch start", "watch stop"] as const;

/** Everyday nodes (`@miyoria/commands` nodes.ts): members may ask her to watch, as with voice. */
export const NODE_START = "watch.start";
export const NODE_STOP = "watch.stop";

function reply(outcome: ActionOutcome, failed: string): CommandReply {
  if (outcome.status === "done") return notice("success", outcome.result.text);
  if (outcome.status === "denied") {
    return notice("warn", deniedText(outcome.decision.stage), outcome.decision.reason);
  }
  return notice("error", failed, outcome.error);
}

export function registerCommands(
  registry: CommandRegistry,
  actuators: () => ActuatorRegistry,
): void {
  const act = (inv: Invocation, capability: string, args: JsonObject) =>
    actuators().invoke({
      principal: Principals.command(inv.invoker, inv.context),
      capability,
      args,
      why: `/${inv.path.join(" ")}`,
      turn: null,
    });

  registry.register(
    commandSpec("watch start", "讓她看語音頻道裡的直播（Go Live）", {
      args: [
        argSpec("user", "開播者的名字或 id（只有一個人開播時可以省略）", ArgKind.string, {
          required: false,
        }),
      ],
      permission: NODE_START,
    }),
    async (inv) => {
      const user = inv.str("user");
      const outcome = await act(inv, "watch.start", user === null ? {} : { user });
      return reply(outcome, "沒辦法開始看直播。");
    },
  );

  registry.register(
    commandSpec("watch stop", "讓她不要再看直播", { permission: NODE_STOP }),
    async (inv) => reply(await act(inv, "watch.stop", {}), "沒辦法停止看直播。"),
  );
}

export function unregisterCommands(registry: CommandRegistry): void {
  for (const path of PATHS) registry.unregister(path);
}
