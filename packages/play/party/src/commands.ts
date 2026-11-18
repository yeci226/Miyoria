// `/game party`: another way to ask her for a party game, next to telling her in chat. It is the
// entry point of the `/miyo` panel's 派對遊戲 page (no new top-level command: `game` already is
// the group for the games she plays). It runs the same capability her `party_start` tool does,
// as principal `command` and under the same permission node (`permissions.start`), in the
// channel where it was used: the voice channel (or its chat) hosts either game, any other text
// channel of a server hosts turtle soup.

import {
  ArgKind,
  argSpec,
  type CommandHandler,
  type CommandRegistry,
  type CommandReply,
  commandName,
  commandSpec,
  type Invocation,
  notice,
} from "@miyoria/commands";
import { type ActuatorRegistry, CapabilityError, deniedText } from "@miyoria/gate/actions";
import { Principals } from "@miyoria/types";
import type { PartyPermissions } from "./config.js";
import { GAME_IDS, GAME_TITLES, type GameId, isGameId } from "./game.js";

/** Registers `game party`; returns the paths (for unregistering). */
export function registerCommands(
  registry: CommandRegistry,
  perms: PartyPermissions,
  actuators: ActuatorRegistry,
): string[] {
  const spec = commandSpec(
    "game party",
    "請她開一場派對遊戲(猜歌在語音頻道,海龜湯在語音頻道或這個文字頻道)",
    {
      args: [
        argSpec(
          "game",
          `哪個遊戲:${GAME_IDS.map((id) => `${id} ${GAME_TITLES[id]}`).join("、")}`,
          ArgKind.choice([...GAME_IDS]),
        ),
        argSpec(
          "where",
          "海龜湯玩在哪裡:here 這個頻道(預設)、voice 她所在的語音頻道",
          ArgKind.choice(["here", "voice"]),
          {
            required: false,
          },
        ),
      ],
      permission: perms.start,
    },
  );
  const handler: CommandHandler = (inv) => start(actuators, inv);
  registry.register(spec, handler);
  return [commandName(spec)];
}

async function start(actuators: ActuatorRegistry, inv: Invocation): Promise<CommandReply> {
  const raw = (inv.str("game") ?? "").trim().toLowerCase();
  const game: GameId | null = isGameId(raw) ? raw : null;
  if (game === null)
    return notice(
      "warn",
      `沒有這個遊戲。可以玩:${GAME_IDS.map((id) => GAME_TITLES[id]).join("、")}。`,
    );
  const where = inv.str("where");
  const outcome = await actuators.invoke({
    principal: Principals.command(inv.invoker, inv.context),
    capability: "party.start",
    args: { game, ...(where === "voice" || where === "here" ? { where } : {}) },
    why: `/${inv.path.join(" ")}`,
    turn: null,
  });
  switch (outcome.status) {
    case "done":
      return notice("success", `「${GAME_TITLES[game]}」開始了,她會接著主持。`);
    case "denied":
      // A refusal of the game itself (no voice channel, already playing) says why in plain words.
      return notice(
        "warn",
        outcome.decision.stage === "args"
          ? outcome.decision.reason
          : deniedText(outcome.decision.stage),
      );
    case "failed":
      if (outcome.cause instanceof CapabilityError) return notice("warn", outcome.error);
      throw outcome.cause;
  }
}
