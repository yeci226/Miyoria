import type { ToolContext } from "@miyoria/tools";
import {
  ARBITER_IMPULSE_TOPIC,
  type Event,
  impulseReason,
  Principals,
  v2Payload,
} from "@miyoria/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  ActionDeniedError,
  approvalCard,
  type Capability,
  type CapabilityTool,
  defineCapability,
  FOLLOWUP_MAX_AGE_MS,
  FOLLOWUP_REASON,
  FOLLOWUP_RETRY_MS,
  Followups,
  RESULT_PENDING,
} from "../src/index.js";
import { AMY, CTX, gate } from "./helpers.js";

afterEach(() => {
  vi.useRealTimers();
});

/** The follow-up impulses published (in the old `agent_initiative` shape). */
const initiatives = (events: readonly Event[]) =>
  events.flatMap((e) => {
    const impulse = v2Payload(e, ARBITER_IMPULSE_TOPIC);
    if (!impulse) return [];
    expect(impulse.source).toBe("followup");
    return [
      {
        context: impulse.target.context,
        reason: impulseReason(impulse),
        hint: impulse.hint ?? "",
        about: impulse.about,
      },
    ];
  });

function context(): ToolContext {
  return {
    turn: "t1",
    context: CTX,
    account: AMY,
    principal: Principals.user(AMY, CTX),
    message: { context: CTX, id: "m1" },
    priority: "request",
    signal: new AbortController().signal,
  };
}

const Args = z.object({ code: z.string() });

function highWithResult(runs: string[]): Capability {
  return defineCapability<z.output<typeof Args>>({
    name: "t.result",
    summary: "test result",
    risk: "high",
    args: Args,
    permission: null,
    guidance: "only harmless code",
    tool: { name: "t_result", description: "測試。", properties: {}, followup: true },
    describe: (a) => ({ lines: [`code: ${a.code}`], files: [{ name: "main.py", data: a.code }] }),
    async execute(a, ctx) {
      runs.push(`${a.code} by ${ctx.decision.reviewer}`);
      return `output of ${a.code}`;
    },
  }) as Capability;
}

describe("followup tools", () => {
  it("answer_inline_when_the_review_is_quick", async () => {
    const g = await gate();
    const runs: string[] = [];
    g.registry.register(highWithResult(runs));
    g.router.replies.push('{"verdict": "allow", "reason": "fine"}');
    const tool = g.tools.get("t_result") as CapabilityTool;
    expect(await tool.call(context(), { code: "1+1" })).toBe("output of 1+1");
    expect(runs).toEqual(["1+1 by self"]);
    expect(JSON.stringify(g.router.requests[0]?.[1].messages)).toContain("only harmless code");
    expect(initiatives(g.events)).toEqual([]);

    g.router.replies.push('{"verdict": "deny", "reason": "no"}');
    await expect(tool.call(context(), { code: "x" })).rejects.toBeInstanceOf(ActionDeniedError);
  });

  it("report_back_in_a_follow_up_turn_when_late", async () => {
    const g = await gate();
    // The review hangs and times out (deny) after the tool answered; the refusal comes back.
    g.registry.configure({ ...g.registry.config, inline_wait_ms: 0, review_timeout_ms: 30 });
    g.registry.register(highWithResult([]));
    g.router.hang = true;
    const tool = g.tools.get("t_result") as CapabilityTool;
    expect(await tool.call(context(), { code: "2+2", why: "test" })).toBe(RESULT_PENDING);
    expect(initiatives(g.events)).toEqual([]);
    await vi.waitFor(() => expect(initiatives(g.events)).toHaveLength(1));
    const [f] = initiatives(g.events);
    expect(f?.reason).toBe(FOLLOWUP_REASON);
    expect(f?.context).toEqual(CTX);
    expect(f?.about).toEqual([AMY]);
    expect(f?.hint).toContain("沒有執行");
    expect(f?.hint).toContain("test");
  });

  it("owners_see_the_capability_view_with_attachments", () => {
    const capability = highWithResult([]);
    const card = approvalCard(
      "id1",
      capability,
      Principals.self(CTX),
      { code: "print(1)" },
      null,
      "unsure",
      capability.describe?.({ code: "print(1)" }) ?? null,
    );
    expect(card.files).toEqual([{ name: "main.py", data: "print(1)" }]);
    expect(card.text).toContain("code: print(1)");
    expect(card.text).not.toContain("參數：");
  });
});

describe("Followups", () => {
  it("retries_skipped_deliveries_until_they_are_too_old", () => {
    vi.useFakeTimers();
    const events: Event[] = [];
    const f = new Followups(
      (e) => events.push(e),
      () => Date.now(),
    );
    f.deliver(CTX, "result", [AMY]);
    expect(initiatives(events)).toHaveLength(1);
    const skipped = {
      turn: "t",
      context: CTX,
      respond: false,
      score: 0,
      reasons: [`initiative:${FOLLOWUP_REASON}`, "skipped: a turn is in flight"],
    };
    // A long busy stretch (her own long turn, people talking) does not lose the result.
    const tries = Math.floor(FOLLOWUP_MAX_AGE_MS / FOLLOWUP_RETRY_MS);
    for (let i = 1; i <= tries; i++) {
      f.onDecision(skipped);
      vi.advanceTimersByTime(FOLLOWUP_RETRY_MS);
      expect(initiatives(events)).toHaveLength(i + 1);
    }
    // Gives up once it is too old to matter.
    f.onDecision(skipped);
    vi.advanceTimersByTime(FOLLOWUP_RETRY_MS * 2);
    expect(initiatives(events)).toHaveLength(tries + 1);
    // Other initiatives and other contexts are not its business.
    f.deliver(CTX, "again");
    f.onDecision({ ...skipped, reasons: ["initiative:idle_channel", "skipped"] });
    f.onDecision({ ...skipped, context: { ...CTX, channel: "c2" } });
    vi.advanceTimersByTime(FOLLOWUP_RETRY_MS);
    expect(initiatives(events)).toHaveLength(tries + 2);
    f.close();
  });
});

describe("status providers", () => {
  it("add_lines_and_show_failures", async () => {
    const g = await gate();
    const remove = g.registry.addStatus("b", () => ["line b"]);
    g.registry.addStatus("a", async () => {
      throw new Error("boom");
    });
    expect(await g.registry.statusLines()).toEqual(["a:無法取得狀態(boom)", "line b"]);
    remove();
    expect(await g.registry.statusLines()).toEqual(["a:無法取得狀態(boom)"]);
  });
});
