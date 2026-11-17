// Her promises from conversation: the memory's segment pass records them in the main line's
// commitment book (the `PromiseBook` this module provides), where an overdue one wakes her, and
// keeps them there once a later segment shows she did it.

import type { ChatRequest, ChatResponse, Completer } from "@miyoria/llm/llm";
import { commitmentLedger, NotesStore, notesSchema, runSegmentPass } from "@miyoria/memory/notes";
import { openTestDb } from "@miyoria/store/testing";
import {
  type ContextKey,
  type LogEvent,
  type Observation,
  type PersonId,
  type PromiseBook,
  toTimestamp,
} from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { COMMITMENT_SOURCE, CommitmentBook } from "../src/mainline/commitments.js";

const T0 = Date.UTC(2026, 10, 1, 12);
const MIN = 60_000;
const CHANNEL: ContextKey = { platform: "discord", scope: "g1", channel: "c1", kind: "channel" };
const OWEN = "01HOWEN0000000000000000000" as PersonId;
const SESSION = "space:s1:room:r1";

const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

function scripted(...replies: object[]): Completer {
  return {
    async complete(_purpose: string, _request: ChatRequest): Promise<ChatResponse> {
      const next = replies.shift();
      if (next === undefined) throw new Error("the scripted model has no more replies");
      return {
        text: JSON.stringify(next),
        reasoning: "",
        tool_calls: [],
        finish_reason: "stop",
        usage: { prompt_tokens: 10, completion_tokens: 10, cached_prompt_tokens: null },
      };
    },
  };
}

const line = (seq: number, kind: "self" | "other", content: string) => ({
  session: SESSION,
  seq,
  kind,
  person_id: kind === "other" ? OWEN : null,
  account: null,
  author: kind === "other" ? "Owen" : null,
  content,
  images: [],
  tool_calls: [],
  tool_call_id: null,
  reasoning: null,
  turn: null,
  message_id: `m${seq}`,
  reply_to: null,
  label: null,
  about_seq: null,
  addressed: false,
  bot: false,
  spoken: false,
  flagged: null,
  interrupted: false,
  heard: null,
  tokens: 10,
  at: toTimestamp(T0 + seq * MIN),
  redacted_at: null,
});

function rig() {
  let now = T0 + 10 * MIN;
  const events: LogEvent[] = [];
  const observed: Observation[] = [];
  let book: CommitmentBook | null = null;
  const log = {
    append(event: Omit<LogEvent, "id">) {
      const logged = { ...event, id: `e${events.length + 1}` } as unknown as LogEvent;
      events.push(logged);
      book?.apply(logged);
      return logged;
    },
    observe(observation: Observation) {
      observed.push(observation);
      return {} as LogEvent;
    },
  };
  book = new CommitmentBook(
    () => log as never,
    () => now,
    120,
  );
  const promises: PromiseBook = book;
  const t = openTestDb({ plugins: [notesSchema] });
  closers.push(() => t.close());
  const notes = new NotesStore(t.db);
  const pass = (entries: ReturnType<typeof line>[], router: Completer) =>
    runSegmentPass(
      {
        session: SESSION,
        entries,
        place: { space: "s1", room: "r1", dm: null },
        people: [{ person: OWEN, name: "Owen" }],
        context: CHANNEL,
      },
      {
        router,
        notes,
        now: () => now,
        promises: commitmentLedger(() => promises, { now: () => now }),
      },
    );
  return {
    book,
    events,
    observed,
    pass,
    at: (ms: number) => {
      now = ms;
    },
  };
}

describe("her promises from conversation", () => {
  it("are recorded in the commitment book and wake her once overdue", async () => {
    const r = rig();
    const result = await r.pass(
      [line(1, "other", "那家店幾點開啊"), line(2, "self", "我等等幫你查!")],
      scripted({
        promises: [{ to: "p1", what: "幫 Owen 查那家店幾點開", due_in_hours: 0.5, seq: 2 }],
      }),
    );
    expect(result.promises[0]?.stored).not.toBeNull();
    expect(r.book.open(CHANNEL).map((c) => c.what)).toEqual(["幫 Owen 查那家店幾點開"]);
    expect(r.book.overdue()).toEqual([]);

    // Half an hour after she said it (minute 2): overdue, what her `commitment` opportunity reads.
    r.at(T0 + 33 * MIN);
    expect(r.book.overdue().map((c) => c.what)).toEqual(["幫 Owen 查那家店幾點開"]);
    r.book.remind();
    expect(r.observed).toEqual([
      expect.objectContaining({
        source: COMMITMENT_SOURCE,
        summary: "你剛說要「幫 Owen 查那家店幾點開」,還沒做",
      }),
    ]);
  });

  it("are kept once a later segment shows she did it", async () => {
    const r = rig();
    await r.pass(
      [line(1, "other", "那家店幾點開啊"), line(2, "self", "我等等幫你查!")],
      scripted({ promises: [{ to: "p1", what: "幫 Owen 查那家店幾點開", due_in_hours: 1 }] }),
    );
    r.at(T0 + 20 * MIN);
    const result = await r.pass(
      [line(3, "self", "查到了,那家店早上十一點開"), line(4, "other", "謝啦")],
      scripted({ close: [{ id: "c1", reason: "查到了" }] }),
    );
    expect(result.closed).toEqual([expect.objectContaining({ kind: "promise", count: 1 })]);
    expect(r.book.open()).toEqual([]);
    r.at(T0 + 3 * 60 * MIN);
    expect(r.book.overdue()).toEqual([]);
    const statuses = r.events.map(
      (e) => (e.body as { commitment: { status: string } }).commitment.status,
    );
    expect(statuses).toEqual(["open", "kept"]);
  });
});
