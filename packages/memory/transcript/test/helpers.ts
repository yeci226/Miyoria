import { SqliteStore } from "@miyoria/store";
import type { ContextKey, PersonId } from "@miyoria/types";
import { toTimestamp } from "@miyoria/types";
import {
  type EntryInput,
  type TranscriptEntry,
  type TranscriptStore,
  transcriptTables,
} from "../src/index.js";

export const T0 = Date.UTC(2026, 10, 1, 12);
export const MINUTE = 60_000;
export const DAY = 24 * 60 * MINUTE;
export const ROOM = "discord:g1:c1";
export const CTX: ContextKey = { platform: "discord", scope: "g1", channel: "c1", kind: "channel" };
export const OWEN = "01HOWEN0000000000000000000" as PersonId;
export const AMY = "01HAMY00000000000000000000" as PersonId;

/** A clock the test moves. */
export function testClock(start = T0) {
  let now = start;
  return {
    now: () => now,
    set: (ms: number) => {
      now = ms;
    },
    tick: (ms: number) => {
      now += ms;
    },
  };
}

export interface Rig {
  store: SqliteStore;
  t: TranscriptStore;
  clock: ReturnType<typeof testClock>;
}

export async function rig(path = ":memory:", clock = testClock()): Promise<Rig> {
  const store = await SqliteStore.open(path, { plugins: [transcriptTables], clock });
  return { store, t: store.plugin(transcriptTables), clock };
}

/** Someone's line. */
export function said(author: string, content: string, extra: Partial<EntryInput> = {}): EntryInput {
  return { kind: "other", author, content, ...extra };
}

/** A line of hers. */
export function own(content: string, extra: Partial<EntryInput> = {}): EntryInput {
  return { kind: "self", content, ...extra };
}

/** A call of hers and its result, as two entries. */
export function called(
  id: string,
  name: string,
  args: string,
  result: string,
  extra: Partial<EntryInput> = {},
): [EntryInput, EntryInput] {
  return [
    { kind: "tool_calls", tool_calls: [{ id, name, arguments: args }], ...extra },
    { kind: "tool_result", tool_call_id: id, content: result, ...extra },
  ];
}

/** An entry as `tail` would return it, for the pure functions. */
export function entry(seq: number, input: EntryInput): TranscriptEntry {
  return {
    session: ROOM,
    seq,
    kind: input.kind,
    person_id: input.person_id ?? null,
    account: input.account ?? null,
    author: input.author ?? null,
    content: input.content ?? "",
    images: input.images ?? [],
    tool_calls: input.tool_calls ?? [],
    tool_call_id: input.tool_call_id ?? null,
    reasoning: input.reasoning ?? null,
    turn: input.turn ?? null,
    message_id: input.message_id ?? null,
    reply_to: input.reply_to ?? null,
    label: input.label ?? null,
    about_seq: input.about_seq ?? null,
    addressed: input.addressed ?? false,
    bot: input.bot ?? false,
    spoken: input.spoken ?? false,
    flagged: input.flagged ?? null,
    interrupted: input.interrupted ?? false,
    heard: input.heard ?? null,
    tokens: input.tokens ?? 10,
    at: input.at ?? toTimestamp(T0 + seq * 1000),
    redacted_at: null,
  };
}

/** `inputs` as entries 1, 2, 3, ... */
export function entries(inputs: readonly EntryInput[]): TranscriptEntry[] {
  return inputs.map((input, i) => entry(i + 1, input));
}
