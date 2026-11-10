// Her daily posts (v4 §8.4, row 8 of §16): off by default, one channel, a daily cap, and even then
// only a proposal for the main line; rules, levels, quiet hours and the budget come first.

import { ServiceRegistry } from "@miyoria/kernel";
import { MemorySettingsStore } from "@miyoria/store";
import {
  ArbiterKey,
  CHAT_START,
  type ContextKey,
  IntentSinkKey,
  type LifeEntry,
  type NewProposal,
  type ProposalBoard,
  ProposalBoardKey,
  type ProposalOutcome,
  toTimestamp,
} from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { DailyPostDesk, DailyPostsConfigSchema, mindConfig, POSTS_PREFIX } from "../src/index.js";
import { FakeArbiter, limits } from "./fakes.js";
import { FakeIntents } from "./helpers.js";

const T0 = Date.parse("2026-11-10T07:00:00.000Z"); // 15:00 at UTC+8
const MIN = 60_000;
const CHANNEL: ContextKey = { platform: "discord", scope: "g1", channel: "posts", kind: "channel" };

class FakeBoard implements ProposalBoard {
  readonly proposals: NewProposal[] = [];
  state: ProposalOutcome["state"] = "open";
  async propose(p: NewProposal): Promise<ProposalOutcome> {
    this.proposals.push(structuredClone(p));
    return { id: `P${this.proposals.length}`, state: this.state, detail: "規則不允許", turn: null };
  }
  open() {
    return [];
  }
}

const entry = (p: Partial<LifeEntry> = {}): LifeEntry => ({
  id: "e1",
  activity: "browse",
  what: "查了「Minecraft 1.22 新生物」",
  at: toTimestamp(T0),
  minutes: null,
  capability: "web.search",
  ...p,
});

function setup(config: object = { enabled: true, guild: "g1", channel: "posts" }) {
  let now = T0;
  const services = new ServiceRegistry();
  const board = new FakeBoard();
  services.provide("agent", ProposalBoardKey, board);
  const store = new MemorySettingsStore();
  const make = () =>
    new DailyPostDesk({
      config: DailyPostsConfigSchema.parse(config),
      store,
      profile: "p",
      clock: { now: () => now },
      services,
      dayOf: (at) => new Date(at + 8 * 60 * MIN - 6 * 60 * MIN).toISOString().slice(0, 10),
    });
  return {
    services,
    board,
    store,
    desk: make(),
    make,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("daily posts", () => {
  it("are off by default: nothing is offered, nothing posted anywhere", async () => {
    expect(mindConfig().daily_posts).toEqual({
      enabled: false,
      platform: "discord",
      guild: null,
      channel: null,
      max_per_day: 3,
      min_gap_mins: 120,
    });
    const s = setup({});
    expect(s.desk.channel()).toBeNull();
    expect(s.desk.left()).toBe(0);
    expect(await s.desk.offer(entry())).toBe("daily posts are off");
    // Enabled without a channel is still off.
    const half = setup({ enabled: true, guild: "g1" });
    expect(await half.desk.offer(entry())).toBe("daily posts are off");
    expect([...s.board.proposals, ...half.board.proposals]).toEqual([]);
  });

  it("when on, offers the main line one post in that channel about what she really did", async () => {
    const s = setup();
    expect(s.desk.channel()).toEqual(CHANNEL);
    expect(await s.desk.offer(entry())).toBe("offered");
    expect(s.board.proposals[0]).toMatchObject({
      capability: CHAT_START,
      context: CHANNEL,
      source: "plan",
      attention: { key: "daily_post:2026-11-10:1" },
    });
    expect(s.board.proposals[0]?.what).toBe(
      "你剛逛網路:查了「Minecraft 1.22 新生物」。想的話可以在你的日常頻道貼一則(今天第 1 則,最多 3 則),只寫你真的做了的事;不想貼就不用。",
    );
    expect(s.desk.left()).toBe(2);
  });

  it("at most max_per_day a day, spaced out; the next day starts over", async () => {
    const s = setup();
    expect(await s.desk.offer(entry())).toBe("offered");
    expect(await s.desk.offer(entry())).toBe("posted lately");
    for (let i = 0; i < 2; i++) {
      s.advance(121 * MIN);
      expect(await s.desk.offer(entry())).toBe("offered");
    }
    s.advance(121 * MIN);
    expect(await s.desk.offer(entry())).toBe("today's posts are used up");
    expect(s.board.proposals).toHaveLength(3);
    // A restart keeps today's count.
    await Promise.resolve();
    const again = s.make();
    await again.load();
    expect(again.left()).toBe(0);
    expect(await s.store.get("p", `${POSTS_PREFIX}2026-11-10`)).toMatchObject({ used: 3 });
    s.advance(20 * 60 * MIN);
    expect(s.desk.left()).toBe(3);
  });

  it("an offer a rule drops is given back", async () => {
    const s = setup();
    s.board.state = "dropped";
    expect(await s.desk.offer(entry())).toBe("規則不允許");
    expect(s.desk.left()).toBe(3);
  });

  it("not about talking to people, not in quiet hours, not paused, not in a silent channel", async () => {
    const s = setup();
    expect(await s.desk.offer(entry({ activity: "care" }))).toBe("nothing to post about");
    const arbiter = new FakeArbiter();
    s.services.provide("arbiter", ArbiterKey, arbiter);
    arbiter.view = {
      limits: limits({ quiet_hours: { start_hour: 1, end_hour: 7, active: true } }),
    };
    expect(await s.desk.offer(entry())).toBe("quiet hours");
    arbiter.view = { limits: limits({ paused: true }) };
    expect(await s.desk.offer(entry())).toBe("autonomy is paused");
    arbiter.view = {};
    const intents = new FakeIntents();
    intents.levels = () => ({ mode: "mention-only", label: "只回提及", blocked: null });
    s.services.provide("agent", IntentSinkKey, intents);
    expect(await s.desk.offer(entry())).toBe("channel level mention-only");
    expect(s.board.proposals).toEqual([]);
  });
});
