// Applying her `<feel>` blocks after a run (docs/design/v5-heart.md §2.9): names matched to the
// people present like an `@name`, blocked people and her own accounts never moved, the turn's caps,
// her emotion through the engine's appraisal entry.

import type {
  AccountRef,
  AffectInput,
  AffectState,
  FeelProposal,
  HeartPeople,
  MindNote,
  PersonId,
} from "@miyoria/types";
import { describe, expect, it } from "vitest";
import type { Wake } from "../../self/src/index.js";
import {
  answeredLine,
  applyFeel,
  type FeelDeps,
  feelApplies,
  feelCause,
  readFeel,
} from "../src/feel.js";

const CTX = { platform: "discord", scope: "g1", channel: "c1", kind: "channel" } as const;
const acct = (id: string): AccountRef => ({ platform: "discord", id });

const PEOPLE = [
  { account: acct("1"), name: "Owen Liu" },
  { account: acct("2"), name: "小明:D" },
  { account: acct("3"), name: "阿哲" },
  { account: acct("4"), name: "壞人" },
  { account: acct("self"), name: "她自己" },
  { account: acct("5"), name: "Owen Chen" },
];

const WAKE: Wake = {
  kind: "addressed",
  reason: "mention",
  from: { account: acct("1"), name: "Owen Liu" },
  message: { context: CTX, id: "m1" },
};

interface Recorded {
  appraised: AffectInput[];
  felt: { person: PersonId; proposals: readonly FeelProposal[]; turn: string | null }[];
  noted: MindNote[];
}

function deps(): { deps: FeelDeps; rec: Recorded } {
  const rec: Recorded = { appraised: [], felt: [], noted: [] };
  const heart = {
    feel(person: PersonId, proposals: readonly FeelProposal[], o: { turn: string | null }) {
      rec.felt.push({ person, proposals, turn: o.turn });
      return proposals.length;
    },
  } as unknown as HeartPeople;
  const affect = {
    appraise(input: AffectInput) {
      rec.appraised.push(input);
      return [];
    },
  } as unknown as AffectState;
  return {
    rec,
    deps: {
      personOf: (a) => (a.id === "9" ? null : `p${a.id}`),
      excluded: (a) => a.id === "4" || a.id === "self",
      handleOf: (a, name) => (a.id === "2" ? "ming" : name),
      callName: (a) => (a.id === "3" ? "哲哥" : null),
      heart: () => heart,
      affect: () => affect,
      journal: () => ({ note: (n: MindNote) => rec.noted.push(n) }),
      log: { debug: () => undefined },
      now: () => Date.UTC(2026, 10, 17, 4),
    },
  };
}

describe("matching the names of a feel block", () => {
  it("matches like an @name: case, a handle, a cleaned name, a first word only one has", () => {
    const { deps: d } = deps();
    const read = readFeel(
      d,
      [
        ["owen liu: 羈絆 + 「他記得」", "MING: 信任 + 「有守約」", "@阿哲: 好感 - 「他嗆我」"].join(
          "\n",
        ),
      ],
      PEOPLE,
    );
    expect(read.proposals.map((p) => [p.person, p.field, p.direction])).toEqual([
      ["p1", "bond", "up"],
      ["p2", "trust", "up"],
    ]);
    // Three people named: the third is over the turn's two.
    expect(read.over).toBe(1);
  });

  it("knows someone by what she calls them", () => {
    const { deps: d } = deps();
    const read = readFeel(d, ["哲哥: 默契 + 「接得好」"], PEOPLE);
    expect(read.proposals.map((p) => [p.person, p.name])).toEqual([["p3", "阿哲"]]);
    expect(read.unmatched).toBe(0);
  });

  it("drops a name that is nobody here or two people, a blocked person and her own account", () => {
    const { deps: d } = deps();
    const read = readFeel(
      d,
      [
        [
          "Owen: 羈絆 + 「?」",
          "路人: 羈絆 + 「?」",
          "壞人: 心結 + 「他罵我」",
          "她自己: 好感 + 「?」",
          "阿哲: 默契 + 「接得好」",
        ].join("\n"),
      ],
      PEOPLE,
    );
    expect(read.proposals.map((p) => p.person)).toEqual(["p3"]);
    expect(read.unmatched).toBe(4);
  });

  it("counts lines that do not read, keeps three lines at most and the last emotion", () => {
    const { deps: d } = deps();
    const read = readFeel(
      d,
      [
        "我: 開心 中\nOwen Liu: 羈絆 + 「a」\nOwen Liu: 好感 + 「b」",
        "我: 難過 弱\nOwen Liu: 信任 + 「c」\nOwen Liu: 自在 + 「d」\nOwen Liu: 喜歡 + 「e」",
      ],
      PEOPLE,
    );
    // The last step's emotion is what she feels at the end of the run.
    expect(read.self?.emotion).toBe("sorrow");
    expect(read.proposals.map((p) => p.field)).toEqual(["bond", "warmth", "trust"]);
    expect(read.over).toBe(1);
    // The unknown value.
    expect(read.unreadable).toBe(1);
  });
});

describe("applying a feel block", () => {
  it("sends her emotion to the engine and her proposals to the heart, with the turn", () => {
    const { deps: d, rec } = deps();
    const out = applyFeel(d, {
      turn: "t1",
      context: CTX,
      wake: WAKE,
      feel: ["我: 開心 強\nOwen Liu: 羈絆 + 「他記得我想吃布丁」\n阿哲: 好感 + 「他也有買」"],
      people: PEOPLE,
      line: { account: acct("1"), name: "Owen Liu", text: "我帶了布丁" },
    });
    expect(out).toMatchObject({ felt: true, applied: 2 });
    expect(rec.appraised).toEqual([
      {
        source: "feel",
        events: [
          { emotion: "joy", strength: "strong", toward: "Owen Liu", cause: "Owen Liu: 我帶了布丁" },
        ],
        context: CTX,
        at: "2026-11-17T04:00:00.000Z",
      },
    ]);
    expect(rec.felt).toEqual([
      {
        person: "p1",
        proposals: [{ field: "bond", direction: "up", quote: "他記得我想吃布丁" }],
        turn: "t1",
      },
      {
        person: "p3",
        proposals: [{ field: "warmth", direction: "up", quote: "他也有買" }],
        turn: "t1",
      },
    ]);
    // One line of her journal: what she felt and what she proposed, by the names she used.
    expect(rec.noted).toEqual([
      {
        kind: "feel",
        text: "開心 強",
        changes: ["Owen Liu 羈絆 +「他記得我想吃布丁」", "阿哲 好感 +「他也有買」"],
        context: CTX,
      },
    ]);
  });

  it("moves nothing for calm and no proposal, and nothing without the services", () => {
    const { deps: d, rec } = deps();
    const calm = applyFeel(d, {
      turn: "t2",
      context: CTX,
      wake: WAKE,
      feel: ["我: 平靜 弱"],
      people: PEOPLE,
      line: null,
    });
    expect(calm).toMatchObject({ felt: false, applied: 0 });
    expect(rec.appraised).toEqual([]);
    // Calm is still something she felt: noted, with nothing changed.
    expect(rec.noted).toEqual([{ kind: "feel", text: "平靜 弱", changes: [], context: CTX }]);
    const off = applyFeel(
      { ...d, heart: () => null, affect: () => null },
      {
        turn: "t3",
        context: CTX,
        wake: WAKE,
        feel: ["我: 開心 中\nOwen Liu: 羈絆 + 「a」"],
        people: PEOPLE,
        line: null,
      },
    );
    expect(off).toMatchObject({ felt: false, applied: 0 });
  });

  it("takes the line as the cause only from the one she feels toward, never in a DM", () => {
    const { deps: d, rec } = deps();
    const feel = ["我: 開心 中"];
    const said = { account: acct("1"), name: "Owen Liu", text: "我住在台南" };
    // Someone else's line in the place is not the cause of what she feels toward Owen.
    applyFeel(d, {
      turn: "t1",
      context: CTX,
      wake: WAKE,
      feel,
      people: PEOPLE,
      line: { account: acct("3"), name: "阿哲", text: "我家在高雄" },
    });
    // A DM: no line at all, whoever said it.
    const dm = { platform: "discord", scope: null, channel: "d1", kind: "dm" } as const;
    applyFeel(d, { turn: "t2", context: dm, wake: WAKE, feel, people: PEOPLE, line: said });
    applyFeel(d, { turn: "t3", context: CTX, wake: WAKE, feel, people: PEOPLE, line: said });
    expect(rec.appraised.map((a) => a.events[0]?.cause)).toEqual([
      "剛剛的對話",
      "私訊裡的事",
      "Owen Liu: 我住在台南",
    ]);
  });

  it("takes the cause from the line answered, else from what woke her", () => {
    expect(feelCause({ kind: "world", what: "遊戲贏了" }, null, null)).toBe("遊戲贏了");
    expect(feelCause({ kind: "glance", lines: 2 }, null, "他說謝謝")).toBe("他說謝謝");
    expect(feelCause({ kind: "self", note: null }, null, null)).toBe("剛剛的對話");
    expect(answeredLine({ kind: "timer", note: "x" }, [], [])).toBeNull();
  });
});

describe("which runs' feel is applied", () => {
  it("not a run cut to be restarted for the same lines; every other run that ended", () => {
    expect(feelApplies({ cancel: { cause: "input" } })).toBe(false);
    expect(feelApplies({ cancel: null })).toBe(true);
    expect(feelApplies({ cancel: { cause: "superseded" } })).toBe(true);
    expect(feelApplies({ cancel: { cause: "shutdown" } })).toBe(true);
  });
});
