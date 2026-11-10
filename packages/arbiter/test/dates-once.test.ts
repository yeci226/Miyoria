// A birthday is said once (PR 8's dates in `@miyoria/memory`, v4's one wish per topic).
//
// On the day, the memory's DateGreeter writes a followup that is due at once. It goes the way of
// every memory followup: the Arbiter makes it a proposal, the board holds it as a wish of hers
// about that person, and the main line marks the wish asked once a turn opened for it said
// something. A second store raising the same thing that day (a followup consolidation wrote from
// "my birthday is today") is then the same wish, already asked: it is not raised again.

import { EventLogService } from "@miyoria/facts";
import { Supervisor } from "@miyoria/kernel";
import {
  type AccountRef,
  type Attitude,
  type ContextKey,
  type Event,
  EventLogKey,
  type Followup,
  type FollowupSource,
  FollowupSourceKey,
  type HandleDirectory,
  HandleDirectoryKey,
  ImpulseHostKey,
  type NewProposal,
  PipelineKey,
  ProposalBoardKey,
  type SocialSignals,
  SocialSignalsKey,
  toTimestamp,
  WishesKey,
  wishHolder,
} from "@miyoria/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArbiterModule } from "../src/index.js";
import { acct, FakeHost, MIN, T0, textCtx } from "./helpers.js";

afterEach(() => {
  vi.useRealTimers();
});

const C: ContextKey = textCtx("c1");
const PERSON = "person-a";
const HANDLE = "阿明";

/** What the DateGreeter writes for a birthday (packages/memory/src/dates.ts `occasionsOf`). */
const BIRTHDAY = `今天(11/3)是${HANDLE}的生日,找機會跟${HANDLE}說聲生日快樂`;

class Followups implements FollowupSource {
  due_: Followup[] = [];
  done: string[] = [];
  async due(): Promise<Followup[]> {
    return this.due_.filter((f) => !this.done.includes(f.id));
  }
  async markDone(id: string): Promise<void> {
    this.done.push(id);
  }
}

const social: SocialSignals = {
  attitude: (a: AccountRef): Attitude | null =>
    a.id === "a"
      ? {
          person: PERSON,
          affinity: 60,
          trust: 50,
          familiarity: 50,
          blocked: false,
          label: "朋友",
          call_name: null,
        }
      : null,
};

const handles = {
  ofPerson: (p: string) => (p === PERSON ? HANDLE : null),
  resolve: (h: string) => (h === HANDLE ? { handle: HANDLE, person: PERSON } : null),
} as unknown as HandleDirectory;

function said(at: number): Event {
  return {
    type: "platform_message_created",
    data: {
      id: { context: C, id: `a-${at}` },
      author: { account: acct("a"), display_name: HANDLE, is_bot: false },
      text: "早安",
      mentions_self: false,
      reply_to_self: false,
      attachments: [],
      ts: toTimestamp(at),
    },
  };
}

function followup(id: string, about: string): Followup {
  return { id, profile: "p", person: PERSON, context: C, about, due: toTimestamp(T0) };
}

describe("a birthday followup is one wish, said once", () => {
  it("the day's followup and consolidation's own are one wish: once she said it, not again", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const sup = new Supervisor();
    const log = new EventLogService({ profile: "p", store: null });
    const followups = new Followups();
    /** What reached the board, and what it did with it (as the main line's board does). */
    const board: { proposal: NewProposal; raised: boolean }[] = [];
    sup.services.provide("app", PipelineKey, { pipeline: "v3" as const });
    sup.services.provide("app", EventLogKey, log);
    sup.services.provide("app", SocialSignalsKey, social);
    sup.services.provide("app", HandleDirectoryKey, handles);
    sup.services.provide("app", FollowupSourceKey, followups);
    sup.services.provide("app", ImpulseHostKey, new FakeHost());
    let n = 0;
    sup.services.provide("app", ProposalBoardKey, {
      // packages/agent/src/mainline/proposals.ts: hold the wish, then ask whether to raise it.
      propose: async (proposal) => {
        const id = `p${++n}`;
        const wishes = sup.services.require(WishesKey);
        let raised = true;
        if (proposal.person !== null) {
          const holder = wishHolder("proposal", id);
          wishes.hold(proposal.person, proposal.what, holder);
          raised = (await wishes.screen({ person: proposal.person, text: proposal.what, holder }))
            .raise;
        }
        board.push({ proposal, raised });
        return { id, state: raised ? "open" : "dropped", detail: "", turn: null };
      },
      open: () => [],
    });
    await sup.register(new ArbiterModule("p"), { tick_secs: 1 }, true);
    await sup.startAll();
    const wishes = sup.services.require(WishesKey);

    // He speaks first on his birthday: the greeter's followup is due at once.
    followups.due_.push(followup("f-birthday", BIRTHDAY));
    sup.bus.publish("t", said(T0));
    await vi.advanceTimersByTimeAsync(1500);
    expect(board.map((b) => [b.proposal.source, b.proposal.person, b.raised])).toEqual([
      ["memory", HANDLE, true],
    ]);
    expect(followups.done).toEqual(["f-birthday"]);

    // A turn opened for it said 「生日快樂」 (the main line's `conclude`): she asked.
    const wish = wishes.of(wishHolder("proposal", "p1"));
    expect(wish).not.toBeNull();
    wishes.asked(wish?.key ?? "");

    // Later that day consolidation's followup about the same thing comes due: the same wish,
    // already said, so it is not raised again.
    vi.setSystemTime(T0 + 30 * MIN);
    followups.due_.push(followup("f-consolidated", `祝${HANDLE}生日快樂`));
    sup.bus.publish("t", said(T0 + 30 * MIN));
    await vi.advanceTimersByTimeAsync(1500);
    expect(board.map((b) => b.raised)).toEqual([true, false]);
    expect(wishes.of(wishHolder("proposal", "p2"))?.key).toBe(wish?.key);
    // Nothing comes back on later ticks: both followups are done.
    await vi.advanceTimersByTimeAsync(5000);
    expect(board).toHaveLength(2);
    expect(followups.done).toEqual(["f-birthday", "f-consolidated"]);
    await sup.stopAll();
  });
});
