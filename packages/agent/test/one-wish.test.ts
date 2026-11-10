// One wish, asked once (docs/design/v4-plan.md §2.4, §7.6): the replay of 2026-11-10, when she
// asked one person, S, the same thing ten times in 100 minutes. A proposal from memory opened a
// turn in which she only promised; the promise came due and she asked S by DM; S answered there;
// then every time S spoke in the channel ("you already asked me in DM", "you asked me several
// times already") she asked again, because the promise, the board and her Plan still held it.
//
// The model here does what her prompt says: while the prompt holds the open wish she asks, and
// once nothing holds it she does not. So what is counted is what the system put in front of her.

import { ArbiterModule } from "@miyoria/arbiter";
import { FactsModule } from "@miyoria/facts";
import type { ChatProvider, ChatRequest, ChatStream, StreamEvent } from "@miyoria/llm";
import {
  type ContextKey,
  EventLogKey,
  type LogEvent,
  PipelineKey,
  ProposalBoardKey,
  toTimestamp,
} from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  channel,
  done,
  Harness,
  incoming,
  mention,
  noCheck,
  Probe,
  stopHarnesses,
  textDelta,
  toolCall,
  wait,
} from "./harness.js";

beforeEach(() => {
  vi.useFakeTimers();
  // 09:00 local (UTC+8).
  vi.setSystemTime(Date.UTC(2026, 10, 10, 1, 0, 0));
});

afterEach(async () => {
  await stopHarnesses();
  vi.useRealTimers();
});

/** What only the wish itself says (her question and S's answers never do). */
const WISH = "期末報告的結果";
const DM: ContextKey = { platform: "test", scope: null, channel: "dm-s", kind: "dm" };
const MIN = 60_000;

/**
 * A model that follows its prompt: the first time it sees the wish it only promises (09:07), after
 * that it asks S by DM whenever the wish is in front of it, and otherwise just chats.
 */
class FollowsPrompt implements ChatProvider {
  readonly name = "follows";
  readonly requests: ChatRequest[] = [];
  promised = false;

  async stream(request: ChatRequest): Promise<ChatStream> {
    this.requests.push(structuredClone(request));
    const last = request.messages.at(-1);
    const prompt = JSON.stringify(request.messages);
    let events: StreamEvent[];
    // What asks her to do it now: the promise is overdue, or it is on the board of what she wants.
    const due = prompt.includes("逾期") || prompt.includes("你最近想做的事");
    if (last?.role === "tool") events = [textDelta("<silence/>"), done()];
    else if (!prompt.includes(WISH) || (this.promised && !due)) {
      events = [textDelta("嗯嗯"), done()];
    } else if (!this.promised) {
      this.promised = true;
      const what = JSON.stringify({ what: `晚點問 S ${WISH}`, due_secs: 600 });
      events = [toolCall(0, "c0", "commit", what), done()];
    } else {
      const ask = JSON.stringify({ to: "S", text: "S~報告還順利嗎?" });
      events = [toolCall(0, "c0", "message_dm", ask), done()];
    }
    return (async function* (): ChatStream {
      for (const e of events) yield e;
    })();
  }
}

async function rig(llm: ChatProvider, dm: Probe): Promise<Harness> {
  return Harness.build("normal", noCheck(), llm, null, {
    tools: [dm],
    provide: (services) => {
      services.provide("app", PipelineKey, { pipeline: "v3" as const });
    },
    before: [[new FactsModule(null, "p"), null]],
    modules: [[new ArbiterModule("p"), { quiet_start_hour: 0, quiet_end_hour: 0 }]],
  });
}

function log(h: Harness): LogEvent[] {
  return h.sup.services.require(EventLogKey).recent(2000);
}

describe("one wish, asked once (2026-11-10)", () => {
  it("the proposal, the due promise, the DM, the answer, then S five times: she asks once", async () => {
    const llm = new FollowsPrompt();
    const dm = new Probe("message_dm");
    const h = await rig(llm, dm);
    const c = channel("c");
    const board = h.sup.services.require(ProposalBoardKey);

    // 09:07: S is around; memory proposes to ask how it went, as promised. She only promises.
    h.say(incoming(c, "S", "早安"));
    await wait(2_000);
    await board.propose({
      what: `問 S ${WISH}(答應過的)`,
      why: "之前答應過要關心",
      source: "memory",
      context: c,
      about: null,
      person: "S",
      goal: null,
      expires: toTimestamp(Date.now() + 60 * MIN),
    });
    await wait(3_000);
    expect(llm.promised).toBe(true);

    // The promise comes due: she asks S by DM.
    // Before: the DM's result turn still had the overdue promise in front of her, and asked
    // again five seconds later (the two DMs of 11:07), and its result turn again.
    await wait(11 * MIN);
    expect(dm.calls).toHaveLength(1);

    // S answers in the DM, twice.
    h.say(incoming(DM, "S", "還不錯,拿了 A"));
    await wait(3 * MIN);
    h.say(incoming(DM, "S", "老師還誇我"));
    await wait(3 * MIN);

    // Her Plan wants to bring it up again when S speaks.
    await board.propose({
      what: `S 說話時接話,順便問${WISH}`,
      why: "想關心",
      source: "plan",
      context: c,
      about: null,
      person: "S",
      goal: null,
      expires: toTimestamp(Date.now() + 60 * MIN),
    });
    await wait(2_000);

    // S speaks in the channel five times.
    for (const text of [
      "大家午安",
      "你已經在私訊問過我了",
      "今天好熱",
      "你問我好幾次了",
      "吃飯囉",
    ]) {
      h.say(mention(c, "S", text));
      await wait(2 * MIN);
    }

    expect(dm.calls).toHaveLength(1);
    const events = log(h);
    // The promise was kept by the DM, not broken half an hour later.
    const commitments = events.filter((e) => e.source === "mainline.commitment");
    expect(commitments.at(-1)?.body).toMatchObject({ commitment: { status: "kept" } });
    expect(commitments.some((e) => JSON.stringify(e.body).includes('"broken"'))).toBe(false);
    // One wish across the stores: the proposal and the promise under one key, answered in the DM.
    const wishes = events.filter((e) => e.kind === "decision" && e.source === "wish");
    const keys = new Set(wishes.map((e) => (e.body as { wish: { key: string } }).wish.key));
    expect(keys.size).toBe(1);
    expect(wishes.at(-1)?.body).toMatchObject({ wish: { state: "closed", end: "answered" } });
    // Her Plan's wish to bring it up again is dropped before it reaches the Floor, with why.
    const plan = events.find(
      (e) => e.kind === "proposal" && JSON.stringify(e.body).includes('"source":"plan"'),
    );
    const id = (plan?.body as { proposal?: { id: string } } | undefined)?.proposal?.id ?? "";
    const ended = events.find(
      (e) => e.kind === "result" && (e.body as { proposal?: string }).proposal === id,
    );
    expect(ended?.body).toMatchObject({ state: "dropped", detail: "對方已經回答了" });
  });
});
