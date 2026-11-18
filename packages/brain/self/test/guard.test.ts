import { ActuatorRegistryKey } from "@miyoria/gate/actions";
import { LlmRouterKey } from "@miyoria/llm/llm";
import type { ToolEntry } from "@miyoria/llm/tools";
import {
  AuthorizerKey,
  type ContextKey,
  DirectivesKey,
  FloorKey,
  GameSecretsKey,
  type InputServices,
  type ServiceKey,
} from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { composeGuards, permissiveGuard } from "../src/guard.js";
import { LINE_REFUSALS, REFUSALS } from "../src/rules.js";
import { floorKind, serviceGuard } from "../src/service-guard.js";
import { ALLOW, type GuardContext, refuse, type Wake } from "../src/types.js";
import { addressed, CTX, SESSION } from "./harness.js";

// biome-ignore lint/suspicious/noExplicitAny: a key of any service, beside a fake of it.
function services(entries: [ServiceKey<any>, unknown][]): InputServices {
  const map = new Map<unknown, unknown>(entries);
  return { get: <T>(key: ServiceKey<T>) => map.get(key) as T | undefined };
}

const ctx = (wake: Wake = addressed()): GuardContext => ({
  session: SESSION,
  turn: "t1",
  wake,
  profile: "text",
  now: Date.UTC(2026, 10, 16, 12),
});

const call = (name: string, over: Partial<ToolEntry> = {}) => ({
  call: { id: "c1", name, arguments: "{}" },
  args: {},
  entry: {
    name,
    effect: "act",
    speed: "instant",
    tool: { permission: null },
    ...over,
  } as unknown as ToolEntry,
});

describe("the service guard", () => {
  it("lets everything through when no service is there", async () => {
    const g = serviceGuard({ services: services([]) });
    expect(await g.checkCall(call("look"), ctx())).toEqual(ALLOW);
    expect(await g.checkLine(CTX, "嗨", ctx())).toEqual(ALLOW);
  });

  it("refuses what the owner's directives forbid", async () => {
    const directives = {
      filterTools: <T extends { name: string }>(tools: readonly T[]) =>
        tools.filter((t) => t.name !== "play_game"),
    };
    const g = serviceGuard({ services: services([[DirectivesKey, directives]]) });
    expect(await g.checkCall(call("play_game"), ctx())).toEqual(
      refuse("directive", REFUSALS.directive),
    );
    expect(await g.checkCall(call("look"), ctx())).toEqual(ALLOW);
  });

  it("a tool with a permission needs someone allowed to ask", async () => {
    const authorizer = { allows: (account: { id: string }) => account.id === "u1" };
    const g = serviceGuard({ services: services([[AuthorizerKey, authorizer]]) });
    const needs = call("ban", { tool: { permission: "mod.ban" } } as Partial<ToolEntry>);
    expect(await g.checkCall(needs, ctx())).toEqual(ALLOW);
    expect(await g.checkCall(needs, ctx({ kind: "self", note: null }))).toEqual(
      refuse("permission", REFUSALS.permissionNobody),
    );
    const other: Wake = {
      kind: "addressed",
      reason: "mention",
      from: { account: { platform: "discord", id: "u2" }, name: "Amy" },
      message: { context: CTX, id: "m2" },
    };
    expect(await g.checkCall(needs, ctx(other))).toEqual(
      refuse("permission", REFUSALS.permissionAsker),
    );
  });

  it("paused: only looking; the budget gone: nothing outside or long", async () => {
    const paused = serviceGuard({ services: services([[ActuatorRegistryKey, { paused: true }]]) });
    expect((await paused.checkCall(call("play"), ctx())).allow).toBe(false);
    expect(await paused.checkCall(call("look", { effect: "read" }), ctx())).toEqual(ALLOW);
    const broke = serviceGuard({
      services: services([[LlmRouterKey, { budgetState: () => "exhausted" }]]),
    });
    expect(await broke.checkCall(call("search", { effect: "external" }), ctx())).toEqual(
      refuse("budget", REFUSALS.budget),
    );
    expect(await broke.checkCall(call("note"), ctx())).toEqual(ALLOW);
  });

  it("the Floor's caps decide a line, by what woke her", async () => {
    const asked: [string, ContextKey][] = [];
    const floor = {
      refuses: (kind: string, place: ContextKey) => {
        asked.push([kind, place]);
        return kind === "ambient" ? "你在這裡講太多了" : null;
      },
    };
    const g = serviceGuard({ services: services([[FloorKey, floor]]) });
    expect(await g.checkLine(CTX, "嗨", ctx())).toEqual(ALLOW);
    expect(await g.checkLine(CTX, "嗨", ctx({ kind: "glance", lines: 3 }))).toEqual(
      refuse("floor", "你在這裡講太多了"),
    );
    expect(asked.map(([kind]) => kind)).toEqual(["addressed", "ambient"]);
    expect(floorKind({ kind: "timer", note: "x" })).toBe("wish");
  });

  it("a line in another place claims that place's Floor as a start of hers", async () => {
    const asked: [string, ContextKey][] = [];
    const floor = {
      refuses: (kind: string, place: ContextKey) => {
        asked.push([kind, place]);
        return null;
      },
    };
    const g = serviceGuard({ services: services([[FloorKey, floor]]) });
    const elsewhere: ContextKey = { ...CTX, channel: "elsewhere" };
    expect(await g.checkLine(elsewhere, "嗨", ctx())).toEqual(ALLOW);
    expect(await g.checkLine(elsewhere, "嗨", ctx({ kind: "glance", lines: 2 }))).toEqual(ALLOW);
    expect(asked).toEqual([
      ["notable", elsewhere],
      ["wish", elsewhere],
    ]);
  });

  it("a line that gives a game's secret away is refused, with the plain answer to say instead", async () => {
    const asked: [ContextKey, string][] = [];
    const secrets = {
      leak: (place: ContextKey, text: string) => {
        asked.push([place, text]);
        return text.includes("按鈕") ? { word: "按鈕", instead: "很接近了!" } : null;
      },
    };
    const g = serviceGuard({ services: services([[GameSecretsKey, secrets]]) });
    expect(await g.checkLine(CTX, "很接近了,想想電梯按鈕", ctx())).toEqual(
      refuse("game_secret", LINE_REFUSALS.gameSecret("按鈕"), "很接近了!"),
    );
    expect(await g.checkLine(CTX, "很接近了!", ctx())).toEqual(ALLOW);
    expect(asked.map(([place]) => place)).toEqual([CTX, CTX]);
    const none = { leak: () => ({ word: "傘", instead: null }) };
    const quiet = serviceGuard({ services: services([[GameSecretsKey, none]]) });
    expect(await quiet.checkLine(CTX, "帶傘", ctx())).toEqual(
      refuse("game_secret", LINE_REFUSALS.gameSecret("傘")),
    );
  });

  it("a line the output review would change is refused, not rewritten", async () => {
    const g = serviceGuard({ services: services([]) });
    expect(await g.checkLine(CTX, "@everyone 來看", ctx())).toEqual(
      refuse("unsafe_output", LINE_REFUSALS.unsafe),
    );
  });
});

describe("composed guards", () => {
  it("the first refusal answers", async () => {
    const no = {
      checkCall: async () => refuse("a", "不行"),
      checkLine: async () => refuse("b", "不行"),
    };
    const g = composeGuards(permissiveGuard, no, {
      checkCall: async () => refuse("c", "也不行"),
      checkLine: async () => ALLOW,
    });
    expect(await g.checkCall(call("x"), ctx())).toEqual(refuse("a", "不行"));
    expect(await g.checkLine(CTX, "嗨", ctx())).toEqual(refuse("b", "不行"));
    expect(g.screenResult?.("結果", ctx())).toBe("結果");
  });
});
