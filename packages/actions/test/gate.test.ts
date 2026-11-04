import type { ToolContext } from "@miyoria/tools";
import {
  type Action,
  type ActionSink,
  ActionSinkKey,
  type JsonValue,
  type Principal,
  Principals,
  type TurnId,
} from "@miyoria/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  ActionDeniedError,
  type ActionRequest,
  APPROVE_ROUTE,
  CapabilityTool,
  defineCapability,
  messageDm,
  parseReview,
  REVIEW_PENDING,
} from "../src/index.js";
import { AMY, CTX, decisions, gate, OWEN, OWNER } from "./helpers.js";

const request = (
  capability: string,
  principal: Principal,
  args: JsonValue = {},
  why: string | null = null,
): ActionRequest => ({ principal, capability, args, why, turn: null });

const user = (who = OWEN) => Principals.user(who, CTX);
const self = () => Principals.self(CTX);
const command = (override = true) => Principals.command(OWEN, CTX, override);

afterEach(() => {
  vi.useRealTimers();
});

describe("gate order", () => {
  it("pause lets only commands and the panel through", async () => {
    const g = await gate();
    await g.registry.setPaused(true);
    for (const p of [user(), self(), Principals.director(CTX)]) {
      const out = await g.registry.invoke(request("t.low", p));
      expect(out.status).toBe("denied");
      expect(out.decision.stage).toBe("pause");
    }
    expect((await g.registry.invoke(request("t.low", command()))).status).toBe("done");
    expect((await g.registry.invoke(request("t.low", Principals.panel("api")))).status).toBe(
      "done",
    );
    // Persisted for the next start.
    expect(await g.store.settings.get("_global", "autonomy:paused")).toBe(true);
    await g.registry.setPaused(false);
    expect((await g.registry.invoke(request("t.low", self()))).status).toBe("done");
  });

  it("hard prohibitions beat everything, overrides included", async () => {
    const g = await gate();
    g.registry.configure({ ...g.registry.config, forbidden: ["t.*"] });
    for (const p of [command(), Principals.panel("api"), self()]) {
      const out = await g.registry.invoke(request("t.low", p));
      expect(out.decision.stage).toBe("prohibition");
    }
    g.registry.configure({ ...g.registry.config, forbidden: [] });

    // Not across servers (her and chat requests).
    g.authorizer.grant(OWEN, "test.low");
    const elsewhere = { ...user(), context: { ...CTX, scope: "g2" } };
    const scoped = g.registry.get("t.low");
    if (!scoped) throw new Error("no t.low");
    g.registry.register({ ...scoped, scope: () => "g1" });
    expect((await g.registry.invoke(request("t.low", elsewhere))).decision.stage).toBe(
      "prohibition",
    );
    expect((await g.registry.invoke(request("t.low", user()))).status).toBe("done");
  });

  it("consent: opted-out people are not approached, even by commands", async () => {
    const g = await gate();
    await g.registry.privacy.set(AMY, { approach: false });
    // Her own idea, directed at Amy.
    const out = await g.registry.invoke(request("t.low", self(), { to: AMY.id }));
    expect(out.decision.stage).toBe("consent");
    // Amy asked for it herself: consent is implied.
    g.authorizer.grant(AMY, "test.low");
    const asked = await g.registry.invoke(
      request("t.low", Principals.self(CTX, AMY), { to: AMY.id }),
    );
    expect(asked.status).toBe("done");
  });

  describe("watch consent", () => {
    const watchCapability = () =>
      defineCapability({
        name: "t.watch",
        summary: "test watch",
        risk: "low",
        args: z.object({}),
        permission: null,
        consent: "watch",
        async execute() {
          return "watching";
        },
      });

    it("watch_is_allowed_by_default", async () => {
      const g = await gate();
      expect(await g.registry.privacy.get(AMY)).toMatchObject({ watch: true });
    });

    it("gate_refuses_watching_someone_who_opted_out", async () => {
      const g = await gate();
      g.registry.register(watchCapability());
      await g.registry.privacy.set(AMY, { watch: false });
      const out = await g.registry.invoke({ ...request("t.watch", self()), about: AMY });
      expect(out.decision).toMatchObject({ allowed: false, stage: "consent" });
      expect(out.decision.reason).toBe("the person opted out of being watched");
      // Not being approached is a different choice: `approach` does not decide watching.
      await g.registry.privacy.set(AMY, { watch: true, approach: false });
      const ok = await g.registry.invoke({ ...request("t.watch", self()), about: AMY });
      expect(ok.status).toBe("done");
    });

    it("the_person_asking_for_themselves_passes_the_gate", async () => {
      const g = await gate();
      g.registry.register(watchCapability());
      await g.registry.privacy.set(AMY, { watch: false });
      const out = await g.registry.invoke({
        ...request("t.watch", Principals.self(CTX, AMY)),
        about: AMY,
      });
      expect(out.status).toBe("done");
    });

    it("store_failure_counts_as_opted_out", async () => {
      const g = await gate();
      vi.spyOn(g.store.settings, "get").mockRejectedValue(new Error("down"));
      expect(await g.registry.privacy.get(AMY)).toEqual({
        dm: false,
        approach: false,
        watch: false,
      });
    });
  });

  it("permission is checked against the requester; on_own goes as self", async () => {
    const g = await gate();
    const denied = await g.registry.invoke(request("t.low", user()));
    expect(denied.decision.stage).toBe("permission");
    expect(denied.decision.reason).toContain("on_own");
    g.authorizer.grant(OWEN, "test.low");
    expect((await g.registry.invoke(request("t.low", user()))).status).toBe("done");
    // Amy may not, but she can do it on her own.
    expect((await g.registry.invoke(request("t.low", user(AMY)))).decision.stage).toBe(
      "permission",
    );
    expect((await g.registry.invoke(request("t.low", Principals.self(CTX, AMY)))).status).toBe(
      "done",
    );
  });

  it("command override skips limits and review, not prohibitions", async () => {
    const g = await gate();
    g.registry.configure({
      ...g.registry.config,
      medium: { per_day: 0, per_person_per_day: 0, cooldown_ms: 0 },
    });
    const out = await g.registry.invoke(request("t.medium", command()));
    expect(out.status).toBe("done");
    expect(out.decision).toMatchObject({ stage: "permission", reason: "command override" });
    // High risk too: no review call.
    expect((await g.registry.invoke(request("t.high", command()))).status).toBe("done");
    expect(g.router.requests).toEqual([]);
    // Without override a command is judged like anyone else (here: over the limit).
    expect((await g.registry.invoke(request("t.medium", command(false)))).decision.stage).toBe(
      "rate",
    );
  });

  it("risk tiers: low passes, medium is rate limited with cooldowns", async () => {
    vi.useFakeTimers();
    const g = await gate();
    g.registry.configure({
      ...g.registry.config,
      medium: { per_day: 3, per_person_per_day: 2, cooldown_ms: 10_000 },
    });
    for (let i = 0; i < 5; i++) {
      expect((await g.registry.invoke(request("t.low", self()))).status).toBe("done");
    }
    expect((await g.registry.invoke(request("t.medium", self(), { to: AMY.id }))).status).toBe(
      "done",
    );
    const cooling = await g.registry.invoke(request("t.medium", self(), { to: AMY.id }));
    expect(cooling.decision.stage).toBe("rate");
    expect(cooling.decision.reason).toContain("cooling down");
    vi.advanceTimersByTime(10_000);
    expect((await g.registry.invoke(request("t.medium", self(), { to: AMY.id }))).status).toBe(
      "done",
    );
    vi.advanceTimersByTime(10_000);
    const perPerson = await g.registry.invoke(request("t.medium", self(), { to: AMY.id }));
    expect(perPerson.decision.reason).toContain("for this person");
    expect((await g.registry.invoke(request("t.medium", self(), { to: OWEN.id }))).status).toBe(
      "done",
    );
    vi.advanceTimersByTime(10_000);
    const daily = await g.registry.invoke(request("t.medium", self(), { to: "300" }));
    expect(daily.decision.reason).toContain("daily limit reached (3 per day)");
    // A day later it is allowed again.
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect((await g.registry.invoke(request("t.medium", self(), { to: AMY.id }))).status).toBe(
      "done",
    );
    expect(g.runs.filter((r) => r === "t.medium").length).toBe(4);
  });

  it("budget: degraded tightens limits, exhausted stops autonomous actions", async () => {
    const g = await gate();
    g.registry.configure({
      ...g.registry.config,
      medium: { per_day: 2, per_person_per_day: 10, cooldown_ms: 0 },
    });
    g.router.budget = "degraded";
    expect((await g.registry.invoke(request("t.medium", self()))).status).toBe("done");
    const tight = await g.registry.invoke(request("t.medium", self()));
    expect(tight.decision.stage).toBe("rate");
    expect(tight.decision.reason).toContain("budget degraded");

    g.router.budget = "exhausted";
    for (const p of [self(), Principals.director(CTX)]) {
      expect((await g.registry.invoke(request("t.low", p))).decision.stage).toBe("budget");
    }
    // A person asking is not autonomous; commands still work.
    g.authorizer.grant(OWEN, "test.low");
    expect((await g.registry.invoke(request("t.low", user()))).status).toBe("done");
    expect((await g.registry.invoke(request("t.low", command()))).status).toBe("done");
  });

  it("invalid arguments and unknown capabilities are denied and audited", async () => {
    const g = await gate();
    const bad = await g.registry.invoke(request("t.low", command(), { note: 5 }));
    expect(bad.decision.stage).toBe("args");
    const unknown = await g.registry.invoke(request("nope", command()));
    expect(unknown.decision.stage).toBe("unknown");
    const audit = await g.store.audit.recent(10, null);
    expect(audit.map((a) => [a.action, a.ok])).toEqual([
      ["gate.nope", false],
      ["gate.t.low", false],
    ]);
  });

  it("every decision is audited and published with its reason", async () => {
    const g = await gate();
    await g.registry.invoke(request("t.low", command(), { note: "hi" }, "/test"));
    await g.registry.invoke(request("t.low", user()));
    const [entry] = await g.store.audit.recent(1, "command:discord:100");
    expect(entry).toMatchObject({ action: "gate.t.low", target: "t.low", ok: true });
    expect(entry?.detail).toMatchObject({
      capability: "t.low",
      allowed: true,
      stage: "permission",
      reason: "command override",
      why: "/test",
      args: { note: "hi" },
      principal: { kind: "command", requester: OWEN, override: true },
    });
    const published = decisions(g.events);
    expect(published.map((d) => [d.allowed, d.stage])).toEqual([
      [true, "permission"],
      [false, "permission"],
    ]);
  });
});

describe("self-review", () => {
  const high = () => request("t.high", self(), { note: "x" }, "因為想試試");
  /** No rate limits in the way of repeated reviews. */
  const gateWithoutLimits = async () => {
    const g = await gate();
    g.registry.configure({
      ...g.registry.config,
      medium: { per_day: 100, per_person_per_day: 100, cooldown_ms: 0 },
    });
    return g;
  };

  it("allow and deny come from the review call, which sees no chat text", async () => {
    const g = await gateWithoutLimits();
    g.router.replies.push('{"verdict": "allow", "reason": "安全"}');
    const ok = await g.registry.invoke(high());
    expect(ok.status).toBe("done");
    expect(ok.decision).toMatchObject({ stage: "review", reason: "安全" });
    const [purpose, req] = g.router.requests[0] ?? [];
    expect(purpose).toBe("review");
    expect(req?.thinking).toBe(true);
    expect(req?.json_mode).toBe(true);
    expect(req?.messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(req?.messages[1]?.content).toContain('"capability": "t.high"');
    expect(req?.messages[1]?.content).toContain("因為想試試");

    g.router.replies.push('```json\n{"verdict": "deny", "reason": "不需要"}\n```');
    const no = await g.registry.invoke(high());
    expect(no.status).toBe("denied");
    expect(no.decision).toMatchObject({ stage: "review", reason: "不需要" });

    g.router.replies.push(new Error("provider down"));
    const failed = await g.registry.invoke(high());
    expect(failed.decision.reason).toContain("self-review failed");
  });

  it("falls back to the chat chain when review is not configured", async () => {
    const g = await gateWithoutLimits();
    g.router.hasReview = false;
    g.router.replies.push('{"verdict": "allow", "reason": "ok"}');
    expect((await g.registry.invoke(high())).status).toBe("done");
    expect(g.router.requests[0]?.[0]).toBe("review");
  });

  it("uncertain asks the owners; an approval runs it", async () => {
    const g = await gateWithoutLimits();
    g.router.replies.push('{"verdict": "uncertain", "reason": "要問主人"}');
    const pending = g.registry.invoke(high());
    await vi.waitFor(() => expect(g.replies.sent.length).toBe(1));
    const [to, card] = g.replies.sent[0] ?? [];
    expect(to).toEqual(OWNER);
    expect(card?.card?.title).toBe("需要你的確認");
    const buttons = card?.card?.blocks.find((b) => b.type === "buttons");
    const approve = buttons?.type === "buttons" ? buttons.buttons[0]?.id : undefined;
    expect(approve?.startsWith(`mi:${APPROVE_ROUTE}:`)).toBe(true);
    const id = approve?.split(":").at(-1) ?? "";
    expect(g.registry.escalations.isPending(id)).toBe(true);
    expect(g.registry.escalations.resolve(id, true, OWNER)).toBe(true);
    const out = await pending;
    expect(out.status).toBe("done");
    expect(out.decision).toMatchObject({ stage: "escalation", reason: "approved by discord:900" });
    expect(g.registry.escalations.resolve(id, true, OWNER), "answered once").toBe(false);
  });

  it("no answer in time is a deny; no reachable owner too", async () => {
    vi.useFakeTimers();
    const g = await gateWithoutLimits();
    g.registry.configure({ ...g.registry.config, escalation_timeout_ms: 60_000 });
    g.router.replies.push('{"verdict": "uncertain", "reason": "?"}');
    const pending = g.registry.invoke(high());
    await vi.waitFor(() => expect(g.replies.sent.length).toBe(1));
    await vi.advanceTimersByTimeAsync(60_000);
    const out = await pending;
    expect(out.status).toBe("denied");
    expect(out.decision.reason).toContain("no owner answered in time");
    expect(g.runs).toEqual([]);

    g.replies.fail = true;
    g.router.replies.push('{"verdict": "uncertain", "reason": "?"}');
    const unsent = await g.registry.invoke(high());
    expect(unsent.decision.reason).toContain("could not be sent");
  });

  it("a review that hangs times out as a deny", async () => {
    vi.useFakeTimers();
    const g = await gateWithoutLimits();
    g.router.hang = true;
    const pending = g.registry.invoke(high());
    await vi.advanceTimersByTimeAsync(g.registry.config.review_timeout_ms);
    expect((await pending).decision.reason).toBe("self-review failed (timed out)");
  });

  it("parses verdicts strictly", () => {
    expect(parseReview('{"verdict":"ALLOW","reason":" r "}')).toEqual({
      verdict: "allow",
      reason: "r",
    });
    expect(() => parseReview('{"verdict":"maybe"}')).toThrow(/unknown review verdict/);
    expect(() => parseReview("nope")).toThrow(/no JSON/);
  });
});

/** Records submitted actions and lets the test run or drop them like the scheduler. */
class FakeScheduler implements ActionSink {
  readonly actions: Action[] = [];
  readonly cancelled: TurnId[] = [];

  async submit(action: Action): Promise<void> {
    this.actions.push(action);
  }

  async cancelTurn(turn: TurnId): Promise<void> {
    this.cancelled.push(turn);
  }
}

function toolCtx(principal: Principal, signal = new AbortController().signal): ToolContext {
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

describe("tools and the scheduler", () => {
  it("capability tools carry the principal; on_own turns into self", async () => {
    const g = await gate();
    const tool = g.tools.get("t_low");
    expect(tool).toBeInstanceOf(CapabilityTool);
    expect(tool?.permission).toBeNull();
    expect(tool?.spec.description).toContain("只是請求");
    const params = tool?.spec.parameters as { properties: Record<string, unknown> };
    expect(Object.keys(params.properties).sort()).toEqual(["note", "on_own", "why"]);

    // Owen may not ask for it ...
    await expect(tool?.call(toolCtx(user()), { note: "a" })).rejects.toBeInstanceOf(
      ActionDeniedError,
    );
    // ... but she may decide to do it herself.
    expect(await tool?.call(toolCtx(user()), { note: "a", on_own: true, why: "想" })).toBe(
      "ran t.low: a",
    );
    const last = decisions(g.events).at(-1);
    expect(last).toMatchObject({
      principal: { kind: "self", requester: OWEN },
      why: "想",
      args: { note: "a" },
    });
  });

  it("from a turn, runs are queued in the lane and settle when the scheduler acts", async () => {
    const g = await gate();
    const scheduler = new FakeScheduler();
    g.services.provide("scheduler", ActionSinkKey, scheduler);
    g.authorizer.grant(OWEN, "test.low");
    const tool = g.tools.get("t_low");
    const result = tool?.call(toolCtx(user()), { note: "q" });
    await vi.waitFor(() => expect(scheduler.actions.length).toBe(1));
    const action = scheduler.actions[0] as Action;
    expect(action.lane).toBe("act:test");
    expect(action.priority).toBe("direct");
    expect(action.turn).toBe("01JC0000000000000000000000");
    expect(action.payload).toMatchObject({ type: "actuate", capability: "t.low", context: CTX });
    expect(g.runs).toEqual([]);
    const ticket = action.payload.type === "actuate" ? action.payload.ticket : "";
    expect(await g.registry.run(ticket, new AbortController().signal)).toBe("ran t.low: q");
    expect(await result).toBe("ran t.low: q");

    // Dropped (turn cancelled, expired): the call fails without running.
    const dropped = tool?.call(toolCtx(user()), { note: "z" });
    await vi.waitFor(() => expect(scheduler.actions.length).toBe(2));
    const second = scheduler.actions[1] as Action;
    g.registry.dropped(second.payload.type === "actuate" ? second.payload.ticket : "", "cancelled");
    await expect(dropped).rejects.toThrow(/dropped by the scheduler: cancelled/);
    expect(g.runs).toEqual(["t.low"]);
  });

  it("high-risk tools answer at once and are reviewed on their own", async () => {
    const g = await gate();
    g.authorizer.grant(OWEN, "test.high");
    g.router.replies.push('{"verdict": "allow", "reason": "ok"}');
    expect(await g.tools.get("t_high")?.call(toolCtx(user()), {})).toBe(REVIEW_PENDING);
    await vi.waitFor(() => expect(g.runs).toEqual(["t.high"]));
  });

  it("unregistering removes the tool", async () => {
    const g = await gate();
    expect(g.tools.get("t_medium")).toBeDefined();
    g.registry.unregister("t.medium");
    expect(g.tools.get("t_medium")).toBeUndefined();
  });
});

describe("message.dm", () => {
  it("needs consent and familiarity, then goes through the scheduler", async () => {
    const g = await gate();
    const scheduler = new FakeScheduler();
    g.services.provide("scheduler", ActionSinkKey, scheduler);
    const { PlatformSinks, PlatformSinksKey } = await import("@miyoria/types");
    const sinks = new PlatformSinks();
    const opened: string[] = [];
    sinks.register({
      platform: "discord",
      send: async () => ({ context: CTX, id: "x" }),
      react: async () => {},
      typing: async () => {},
      openDm: async (account) => {
        opened.push(account.id);
        return { platform: "discord", scope: null, channel: `dm-${account.id}`, kind: "dm" };
      },
    });
    g.services.provide("kernel", PlatformSinksKey, sinks);
    expect(g.registry.get("message.dm")).toBe(messageDm);

    // A stranger: never on her own.
    const stranger = await g.registry.invoke(
      request("message.dm", self(), { to: `<@${AMY.id}>`, text: "嗨" }),
    );
    expect(stranger.decision).toMatchObject({ stage: "prohibition" });
    g.social.set(AMY, { familiarity: 40 });
    await g.registry.privacy.set(AMY, { dm: false });
    const optedOut = await g.registry.invoke(
      request("message.dm", self(), { to: AMY.id, text: "嗨" }),
    );
    expect(optedOut.decision.stage).toBe("consent");
    await g.registry.privacy.set(AMY, { dm: true });

    const sent = await g.registry.invoke(
      request("message.dm", self(), { to: AMY.id, text: "嗨 @everyone <@&55>" }),
    );
    expect(sent.status).toBe("done");
    expect(opened).toEqual([AMY.id]);
    expect(scheduler.actions[0]?.payload).toEqual({
      type: "send_message",
      context: { platform: "discord", scope: null, channel: "dm-200", kind: "dm" },
      message: { text: "嗨 everyone", reply_to: null },
    });
    expect(scheduler.actions[0]?.priority).toBe("initiative");
  });
});

describe("autonomous requests", () => {
  it("apply the consent and per-person limits of whom they are about", async () => {
    const g = await gate();
    g.registry.register(
      defineCapability({
        name: "t.join",
        summary: "test join",
        risk: "medium",
        args: z.object({}),
        permission: null,
        limits: { per_day: 10, per_person_per_day: 1, cooldown_ms: 0 },
        async execute() {
          return "joined";
        },
      }),
    );
    const about = (who: typeof OWEN) => ({ ...request("t.join", self()), about: who });
    await g.registry.privacy.set(OWEN, { approach: false });
    const out = await g.registry.invoke(about(OWEN));
    expect(out.decision).toMatchObject({ allowed: false, stage: "consent" });
    // Someone asking for it themselves is not being approached.
    const asked = await g.registry.invoke({ ...request("t.join", user(OWEN)), about: OWEN });
    expect(asked.status).toBe("done");

    expect((await g.registry.invoke(about(AMY))).status).toBe("done");
    // The capability's own default: one per person per day.
    const again = await g.registry.invoke(about(AMY));
    expect(again.decision).toMatchObject({ stage: "rate" });
    expect(again.decision.reason).toContain("this person");
  });

  it("list pending approvals with what they ask for, answerable by a panel actor", async () => {
    const g = await gate();
    g.router.replies.push('{"verdict": "uncertain", "reason": "要問主人"}');
    const pending = g.registry.invoke(request("t.high", self(), { note: "x" }, "想試試看"));
    await vi.waitFor(() => expect(g.registry.escalations.pending().length).toBe(1));
    const [item] = g.registry.escalations.pending();
    expect(item).toMatchObject({
      capability: "t.high",
      summary: "test high",
      principal: "self",
      args: { note: "x" },
      why: "想試試看",
      review: "要問主人",
    });
    expect(Date.parse(item?.expires_at ?? "")).toBeGreaterThan(
      Date.parse(item?.requested_at ?? ""),
    );
    expect(g.registry.escalations.resolve(item?.id ?? "", false, "panel:api")).toBe(true);
    const out = await pending;
    expect(out.decision).toMatchObject({ allowed: false, stage: "escalation" });
    expect(out.decision.reason).toContain("denied by panel:api");
  });
});
