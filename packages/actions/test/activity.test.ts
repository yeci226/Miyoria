// v2 stage 3 in the gate: queued runs are cancelled with their caller (tool timeout, cancelled
// turn), activity capabilities are routed to the ActivityManager after the gate, and outcomes
// land in the Ledger-ready form (and a notice for a late high-risk result).

import type { ToolContext } from "@miyoria/tools";
import {
  type Action,
  type ActionSink,
  ActionSinkKey,
  type ActivityRequest,
  ArbiterKey,
  type LedgerRecord,
  NOTICE_TOPIC,
  type Principal,
  Principals,
  type TurnId,
  v2Payload,
} from "@miyoria/types";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  ACTION_OUTCOME_TOPIC,
  type ActivityRouter,
  CapabilityTool,
  defineCapability,
  REVIEW_PENDING,
  type RoutedCall,
} from "../src/index.js";
import { CTX, gate, OWEN } from "./helpers.js";

class FakeScheduler implements ActionSink {
  readonly actions: Action[] = [];

  async submit(action: Action): Promise<void> {
    this.actions.push(action);
  }

  async cancelTurn(_turn: TurnId): Promise<void> {}
}

function toolCtx(principal: Principal, signal: AbortSignal): ToolContext {
  return {
    turn: "01JC0000000000000000000000",
    context: CTX,
    account: OWEN,
    principal,
    message: { context: CTX, id: "m1" },
    priority: "direct",
    signal,
  };
}

const ticketOf = (a: Action | undefined) => (a?.payload.type === "actuate" ? a.payload.ticket : "");

describe("ticket cancellation", () => {
  it("a tool that times out cancels its queued run: it never starts", async () => {
    const g = await gate();
    const scheduler = new FakeScheduler();
    g.services.provide("scheduler", ActionSinkKey, scheduler);
    g.authorizer.grant(OWEN, "test.low");
    const controller = new AbortController();
    const call = g.tools
      .get("t_low")
      ?.call(toolCtx(Principals.user(OWEN, CTX), controller.signal), {
        note: "late",
      });
    await vi.waitFor(() => expect(scheduler.actions).toHaveLength(1));
    controller.abort(new Error("tool timed out"));
    await expect(call).rejects.toThrow("tool timed out");
    // The scheduler gets to it later: nothing runs (and it is dropped quietly).
    await expect(
      g.registry.run(ticketOf(scheduler.actions[0]), new AbortController().signal),
    ).rejects.toThrow("cancelled");
    expect(g.runs).toEqual([]);
  });

  it("a run already in progress sees its signal abort when the caller gives up", async () => {
    const g = await gate();
    const scheduler = new FakeScheduler();
    g.services.provide("scheduler", ActionSinkKey, scheduler);
    let seen: AbortSignal | null = null;
    g.registry.register(
      defineCapability({
        name: "t.slow",
        summary: "slow",
        risk: "low",
        args: z.object({}),
        permission: null,
        tool: { name: "t_slow", description: "慢。", properties: {} },
        lane: () => "act:test",
        async execute(_args, ctx) {
          seen = ctx.signal;
          await new Promise((resolve) =>
            ctx.signal.addEventListener("abort", resolve, { once: true }),
          );
          return "stopped";
        },
      }),
    );
    const controller = new AbortController();
    const call = g.tools.get("t_slow")?.call(toolCtx(Principals.self(CTX), controller.signal), {});
    await vi.waitFor(() => expect(scheduler.actions).toHaveLength(1));
    const running = g.registry.run(ticketOf(scheduler.actions[0]), new AbortController().signal);
    await vi.waitFor(() => expect(seen).not.toBeNull());
    controller.abort(new Error("turn cancelled"));
    await expect(call).rejects.toThrow("turn cancelled");
    await running;
    expect((seen as AbortSignal | null)?.aborted).toBe(true);
  });
});

describe("activity routing", () => {
  function routed() {
    const calls: RoutedCall[] = [];
    const router: ActivityRouter = {
      async route(call) {
        calls.push(call);
        if (!call.wait) return { text: "開始了(task ABC123)", data: null };
        return call.execute({ signal: new AbortController().signal, task: "T1" });
      },
    };
    return { calls, router };
  }

  async function withJoin() {
    const g = await gate();
    const executed: (string | null)[] = [];
    g.registry.register(
      defineCapability<{ guild?: string | null }>({
        name: "voice.join",
        summary: "加入語音頻道",
        risk: "medium",
        args: z.object({ guild: z.string().nullish() }),
        permission: null,
        tool: { name: "voice_join", description: "進語音。", properties: {} },
        activity: (args, principal): ActivityRequest[] => [
          {
            type: "ensure_voice",
            platform: "discord",
            guild: args.guild ?? principal.context?.scope ?? "",
            channel: null,
            follow: principal.requester,
          },
        ],
        async execute(_args, ctx) {
          executed.push(ctx.task ?? null);
          return "joined";
        },
      }),
    );
    return { g, executed };
  }

  it("without an ActivityManager the capability executes as before", async () => {
    const { g, executed } = await withJoin();
    const outcome = await g.registry.invoke({
      principal: Principals.panel("api"),
      capability: "voice.join",
      args: { guild: "g1" },
      why: null,
      turn: null,
    });
    expect(outcome).toMatchObject({ status: "done", result: { text: "joined" } });
    expect(executed).toEqual([null]);
    expect(g.registry.routesActivity).toBe(false);
  });

  it("her tool is answered once accepted; commands wait; the manager's own steps execute", async () => {
    const { g, executed } = await withJoin();
    const { calls, router } = routed();
    const remove = g.registry.setActivityRouter(router);
    const tool = g.tools.get("voice_join");
    expect(tool).toBeInstanceOf(CapabilityTool);
    const answer = await tool?.call(
      toolCtx(Principals.self(CTX), new AbortController().signal),
      {},
    );
    expect(answer).toBe("開始了(task ABC123)");
    expect(calls[0]).toMatchObject({
      wait: false,
      requests: [{ type: "ensure_voice", guild: "g1" }],
      request: { capability: "voice.join" },
    });
    expect(executed).toEqual([]);
    // A command waits for the outcome; the manager runs the capability as its task's step.
    const outcome = await g.registry.invoke({
      principal: Principals.command(OWEN, CTX),
      capability: "voice.join",
      args: {},
      why: null,
      turn: null,
    });
    expect(outcome).toMatchObject({ status: "done", result: { text: "joined" } });
    expect(executed).toEqual(["T1"]);
    // `direct` (the manager's own step through the gate) never routes again.
    await g.registry.invoke(
      {
        principal: Principals.command(OWEN, CTX),
        capability: "voice.join",
        args: { guild: "g1" },
        why: null,
        turn: null,
      },
      { activity: "direct", task: "T2" },
    );
    expect(executed).toEqual(["T1", "T2"]);
    expect(calls).toHaveLength(2);
    remove();
    expect(g.registry.routesActivity).toBe(false);
  });

  it("the gate still decides first: a refusal never reaches the manager", async () => {
    const { g } = await withJoin();
    const { calls, router } = routed();
    g.registry.setActivityRouter(router);
    await g.registry.setPaused(true);
    const outcome = await g.registry.invoke({
      principal: Principals.self(CTX),
      capability: "voice.join",
      args: {},
      why: null,
      turn: null,
    });
    expect(outcome.status).toBe("denied");
    expect(calls).toEqual([]);
  });
});

describe("implied steps", () => {
  it("go through the gate but are not rate limited a second time", async () => {
    const g = await gate();
    const run = (implied: boolean) =>
      g.registry.invoke(
        {
          principal: Principals.director(null),
          capability: "t.medium",
          args: {},
          why: null,
          turn: null,
        },
        { activity: "direct", implied },
      );
    // OBS retried right after the first try: the cooldown does not apply to an implied step.
    expect((await run(true)).status).toBe("done");
    expect((await run(true)).status).toBe("done");
    expect((await run(false)).status).toBe("done");
    expect((await run(false)).status).toBe("denied");
    // The pause still stops them.
    await g.registry.setPaused(true);
    expect((await run(true)).status).toBe("denied");
  });
});

describe("outcomes she can see", () => {
  it("a late high-risk result becomes a notice in the context she asked from", async () => {
    const g = await gate();
    g.authorizer.grant(OWEN, "test.high");
    g.router.replies.push('{"verdict": "allow", "reason": "ok"}');
    const ctx = toolCtx(Principals.user(OWEN, CTX), new AbortController().signal);
    expect(await g.tools.get("t_high")?.call(ctx, {})).toBe(REVIEW_PENDING);
    await vi.waitFor(() =>
      expect(g.events.some((e) => v2Payload(e, NOTICE_TOPIC) !== null)).toBe(true),
    );
    const notice = g.events.map((e) => v2Payload(e, NOTICE_TOPIC)).find((n) => n !== null);
    expect(notice).toMatchObject({
      source: "actions",
      ok: true,
      context: CTX,
      turn: "01JC0000000000000000000000",
      text: expect.stringContaining("做好了"),
    });
  });

  it("medium and high outcomes are recorded in the ledger, or published without one", async () => {
    const ask = (g: Awaited<ReturnType<typeof gate>>) =>
      g.registry.invoke({
        principal: Principals.user(OWEN, CTX),
        capability: "t.medium",
        args: { note: "x" },
        why: null,
        turn: "t1",
      });
    const plain = await gate();
    plain.authorizer.grant(OWEN, "test.medium");
    await ask(plain);
    const published = plain.events.flatMap((e) =>
      e.type === "custom" && e.data.topic === ACTION_OUTCOME_TOPIC ? [e.data.payload] : [],
    );
    expect(published).toEqual([
      expect.objectContaining({
        capability: "t.medium",
        status: "done",
        outcome: "ok",
        source: "message",
      }),
    ]);

    const g = await gate();
    const records: LedgerRecord[] = [];
    g.services.provide("arbiter", ArbiterKey, {
      submit: async () => {
        throw new Error("unused");
      },
      ledger: () => {
        throw new Error("unused");
      },
      record: (entry) => {
        records.push(entry);
        return "L1";
      },
      resolve: () => true,
    });
    // Refused (no permission): she sees that too, and why.
    await ask(g);
    g.authorizer.grant(OWEN, "test.medium");
    await ask(g);
    expect(records).toEqual([
      expect.objectContaining({ kind: "task", summary: "test medium", outcome: "denied" }),
      expect.objectContaining({ kind: "task", summary: "test medium", outcome: "ok" }),
    ]);
    expect(g.events.some((e) => e.type === "custom" && e.data.topic === ACTION_OUTCOME_TOPIC)).toBe(
      false,
    );
    // Low risk stays quiet.
    g.authorizer.grant(OWEN, "test.low");
    await g.registry.invoke({
      principal: Principals.user(OWEN, CTX),
      capability: "t.low",
      args: {},
      why: null,
      turn: null,
    });
    expect(records).toHaveLength(2);
  });
});
