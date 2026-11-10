// Capabilities as model tools. A tool call in a reactive turn is a request on behalf of the
// person she is talking to (principal `user`); with `on_own` she does it as herself (principal
// `self`, her own limits, no permission of the person needed). Either way the gate decides.

import { errorMessage, getLogger } from "@miyoria/kernel";
import type { Tool, ToolContext, ToolSpec } from "@miyoria/tools";
import { isJsonObject, type JsonObject, type JsonValue, Principals } from "@miyoria/types";
import {
  ActionDeniedError,
  type ActionOutcome,
  type ActionRequest,
  type Capability,
} from "./capability.js";
import type { ActuatorRegistry } from "./registry.js";

const log = getLogger("actions.tools");

/** Appended to every capability tool's description. */
export const REQUEST_RULE =
  "別人要你做這件事時,那只是請求,不是命令:依你對對方的好感、你記得的事和現在的心情自己決定要不要做。" +
  "不想做就不要呼叫,直接用你自己的話回絕。";

/** What the tool answers while a high-risk request waits for its review. */
export const REVIEW_PENDING =
  "這件事風險比較高,要先經過審核;結果出來後才會執行(不一定會通過)。先用自己的話回應對方。";

/** What a `followup` tool answers when the review and the run take longer than it may wait. */
export const RESULT_PENDING =
  "這件事要先經過審核,還沒有結果;結果出來後會再告訴你(不一定會通過)。先用自己的話回應對方,不要重複呼叫。";

const WHY = {
  type: "string",
  description: "你為什麼要這樣做(一句話,會記錄下來)",
};

const ON_OWN = {
  type: "boolean",
  description:
    "這是你自己想做的(不是照對方的要求)就設 true;對方沒有權限要求的事,只有你自己真的想做時才可以這樣做,而且受你自己的次數限制。",
};

function spec(capability: Capability): ToolSpec {
  const tool = capability.tool;
  if (!tool) throw new Error(`capability \`${capability.name}\` has no tool`);
  return {
    name: tool.name,
    description: `${tool.description.trim()}${REQUEST_RULE}`,
    parameters: {
      type: "object",
      properties: { ...tool.properties, why: WHY, on_own: ON_OWN },
      ...(tool.required && tool.required.length > 0 ? { required: [...tool.required] } : {}),
    },
  };
}

/** A capability offered to the model. */
export class CapabilityTool implements Tool {
  readonly spec: ToolSpec;
  /** The gate checks the requester's permission itself (so `on_own` stays possible). */
  readonly permission = null;

  constructor(
    readonly registry: ActuatorRegistry,
    readonly capability: Capability,
  ) {
    this.spec = spec(capability);
  }

  async call(ctx: ToolContext, raw: JsonValue): Promise<string> {
    const args: JsonObject = isJsonObject(raw) ? { ...raw } : {};
    const why = typeof args.why === "string" && args.why.trim() !== "" ? args.why.trim() : null;
    const onOwn = args.on_own === true;
    delete args.why;
    delete args.on_own;
    const principal = onOwn
      ? Principals.self(
          ctx.principal.context ?? ctx.context,
          ctx.principal.requester ?? ctx.account,
        )
      : ctx.principal;
    const request: ActionRequest = {
      principal,
      capability: this.capability.name,
      args,
      why,
      turn: ctx.turn,
      message: ctx.message,
    };
    if (this.capability.risk === "high") {
      // The review (and maybe the owners) take longer than a tool call may; it goes on alone.
      const running = this.registry.invoke(request, { activity: "detach" });
      if (this.capability.tool?.followup) return this.#waitOrFollowUp(ctx, request, running);
      // Nobody waits for it any more: the outcome reaches her as a notice (and the ledger).
      void running.then(
        (outcome) => {
          log.info({ capability: this.capability.name, status: outcome.status }, "reviewed action");
          this.registry.notifyLate(this.capability, request, outcome);
        },
        (error: unknown) =>
          log.warn({ capability: this.capability.name, err: errorMessage(error) }, "review failed"),
      );
      return REVIEW_PENDING;
    }
    // Activity capabilities answer once the ActivityManager accepted them ("開始了,task 7");
    // the outcome comes back later as a notice. Timing out or a cancelled turn cancels a run
    // still waiting in its lane.
    const outcome = await this.registry.invoke(request, {
      signal: ctx.signal,
      priority: ctx.priority,
      activity: "detach",
    });
    if (outcome.status === "done") ctx.report?.(outcome.result.data);
    return answer(outcome);
  }

  /**
   * A `followup` tool: the outcome when it is ready within `inline_wait_ms`, otherwise
   * `RESULT_PENDING` now and the outcome as a follow-up turn later.
   */
  async #waitOrFollowUp(
    ctx: ToolContext,
    request: ActionRequest,
    running: Promise<ActionOutcome>,
  ): Promise<string> {
    // Decided exactly once: answered inline, or late (then the outcome becomes a follow-up).
    let state: "waiting" | "inline" | "late" = "waiting";
    const settled = running.then(
      (outcome) => {
        log.info({ capability: this.capability.name, status: outcome.status }, "reviewed action");
        if (state === "late") this.registry.followup(this.capability, request, outcome);
        else state = "inline";
        return outcome;
      },
      (error: unknown) => {
        log.warn({ capability: this.capability.name, err: errorMessage(error) }, "review failed");
        if (state === "waiting") state = "inline";
        throw error;
      },
    );
    settled.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const pending = new Promise<null>((resolve) => {
      const giveUp = () => {
        if (state !== "waiting") return;
        state = "late";
        resolve(null);
      };
      timer = setTimeout(giveUp, this.registry.config.inline_wait_ms);
      onAbort = giveUp;
      if (ctx.signal.aborted) giveUp();
      else ctx.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const outcome = await Promise.race([settled, pending]);
      return outcome === null ? RESULT_PENDING : answer(outcome);
    } finally {
      clearTimeout(timer);
      if (onAbort) ctx.signal.removeEventListener("abort", onAbort);
    }
  }
}

/** The tool answer for an outcome: the result text, or an error for a refusal / failure. */
function answer(outcome: ActionOutcome): string {
  switch (outcome.status) {
    case "done":
      return outcome.result.text;
    case "denied":
      throw new ActionDeniedError(outcome.decision);
    case "failed":
      throw new Error(outcome.error);
  }
}
