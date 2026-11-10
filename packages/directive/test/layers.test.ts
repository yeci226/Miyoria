// The three layers on the real action path: what the gate does with a rule, who it binds, and what
// disappears from the tool list. And what an unclear statement comes back as.

import { defineCapability } from "@miyoria/actions";
import { ServiceRegistry } from "@miyoria/kernel";
import { type Tool, ToolRegistryKey } from "@miyoria/tools";
import {
  ActionSinkKey,
  type ActivityManager,
  ActivityManagerKey,
  type ActivityRequest,
  type ActivityTransition,
  type DirectiveEffect,
  type DirectiveGoal,
  type DirectiveScope,
  type HerActivity,
  type JsonValue,
  type Principal,
  Principals,
  toTimestamp,
} from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { DirectiveService, directiveTools } from "../src/index.js";
import {
  BLOCKED,
  CTX,
  closeStores,
  ELSEWHERE,
  gameArgs,
  MOD,
  OWNER,
  ownerRule,
  person,
  self,
  toolContext,
  VIEWER,
  type World,
  world,
} from "./helpers.js";

afterEach(closeStores);

const NO_MINECRAFT = { text: "不要玩 Minecraft", activity: "minecraft" };

const ask = (w: World, capability: string, principal: Principal, args: JsonValue = {}) =>
  w.registry.invoke({ principal, capability, args, why: null, turn: null });

describe("the gate", () => {
  it("a deny binds everyone, the owner's own commands and the panel included", async () => {
    const w = await world();
    await ownerRule(w, NO_MINECRAFT);
    for (const principal of [
      self(),
      Principals.user(VIEWER, CTX),
      Principals.director(CTX),
      Principals.command(MOD, CTX, true),
      Principals.command(OWNER, CTX, true),
      Principals.panel("api", CTX),
    ]) {
      const outcome = await ask(w, "game.start", principal);
      expect(outcome).toMatchObject({ status: "denied", decision: { stage: "directive" } });
    }
    expect(w.ran).toEqual([]);
  });

  it("the audit log says which rule stopped it", async () => {
    const w = await world();
    await ownerRule(w, NO_MINECRAFT);
    await ask(w, "game.start", self());
    const [entry] = await w.store.audit.recent(1, "self");
    expect(entry).toMatchObject({ action: "gate.game.start", ok: false });
    expect(JSON.stringify(entry?.detail)).toContain("不要玩 Minecraft");
  });

  it("a rule on what she plays catches the default game, and leaves the others alone", async () => {
    const w = await world();
    await ownerRule(w, NO_MINECRAFT);
    // `game` left out means Minecraft: the capability's own mapping says so.
    expect((await ask(w, "game.start", self())).status).toBe("denied");
    expect((await ask(w, "game.start", self(), { game: "MineCraft" })).status).toBe("denied");
    expect((await ask(w, "game.start", self(), { game: "osu" })).status).toBe("done");
  });

  it("the words of a rule survive spelling games", async () => {
    const w = await world();
    await ownerRule(w, NO_MINECRAFT);
    for (const game of ["Ｍｉｎｅｃｒａｆｔ", "mine craft", "mine\u200bcraft", "MINE-CRAFT"]) {
      expect((await ask(w, "game.start", self(), { game })).status, game).toBe("denied");
    }
  });

  it("stopping what a rule forbids is always open, unless the rule names the stop", async () => {
    const w = await world();
    await ownerRule(w, NO_MINECRAFT);
    await ownerRule(w, { text: "什麼都不要做", capability: "*" });
    expect((await ask(w, "game.stop", self())).status).toBe("done");
    expect((await ask(w, "game.goal", self(), { text: "x" })).status).toBe("denied");
    await ownerRule(w, { text: "不准關遊戲", capability: "game.stop" });
    expect((await ask(w, "game.stop", self())).status).toBe("denied");
  });

  it("game.goal does not name the game: the one she is playing counts", async () => {
    const w = await world();
    w.services.provide("activity", ActivityManagerKey, {
      snapshot: () => ({ activity: { type: "game", target: "minecraft" } }),
    } as never);
    await ownerRule(w, NO_MINECRAFT);
    expect((await ask(w, "game.goal", self(), { text: "去挖鐵礦" })).status).toBe("denied");
  });

  it("a rule made while a run waits in its lane still stops it", async () => {
    const w = await world();
    let ticket = "";
    w.services.provide("scheduler", ActionSinkKey, {
      submit: async (action: { payload: { ticket: string } }) => {
        ticket = action.payload.ticket;
      },
    } as never);
    const running = w.registry.invoke(
      {
        principal: self(),
        capability: "game.start",
        args: {},
        why: null,
        turn: null,
      },
      { priority: "direct", lane: "game" as never },
    );
    await until(() => ticket !== "");
    await ownerRule(w, NO_MINECRAFT);
    await expect(w.registry.run(ticket, new AbortController().signal)).rejects.toThrow(
      "不要玩 Minecraft",
    );
    expect((await running).status).toBe("failed");
    expect(w.ran).toEqual([]);
  });

  it("require_approval goes to the owners; without one to ask it does not happen", async () => {
    const w = await world();
    await ownerRule(w, { text: "開台要先問過", capability: "stream.start" }, "require_approval");
    const outcome = await ask(w, "stream.start", self());
    expect(outcome).toMatchObject({ status: "denied", decision: { stage: "escalation" } });
    expect(w.ran).toEqual([]);
  });

  it("the owner asking is the approval; a moderator asking is not", async () => {
    const w = await world();
    await ownerRule(w, { text: "開台要先問過", capability: "stream.start" }, "require_approval");
    expect((await ask(w, "stream.start", Principals.command(MOD, CTX))).status).toBe("denied");
    expect((await ask(w, "stream.start", Principals.user(OWNER, CTX))).status).toBe("done");
    expect((await ask(w, "stream.start", Principals.panel("api", CTX))).status).toBe("done");
    expect((await ask(w, "stream.start", Principals.panel("discord:2", CTX))).status).toBe(
      "denied",
    );
  });

  it("prefer and avoid are said to her and stop nothing", async () => {
    const w = await world();
    await ownerRule(w, { text: "少開台", capability: "stream.start" }, "avoid");
    await ownerRule(w, { text: "多玩 osu", activity: "osu" }, "prefer");
    expect((await ask(w, "stream.start", self())).status).toBe("done");
    expect(w.rules.inject(CTX).join("\n")).toMatch(/盡量不要:少開台[\s\S]*偏好:多玩 osu/);
  });

  it("a rule for one channel binds there, and an action nobody can place", async () => {
    const w = await world();
    await w.rules.add({
      by: person(OWNER),
      text: "這裡不要開台",
      effect: "deny",
      scope: { capability: "stream.start", context: CTX },
      minutes: null,
      source_event: "msg:m1",
    });
    expect((await ask(w, "stream.start", Principals.self(ELSEWHERE))).status).toBe("done");
    expect((await ask(w, "stream.start", Principals.self(CTX))).status).toBe("denied");
    expect((await ask(w, "stream.start", Principals.self(null))).status).toBe("denied");
    expect(w.rules.inject(ELSEWHERE)).toEqual([]);
  });
});

describe("the tool list", () => {
  const SPECS = [
    { name: "game_start" },
    { name: "game_stop" },
    { name: "game_goal" },
    { name: "stream_start" },
    { name: "memory_note" },
    { name: "directive_add" },
    { name: "directive_remove" },
  ];

  it("loses what a rule forbids and keeps what ends it", async () => {
    const w = await world();
    await ownerRule(w, NO_MINECRAFT);
    await ownerRule(w, { text: "不要開台", capability: "stream.*" });
    expect(w.rules.filterTools(SPECS, CTX).map((t) => t.name)).toEqual([
      "game_stop",
      "game_goal",
      "memory_note",
      "directive_add",
      "directive_remove",
    ]);
  });

  it("a rule can name a tool that is no capability", async () => {
    const w = await world();
    w.services.get(ToolRegistryKey)?.register({
      spec: { name: "memory_note", description: "", parameters: { type: "object" } },
      call: async () => "",
    });
    await ownerRule(w, { text: "不要記筆記", capability: "memory_note" });
    expect(w.rules.filterTools([{ name: "memory_note" }], CTX)).toEqual([]);
  });

  it("a deny on everything still leaves the way to lift it", async () => {
    const w = await world();
    await ownerRule(w, { text: "全部不要動", capability: "*" });
    const left = w.rules.filterTools(SPECS, CTX).map((t) => t.name);
    expect(left).toContain("directive_remove");
    expect(left).toContain("game_stop");
    expect(left).not.toContain("game_start");
  });

  it("a rule for another channel, or one that only asks first, removes nothing", async () => {
    const w = await world();
    await ownerRule(w, { text: "開台要先問", capability: "stream.start" }, "require_approval");
    await w.rules.add({
      by: person(OWNER),
      text: "那裡不要開遊戲",
      effect: "deny",
      scope: { capability: "game.start", context: ELSEWHERE },
      minutes: null,
      source_event: "msg:m1",
    });
    const names = w.rules.filterTools(SPECS, CTX).map((t) => t.name);
    expect(names).toContain("stream_start");
    expect(names).toContain("game_start");
  });
});

describe("the system block", () => {
  it("is every rule in force, strongest first, with no search involved", async () => {
    const w = await world();
    await w.rules.add({
      by: person(MOD),
      text: "一小時不要開台",
      effect: "deny",
      scope: { capability: "stream.start" },
      minutes: 60,
      source_event: "command:x",
    });
    await ownerRule(w, NO_MINECRAFT);
    const lines = w.rules.inject(CTX);
    expect(lines[0]).toContain("禁止:不要玩 Minecraft(主人,直到解除)");
    expect(lines[1]).toContain("禁止:一小時不要開台(管理員,到 ");
  });
});

describe("an unclear statement", () => {
  const tool = (w: World) => (directiveTools(() => w.rules) as [Tool, Tool])[0];
  const owner = () => toolContext(Principals.user(OWNER, CTX));

  it("that names nothing to forbid becomes a question, not a rule", async () => {
    const w = await world();
    const said = await tool(w).call(owner(), { text: "不要這樣", effect: "deny" });
    expect(said).toContain("先問對方");
    expect(said).toContain("哪個動作");
    expect(await w.rules.list()).toEqual([]);
  });

  it("she can hand the question back herself", async () => {
    const w = await world();
    const said = await tool(w).call(owner(), {
      text: "少玩一點",
      effect: "deny",
      activity: "minecraft",
      question: "是今天不要玩,還是以後都少玩?",
    });
    expect(said).toContain("是今天不要玩,還是以後都少玩?");
    expect(await w.rules.list()).toEqual([]);
  });

  it("hedged words do not make a deny", async () => {
    const w = await world();
    const said = await tool(w).call(owner(), {
      text: "今天可能不要玩 Minecraft",
      effect: "deny",
      activity: "minecraft",
    });
    expect(said).toContain("先問對方");
    expect(await w.rules.list()).toEqual([]);
  });

  it("an effect she did not understand, or an action that does not exist, is asked about", async () => {
    const w = await world();
    expect(await tool(w).call(owner(), { text: "不要玩", effect: "ban" })).toContain("先問對方");
    expect(
      await tool(w).call(owner(), { text: "不要飛", effect: "deny", capability: "fly.start" }),
    ).toContain("fly.start");
    expect(await w.rules.list()).toEqual([]);
  });

  it("a moderator who gives no time is asked for one: there are no open-ended ones", async () => {
    const w = await world();
    const change = await w.rules.add({
      by: person(MOD),
      text: "不要開台",
      effect: "deny",
      scope: { capability: "stream.start" },
      minutes: null,
      source_event: "command:x",
    });
    expect(change).toMatchObject({ status: "question" });
    expect(await w.rules.list()).toEqual([]);
  });

  it("「可以了」 with two rules it could mean asks which one", async () => {
    const w = await world();
    await ownerRule(w, { text: "不要玩 Minecraft", activity: "minecraft" });
    await ownerRule(w, { text: "不要在 Minecraft 開台", capability: "stream.start" });
    const change = await w.rules.remove({
      by: person(OWNER),
      match: "minecraft",
      source_event: "msg:m2",
    });
    expect(change).toMatchObject({ status: "question" });
    expect(await w.rules.list()).toHaveLength(2);
    expect(
      await w.rules.remove({ by: person(OWNER), match: "天氣", source_event: "msg:m2" }),
    ).toMatchObject({ status: "refused", reason: "not_found" });
    expect(await w.rules.remove({ by: person(OWNER), source_event: "msg:m2" })).toMatchObject({
      status: "question",
    });
  });
});

describe("authority", () => {
  const wish = (who = OWNER) => ({
    by: person(who),
    text: "多聊音樂",
    effect: "prefer" as const,
    scope: {},
    minutes: null,
    source_event: "msg:m1",
  });

  it("comes from the account: blocked people get nothing", async () => {
    const w = await world();
    expect(await w.rules.add(wish(BLOCKED))).toMatchObject({
      status: "refused",
      reason: "authority",
    });
  });

  it("with nobody to ask who an account is, nobody is anyone", async () => {
    const w = await world();
    const blind = new DirectiveService({
      services: new ServiceRegistry(),
      store: w.flaky,
      profile: "miyoria",
    });
    expect(await blind.add(wish(OWNER))).toMatchObject({ status: "refused", reason: "authority" });
  });

  it("a moderator's rule holds against the owner's own command until someone removes it", async () => {
    const w = await world();
    await w.rules.add({
      by: person(MOD),
      text: "現在不要開台",
      effect: "deny",
      scope: { capability: "stream.start" },
      minutes: 30,
      source_event: "command:x",
    });
    expect((await ask(w, "stream.start", Principals.command(OWNER, CTX))).status).toBe("denied");
    const [rule] = await w.rules.list();
    await w.rules.remove({ by: person(OWNER), id: rule?.id ?? "", source_event: "msg:m1" });
    expect((await ask(w, "stream.start", Principals.command(OWNER, CTX))).status).toBe("done");
  });

  it("the bearer token of the panel has every right, and is told apart from a person", async () => {
    const w = await world();
    const change = await w.rules.add({
      by: { type: "console", actor: "api" },
      text: "不要開台",
      effect: "deny",
      scope: { capability: "stream.start" },
      minutes: null,
      source_event: "panel:api",
    });
    expect(change).toMatchObject({
      status: "added",
      directive: { authority: "owner", issuer: { platform: "panel", id: "api" } },
    });
  });
});

describe("a capability that cannot say what it is about", () => {
  it("is refused on the action path, and only guessed at for the tool list", async () => {
    const w = await world();
    w.registry.register(
      defineCapability({
        name: "message.dm",
        summary: "私訊",
        risk: "low",
        args: z.object({ to: z.string() }),
        permission: null,
        tool: { name: "message_dm", description: "私訊", properties: {} },
        target: (args) => ({ platform: "discord", id: args.to.trim() }),
        execute: async () => "ok",
      }),
    );
    await ownerRule(w, { text: "不要開台", capability: "stream.*" });
    const broken = await w.rules.check({
      capability: "message.dm",
      args: {},
      principal: self(),
    });
    expect(broken).toMatchObject({ outcome: "deny", directive: null });
    expect(w.rules.filterTools([{ name: "message_dm" }], CTX)).toHaveLength(1);
  });
});

describe("arguments the rules read", () => {
  it("what she says about an action is not the action", async () => {
    const w = await world();
    await ownerRule(w, { text: "不要挖鑽石", activity: "diamond" });
    const allowed = await w.rules.check({
      capability: "game.act",
      args: gameArgs({ call: { action: "obtain", args: { item: "iron" } }, why: "不是 diamond" }),
      principal: self(),
    });
    expect(allowed).toEqual({ outcome: "allow" });
  });
});

/** Waits for `done` over a few turns of the event loop. */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !done(); i++) await new Promise((r) => setTimeout(r, 1));
  expect(done()).toBe(true);
}

describe("a rule takes effect (§9)", () => {
  const rule = (w: World, scope: DirectiveScope, effect: DirectiveEffect = "deny") =>
    w.rules.add({
      by: person(OWNER),
      text: "不要做這件事",
      effect,
      scope,
      minutes: null,
      source_event: "msg:m1",
    });

  /** Her body, as far as a rule reads it and asks it to stop. */
  function body(w: World, activity: HerActivity) {
    const stops: ActivityRequest[] = [];
    w.services.provide("test", ActivityManagerKey, {
      snapshot: () => ({ activity }),
      request: async ({ request }: ActivityTransition) => {
        stops.push(request);
        return { status: "started", task: "t", resource: "activity" };
      },
    } as unknown as ActivityManager);
    return stops;
  }
  const game = (target: string, type: "game" | "singing" = "game"): HerActivity => ({
    type,
    target,
    phase: "running",
    task: null,
    failure: null,
    since: toTimestamp(0),
  });

  it.each<[string, DirectiveScope]>([
    ["the game by name", { activity: "minecraft" }],
    ["the family of capabilities", { capability: "game.*" }],
    ["its start", { capability: "game.start" }],
    ["both at once", { capability: "game.start", activity: "Mine Craft" }],
  ])("%s stops it", async (_name, scope) => {
    const w = await world();
    const stops = body(w, game("minecraft"));
    const change = await rule(w, scope);
    expect(stops).toEqual([{ type: "stop", activity: "game" }]);
    expect(change.status === "added" ? change.note : null).toContain("minecraft");
  });

  it.each<[string, DirectiveScope, HerActivity]>([
    ["another game", { activity: "osu" }, game("minecraft")],
    ["a word of the goal", { activity: "diamond" }, game("minecraft")],
    ["everything", { capability: "*" }, game("minecraft")],
    ["another capability", { capability: "stream.*" }, game("minecraft")],
    ["stopping itself", { capability: "game.stop" }, game("minecraft")],
    ["one channel", { activity: "minecraft", context: CTX }, game("minecraft")],
    ["one person", { activity: "minecraft", person: "owen" }, game("minecraft")],
    ["nothing running", { activity: "minecraft" }, { type: "idle", since: toTimestamp(0) }],
  ])("%s leaves it running", async (_name, scope, activity) => {
    const w = await world();
    const stops = body(w, activity);
    await rule(w, scope);
    expect(stops).toEqual([]);
  });

  it("only a `deny` does", async () => {
    const w = await world();
    const stops = body(w, game("minecraft"));
    await rule(w, { activity: "minecraft" }, "avoid");
    await rule(w, { activity: "minecraft" }, "require_approval");
    expect(stops).toEqual([]);
  });

  it("a song is stopped by the singer", async () => {
    const w = await world();
    const ran: unknown[] = [];
    w.registry.register(
      defineCapability({
        name: "sing.stop",
        summary: "stop",
        risk: "low",
        args: z.looseObject({}),
        permission: null,
        async execute(args) {
          ran.push(args);
          return "ok";
        },
      }),
    );
    const stops = body(w, game("song-1", "singing"));
    await rule(w, { capability: "sing.*" });
    expect(stops).toEqual([]);
    expect(ran).toEqual([{ all: false }]);
  });

  it("a rule that cannot stop it is still a rule, and says so", async () => {
    const w = await world();
    body(w, game("minecraft"));
    const manager = w.services.require(ActivityManagerKey);
    manager.request = async () => ({
      status: "refused",
      resource: "activity",
      code: "internal",
      detail: "壞了",
    });
    const change = await rule(w, { activity: "minecraft" });
    expect(change.status).toBe("added");
    expect(change.status === "added" ? change.note : null).toContain("壞了");
  });
});

describe("her goals (§9)", () => {
  const goal = (what: string, over: Partial<DirectiveGoal> = {}): DirectiveGoal => ({
    what,
    why: "",
    steps: [],
    person: null,
    context: null,
    ...over,
  });

  it("a deny reads the words of a goal", async () => {
    const w = await world();
    await ownerRule(w, { text: "不要玩", capability: "game.start", activity: "minecraft" });
    expect(w.rules.forbids(goal("今晚玩 Minecraft"))?.scope.activity).toBe("minecraft");
    expect(w.rules.forbids(goal("開台", { steps: ["開台", "玩 MINECRAFT"] }))).not.toBeNull();
    expect(w.rules.forbids(goal("唱歌"))).toBeNull();
  });

  it("only what the rule names: a capability alone, or a softer rule, leaves goals alone", async () => {
    const w = await world();
    await ownerRule(w, { text: "不要玩遊戲", capability: "game.*" });
    await ownerRule(w, { text: "少玩", activity: "minecraft" }, "avoid");
    expect(w.rules.forbids(goal("玩 Minecraft"))).toBeNull();
  });

  it("a rule about a person covers goals about them", async () => {
    const w = await world();
    await w.rules.add({
      by: person(OWNER),
      text: "不要找 Owen",
      effect: "deny",
      scope: { person: "owen" },
      minutes: null,
      source_event: "msg:m1",
    });
    expect(w.rules.forbids(goal("問他報告", { person: "Owen" }))).not.toBeNull();
    expect(w.rules.forbids(goal("問她報告", { person: "Amy" }))).toBeNull();
  });
});
