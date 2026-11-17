import type { ToolContext } from "@miyoria/llm/tools";
import { Events, type Notice, Principals, type PublishedEvent } from "@miyoria/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  ActionDeniedError,
  approvalCard,
  type Capability,
  type CapabilityTool,
  defineCapability,
  RESULT_PENDING,
} from "../src/index.js";
import { AMY, CTX, gate } from "./helpers.js";

afterEach(() => {
  vi.useRealTimers();
});

/** The notices published, and no impulse of any source (a late result is told as a notice). */
const notices = (events: readonly PublishedEvent[]) => {
  expect(events.filter((e) => e.type === Events.ArbiterImpulse.type)).toEqual([]);
  return events.filter((e) => e.type === Events.AgentNotice.type).map((e) => e.data as Notice);
};

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
    expect(notices(g.events)).toEqual([]);

    g.router.replies.push('{"verdict": "deny", "reason": "no"}');
    await expect(tool.call(context(), { code: "x" })).rejects.toBeInstanceOf(ActionDeniedError);
  });

  it("report_back_as_a_notice_when_late", async () => {
    const g = await gate();
    // The review hangs and times out (deny) after the tool answered; the refusal comes back.
    g.registry.configure({ ...g.registry.config, inline_wait_ms: 0, review_timeout_ms: 30 });
    g.registry.register(highWithResult([]));
    g.router.hang = true;
    const tool = g.tools.get("t_result") as CapabilityTool;
    expect(await tool.call(context(), { code: "2+2", why: "test" })).toBe(RESULT_PENDING);
    expect(notices(g.events)).toEqual([]);
    await vi.waitFor(() => expect(notices(g.events)).toHaveLength(1));
    const [n] = notices(g.events);
    expect(n?.context).toEqual(CTX);
    expect(n?.ok).toBe(false);
    expect(n?.text).toContain("沒有做成");
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
