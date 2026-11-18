// The guard over today's services: the outer walls of docs/design/v4-patches.md §2 ("外牆"),
// asked at the moment of a call or a line instead of before a turn. Each service is looked up
// when it is needed (a module may have restarted); one that is not there checks nothing, except
// the Authorizer, without which a tool that needs a permission is refused.
//
// A call:
//   1. the emergency stop: while autonomy is paused nothing but a look runs;
//   2. the owner's directives: a tool a `deny` forbids is refused (`Directives.filterTools`);
//   3. the tool's permission node, held by whoever she acts for (`#tryTool` today);
//   4. the LLM budget: once it is used up, nothing that starts more work outside or runs long;
//   5. a tool that speaks is held to the caps of a line (below), in the place of the run.
// Then the call runs, and a capability's tool passes the action gate inside `ToolRegistry.run`
// (pause, prohibitions, consent, permission, budget, rate limits, review, approval): its refusal
// comes back as the call's result with the stage it was refused at.
//
// A line:
//   1. the emergency stop and the quiet hours, for what she starts herself;
//   2. the Floor's caps (lines per window, the unanswered cap, the waits), by what woke her; a line
//      `say` takes to another place claims that place's Floor as a start of hers (`sayKind`);
//   3. a game's secret (`GameSecrets`, the party module's): a line that would give away a turtle
//      soup's bottom, with a word of it nobody asked about, is refused, and the referee's plain
//      answer is said in its place;
//   4. the output review (`safeOutgoing`): a line it would replace or change is refused instead.
//
// What a tool brought back is shown to the input defence, which may put a warning in front.

import { ActuatorRegistryKey } from "@miyoria/gate/actions";
import { LlmRouterKey } from "@miyoria/llm/llm";
import {
  AuthorizerKey,
  type ContextKey,
  contextKeyEquals,
  DirectivesKey,
  type FloorClaimKind,
  FloorKey,
  GameSecretsKey,
  type InputServices,
  inspectInput,
  ModerationKey,
  safeOutgoing,
  spendsBudget,
} from "@miyoria/types";
import { clockText, type LocalTime, quietEndsAt } from "../../arbiter/src/index.js";
import { LINE_REFUSALS, REFUSALS } from "./rules.js";
import { SAY } from "./say.js";
import {
  ALLOW,
  type Guard,
  type GuardCall,
  type GuardContext,
  type GuardVerdict,
  refuse,
  type Wake,
  wakeAuthor,
} from "./types.js";

export interface ServiceGuardOptions {
  services: InputServices;
  /** The Arbiter's clock settings, for the quiet hours; unset: none. */
  quiet?: LocalTime | null;
}

/** What a run woken by `wake` claims of the Floor. */
export function floorKind(wake: Wake): FloorClaimKind {
  switch (wake.kind) {
    case "addressed":
      return wake.reason === "reply" ? "reply" : "addressed";
    case "result":
      return "result";
    case "world":
      return wake.claim ?? "notable";
    case "glance":
      return "ambient";
    case "timer":
    case "self":
      return "wish";
  }
}

/**
 * What a line of a run woken by `wake` claims of the Floor of a place other than the run's
 * (`say`): nobody there asked for it, so it spends that place's budget. Her own starts keep their
 * kind; a glance elsewhere is a wish of hers there; anything someone asked for is `notable`.
 */
export function sayKind(wake: Wake): FloorClaimKind {
  const kind = floorKind(wake);
  if (kind === "wish" || kind === "notable") return kind;
  return kind === "ambient" ? "wish" : "notable";
}

export function serviceGuard(options: ServiceGuardOptions): Guard {
  const { services } = options;
  const quiet = options.quiet ?? null;
  const paused = (): boolean => services.get(ActuatorRegistryKey)?.paused === true;

  /**
   * The caps on her speaking in `place`, without the output review: the pause and the quiet hours
   * by what woke her, the Floor of `place` by what the line claims there.
   */
  const speaking = (place: ContextKey, ctx: GuardContext): GuardVerdict => {
    const woke = floorKind(ctx.wake);
    const kind = contextKeyEquals(place, ctx.session.context) ? woke : sayKind(ctx.wake);
    if (spendsBudget(woke)) {
      if (paused()) return refuse("pause", LINE_REFUSALS.paused);
      const until = quiet === null ? null : quietEndsAt(ctx.now, quiet);
      if (until !== null && quiet !== null) {
        return refuse("quiet_hours", LINE_REFUSALS.quietHours(clockText(until, quiet)));
      }
    }
    const refused = services.get(FloorKey)?.refuses(kind, place) ?? null;
    return refused === null ? ALLOW : refuse("floor", refused);
  };

  return {
    async checkCall({ entry }: GuardCall, ctx: GuardContext): Promise<GuardVerdict> {
      const context = ctx.session.context;
      if (entry.effect !== "read" && paused()) return refuse("pause", REFUSALS.paused);
      const directives = services.get(DirectivesKey);
      if (directives && directives.filterTools([{ name: entry.name }], context).length === 0) {
        return refuse("directive", REFUSALS.directive);
      }
      const node = entry.tool.permission ?? null;
      if (node !== null) {
        const asker = wakeAuthor(ctx.wake);
        if (asker === null) return refuse("permission", REFUSALS.permissionNobody);
        // Several people asking at once: the weakest of them decides (the old turn's rule).
        const askers =
          ctx.wake.kind === "addressed" && ctx.wake.callers !== undefined
            ? ctx.wake.callers.map((c) => c.from.account)
            : [asker.account];
        const authorizer = services.get(AuthorizerKey);
        if (authorizer === undefined || !askers.every((a) => authorizer.allows(a, node))) {
          return refuse("permission", REFUSALS.permissionAsker);
        }
      }
      if (
        (entry.effect === "external" || entry.speed === "long") &&
        services.get(LlmRouterKey)?.budgetState() === "exhausted"
      ) {
        return refuse("budget", REFUSALS.budget);
      }
      // `say` names its place and checks its line itself.
      if (entry.effect === "say" && entry.name !== SAY) return speaking(context, ctx);
      return ALLOW;
    },

    async checkLine(place: ContextKey, line: string, ctx: GuardContext): Promise<GuardVerdict> {
      const caps = speaking(place, ctx);
      if (!caps.allow) return caps;
      const leak = services.get(GameSecretsKey)?.leak(place, line) ?? null;
      if (leak !== null) {
        return refuse(
          "game_secret",
          LINE_REFUSALS.gameSecret(leak.word),
          leak.instead ?? undefined,
        );
      }
      const safe = safeOutgoing(services.get(ModerationKey), {
        path: "reply",
        text: line,
        context: place,
        turn: ctx.turn,
      });
      if (safe.blocked !== null) return refuse("moderation", LINE_REFUSALS.moderation);
      if (safe.text !== line.trim()) return refuse("unsafe_output", LINE_REFUSALS.unsafe);
      return ALLOW;
    },

    screenResult(text: string, ctx: GuardContext): string {
      const verdict = inspectInput(services, {
        text,
        source: "tool",
        context: ctx.session.context,
      });
      // Flooding is something people do; only what a tool's text says can earn a note.
      if (!verdict?.note || verdict.flags.every((f) => f === "flood")) return text;
      return `${verdict.note}\n${text}`;
    },
  };
}
