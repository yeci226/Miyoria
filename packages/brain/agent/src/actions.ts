// The capability the agent owns: `channel.activeness`, she sets how lively she is in the current
// channel for a while (e.g. when asked to join in more). With the `self` module it becomes her
// talkativeness for that context; without it a temporary activeness. Either way it reverts on its
// own (at most a day), and the channel's level caps it.
//
// `chat.start` / `chat.dm` (talking on her own) are the text runner's (`@miyoria/brain/selfhost`).

import { type Capability, CapabilityError, defineCapability } from "@miyoria/gate/actions";
import { type Clock, contextKeyString, type SelfState } from "@miyoria/types";
import { z } from "zod";
import type { AgentHandle } from "./handle.js";
import { ceilingFor, modeLabel } from "./levels.js";

export const ACTIVENESS_CAPABILITY = "channel.activeness";

/** Longest she may set it for (`self`'s `max_talkativeness_hours` may cut it shorter). */
export const MAX_ACTIVENESS_MINUTES = 24 * 60;

const TOOL_LEVELS = ["silent", "low", "medium", "high"] as const;

const Args = z.object({
  level: z.enum(TOOL_LEVELS),
  minutes: z.number().int().min(5).max(MAX_ACTIVENESS_MINUTES).nullish(),
});
type Args = z.output<typeof Args>;

const LEVEL_TEXT = { silent: "先不插話", low: "安靜", medium: "普通", high: "活躍" } as const;

/** Talkativeness of each tool level (`silent` is the quietest a context can be set to). */
export const LEVEL_TALKATIVENESS = { silent: 0, low: 0.2, medium: 0.5, high: 0.85 } as const;

export function activenessCapability(
  handle: AgentHandle,
  clock: Clock,
  self: () => SelfState | undefined = () => undefined,
): Capability {
  return defineCapability<Args>({
    name: ACTIVENESS_CAPABILITY,
    summary: "暫時調整她在這個頻道的活躍程度",
    risk: "low",
    args: Args,
    permission: "admin.channel.activeness",
    tool: {
      name: "channel_activeness",
      meta: { effect: "act", speed: "instant", group: "chat" },
      description:
        "調整你在這個頻道(或語音頻道)有多愛插話,一段時間後自己恢復:silent 先不插話(被叫到還是會回)、" +
        "low 安靜、medium 普通、high 活躍。有人叫你「安靜點」「少講話」「好吵」,或「可以多聊」「活躍點」," +
        "或你自己想安靜 / 熱鬧一陣子時用;要多安靜、維持多久(最多一天)由你決定。" +
        "頻道的聊天等級是擁有者設的上限,你調得再高也不會超過它。",
      properties: {
        level: { type: "string", enum: [...TOOL_LEVELS] },
        minutes: {
          type: "integer",
          minimum: 5,
          maximum: MAX_ACTIVENESS_MINUTES,
          description: "維持幾分鐘(預設 30,最多 1440 = 一天)",
        },
      },
      required: ["level"],
    },
    scope: (_args, principal) => principal.context?.scope ?? null,
    async execute(args, ctx) {
      const context = ctx.principal.context;
      if (context === null) throw new CapabilityError("no channel to set");
      const minutes = args.minutes ?? 30;
      const state = self();
      if (state) {
        state.setTalkativeness(contextKeyString(context), {
          level: LEVEL_TALKATIVENESS[args.level],
          forMs: minutes * 60_000,
          why: ctx.request.why ?? `活躍度 ${LEVEL_TEXT[args.level]}`,
        });
      } else {
        const level = args.level === "silent" ? "low" : args.level;
        handle.setTemporaryActiveness(context, level, clock.now() + minutes * 60_000);
      }
      const mode = handle.channelMode(context);
      const ceiling = ceilingFor(mode, context);
      const capped =
        ceiling !== null && LEVEL_TALKATIVENESS[args.level] > ceiling.maxTalk
          ? `; capped by the channel level ${mode} (${modeLabel(mode)})`
          : "";
      return {
        text: `activeness ${args.level} (${LEVEL_TEXT[args.level]}) for ${minutes} min here${capped}`,
        data: { level: args.level, minutes, channel_level: mode },
      };
    },
  }) as Capability;
}
