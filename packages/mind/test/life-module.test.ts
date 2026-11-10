// The mind module runs her own life (v4 §8): the life log follows the bus, `remind_me` is a tool
// whose timers reach the main line as proposals, her Plan sees where her wants lead and cannot
// start a game past its share of her day, and daily posts stay off unless configured.

import { ActuatorRegistryKey, defineCapability } from "@miyoria/actions";
import {
  ACTIVITY_CHANGED_TOPIC,
  customEvent,
  DailyPostsKey,
  type JsonValue,
  LifeLogKey,
  type NewProposal,
  Principals,
  type ProposalBoard,
  ProposalBoardKey,
  type ProposalOutcome,
  ReminderDeskKey,
  toTimestamp,
} from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { REMINDER_PREFIX } from "../src/index.js";
import { callKind, ScriptedProvider, texts } from "./fakes.js";
import { rig, salient, stopRigs, TEXT, wait } from "./helpers.js";

const T0 = Date.parse("2026-11-02T12:00:00.000Z"); // 20:00 at UTC+8
const MIN = 60_000;
const HOUR = 60 * MIN;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(async () => {
  await stopRigs();
  vi.useRealTimers();
});

class FakeBoard implements ProposalBoard {
  readonly proposals: NewProposal[] = [];
  async propose(p: NewProposal): Promise<ProposalOutcome> {
    this.proposals.push(structuredClone(p));
    return { id: `P${this.proposals.length}`, state: "open", detail: "", turn: null };
  }
  open() {
    return [];
  }
}

function fake(name: string) {
  return defineCapability({
    name,
    summary: `fake ${name}`,
    risk: "low",
    args: z.looseObject({}),
    permission: null,
    async execute() {
      return "ok";
    },
  });
}

describe("her own life in the mind module", () => {
  it("provides the life log, her timers and her (off) daily posts, and registers remind_me", async () => {
    const r = await rig(new ScriptedProvider(() => "{}"));
    expect(r.sup.services.get(LifeLogKey)?.summary()).toBeNull();
    expect(r.sup.services.get(ReminderDeskKey)?.list()).toEqual([]);
    expect(r.sup.services.get(DailyPostsKey)?.channel()).toBeNull();
    expect(r.registry.get("self.remind")?.tool?.name).toBe("remind_me");
  });

  it("a timer she set comes back as a proposal for the main line, and survives a restart", async () => {
    const board = new FakeBoard();
    const r = await rig(new ScriptedProvider(() => "{}"), {
      extra: (sup) => sup.services.provide("agent", ProposalBoardKey, board),
    });
    const set = await r.registry.invoke({
      principal: Principals.self(TEXT),
      capability: "self.remind",
      args: { what: "看一下烤箱", in_minutes: 20 },
      why: null,
      turn: null,
    });
    expect(set.status).toBe("done");
    expect((await r.store.list("p", REMINDER_PREFIX)).size).toBe(1);
    await wait(19 * MIN);
    expect(board.proposals).toEqual([]);
    await wait(2 * MIN);
    expect(board.proposals).toHaveLength(1);
    expect(board.proposals[0]).toMatchObject({
      source: "agenda",
      context: TEXT,
      what: "你自己設的提醒到了:看一下烤箱。要不要說、怎麼說由你決定。",
    });
    expect(r.sup.services.require(ReminderDeskKey).list()).toEqual([]);
  });

  it("logs her own search and offers a post only once daily posts are configured", async () => {
    const board = new FakeBoard();
    const r = await rig(new ScriptedProvider(() => "{}"), {
      config: { daily_posts: { enabled: true, guild: "g1", channel: "posts" } } as JsonValue,
      extra: (sup) => sup.services.provide("agent", ProposalBoardKey, board),
    });
    r.publish(
      customEvent("gate.decision", {
        capability: "web.search",
        args: { query: "鯨魚的歌" },
        allowed: true,
        at: toTimestamp(Date.now()),
        principal: JSON.parse(JSON.stringify(Principals.self(TEXT))) as JsonValue,
      }),
    );
    await wait(10);
    expect(r.sup.services.require(LifeLogKey).summary()).toBe(
      "今天到 20:00 你做過的事:\n- 逛網路:查了「鯨魚的歌」",
    );
    // The rig's day turns at 23:00, so 20:00 on Nov 2 still belongs to her Nov 1.
    expect(board.proposals.map((p) => [p.context?.channel, p.attention?.key])).toEqual([
      ["posts", "daily_post:2026-11-01:1"],
    ]);
    expect(r.sup.services.require(DailyPostsKey).left()).toBe(2);
  });

  it("Plan sees where wanting something new leads, and a game past its share is not started", async () => {
    const plan = JSON.stringify({
      thought: "再玩一下好了。",
      impulses: [
        { kind: "act", capability: "game.start", args: { game: "minecraft" }, why: "想玩" },
      ],
    });
    const provider = new ScriptedProvider((req) => (callKind(req) === "plan" ? plan : "{}"));
    const r = await rig(provider, {
      extra: (sup) => {
        const registry = sup.services.require(ActuatorRegistryKey);
        registry.register(fake("game.start"));
        registry.register(fake("web.search"));
      },
    });
    // She played for nine hours today.
    const since = toTimestamp(Date.now() - 9 * HOUR);
    r.publish(
      customEvent(ACTIVITY_CHANGED_TOPIC, {
        activity: {
          type: "game",
          target: "minecraft",
          phase: "running",
          task: null,
          failure: null,
          since,
        },
      }),
    );
    await wait(10);
    r.publish(
      customEvent(ACTIVITY_CHANGED_TOPIC, {
        activity: { type: "idle", since: toTimestamp(Date.now()) },
      }),
    );
    await wait(10);
    expect(r.sup.services.require(LifeLogKey).today()).toMatchObject([
      { activity: "game", minutes: 540 },
    ]);
    r.publish(salient("Owen 進了語音頻道"));
    await wait(60_000);
    const request = provider.requests("plan")[0];
    expect(request).toBeDefined();
    const [thought] = r.mind().thoughts();
    expect(thought?.intents.map((i) => [i.capability, i.status, i.detail])).toEqual([
      ["game.start", "dropped", "variety: 今天玩遊戲已經 9 小時,超過今天的 35%"],
    ]);
    expect(texts(request).data).not.toContain("找點新鮮事");
  });
});
