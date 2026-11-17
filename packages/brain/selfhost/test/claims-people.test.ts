// Whom an `@name` of hers may tag (docs/design/v5-heart.md §2.7, §2.9): who spoke in the place and
// whoever she answers, and now the members of the voice channel there and the people this run's
// prompt names. Blocked people and her own accounts never.

import type { TranscriptEntry } from "@miyoria/memory/transcript";
import { type AccountRef, toTimestamp } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import type { Agent } from "../../agent/src/index.js";
import type { OutgoingLine, Wake } from "../../self/src/index.js";
import { outletClaims } from "../src/repeat.js";

const CTX = { platform: "test", scope: "g", channel: "c", kind: "channel" } as const;
const acct = (id: string): AccountRef => ({ platform: "test", id });

function entry(id: string, name: string): TranscriptEntry {
  return {
    session: "s",
    seq: 1,
    kind: "other",
    person_id: null,
    account: acct(id),
    author: name,
    content: "hi",
    images: [],
    tool_calls: [],
    tool_call_id: null,
    reasoning: null,
    turn: null,
    message_id: null,
    reply_to: null,
    label: null,
    about_seq: null,
    addressed: false,
    bot: false,
    spoken: false,
    flagged: null,
    interrupted: false,
    heard: null,
    tokens: 0,
    at: toTimestamp(0),
    redacted_at: null,
  };
}

const agent = {
  isBlocked: (a: AccountRef) => a.id === "bad",
  isSelf: (a: AccountRef) => a.id === "her",
} as unknown as Agent;

const WAKE: Wake = {
  kind: "addressed",
  reason: "mention",
  from: { account: acct("amy"), name: "amy" },
  message: { context: CTX, id: "m1" },
};

const line = (focus: boolean): OutgoingLine => ({
  place: CTX,
  text: "@kai 你來啦",
  emotion: null,
  turn: "t1",
  focus,
  replyTo: null,
});

describe("the people an @name may tag", () => {
  it("are the speakers, whom she answers, the voice channel's members and the prompt's people", () => {
    const claims = outletClaims(agent, {
      wakeOf: () => WAKE,
      entries: () => [entry("owen", "owen"), entry("bad", "bad")],
      members: () => [
        { account: acct("kai"), name: "kai" },
        { account: acct("her"), name: "her" },
      ],
      named: () => [{ account: acct("zoe"), name: "zoe" }],
    });
    expect(claims.people(line(true)).map((p) => p.name)).toEqual(["owen", "amy", "kai", "zoe"]);
    // A line said elsewhere (`say`) does not take this run's prompt's people.
    expect(claims.people(line(false)).map((p) => p.name)).toEqual(["owen", "amy", "kai"]);
  });
});
