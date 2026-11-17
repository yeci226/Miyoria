import type { ChatRequest, ChatResponse, Completer } from "@miyoria/llm/llm";
import { SqliteStore } from "@miyoria/store";
import { openTestDb, type TestDb } from "@miyoria/store/testing";
import type { AccountRef, ContextKey, PersonId } from "@miyoria/types";
import { toTimestamp } from "@miyoria/types";
import type { TranscriptEntry } from "../../transcript/src/types.js";
import type { NotePlace, NotesLimits, ScopeResolver } from "../src/index.js";
import { NotesStore, notesSchema, notesTables } from "../src/index.js";

export const T0 = Date.UTC(2026, 10, 1, 12);
export const MINUTE = 60_000;
export const OWEN = "01HOWEN0000000000000000000" as PersonId;
export const AMY = "01HAMY00000000000000000000" as PersonId;
export const BEN = "01HBEN00000000000000000000" as PersonId;
export const SPACE = "01HSPACE000000000000000000";
export const OTHER_SPACE = "01HSPACE2SPACE2SPACE2SPACE";
export const ROOM = "01HROOM0000000000000000000";
export const DM_ROOM = "01HDMROOM00000000000000000";
export const SESSION = "space:01HSPACE:room:01HROOM";

export const IN_SERVER: NotePlace = { space: SPACE, room: ROOM, dm: null };
export const IN_DM: NotePlace = { space: null, room: DM_ROOM, dm: OWEN };

/** A clock the test moves. */
export function testClock(start = T0) {
  let now = start;
  return {
    now: () => now,
    tick: (ms: number) => {
      now += ms;
    },
  };
}

export interface Rig {
  store: TestDb;
  notes: NotesStore;
  clock: ReturnType<typeof testClock>;
}

/** A migrated in-memory database with the notes tables (close it with `store.close()`). */
export async function rig(clock = testClock(), limits: Partial<NotesLimits> = {}): Promise<Rig> {
  const store = openTestDb({ plugins: [notesSchema], clock });
  return { store, notes: new NotesStore(store.db, limits), clock };
}

/** The notes opened through a real store, as Core opens them (`STORE_PLUGINS`). */
export async function opened(clock = testClock()) {
  const store = await SqliteStore.open(":memory:", { plugins: [notesTables], clock });
  return { store, notes: store.plugin(notesTables) };
}

/** A transcript entry with defaults (`other`, said at `T0 + seq` minutes). */
export function entry(seq: number, fields: Partial<TranscriptEntry> = {}): TranscriptEntry {
  return {
    session: SESSION,
    seq,
    kind: "other",
    person_id: null,
    account: null,
    author: null,
    content: "",
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
    at: toTimestamp(T0 + seq * MINUTE),
    redacted_at: null,
    ...fields,
  };
}

/** Someone's line. */
export const by = (seq: number, person: PersonId, author: string, content: string) =>
  entry(seq, { kind: "other", person_id: person, author, content });

/** Her line. */
export const own = (seq: number, content: string) =>
  entry(seq, { kind: "self", content, message_id: `m${seq}` });

/** A model that answers with the given texts in turn, recording what it was asked. */
export function scripted(...replies: string[]) {
  const asked: ChatRequest[] = [];
  const router: Completer = {
    async complete(_purpose: string, request: ChatRequest): Promise<ChatResponse> {
      asked.push(request);
      const text = replies.shift();
      if (text === undefined) throw new Error("the scripted model has no more replies");
      return {
        text,
        reasoning: "",
        tool_calls: [],
        finish_reason: "stop",
        usage: { prompt_tokens: 100, completion_tokens: 40, cached_prompt_tokens: null },
      };
    },
  };
  return { router, asked };
}

/** The context of a channel, for the resolver. */
export const CHANNEL: ContextKey = {
  platform: "discord",
  scope: "g1",
  channel: "c1",
  kind: "channel",
};
export const DM_CHANNEL: ContextKey = {
  platform: "discord",
  scope: null,
  channel: "d1",
  kind: "dm",
};
export const OWEN_ACCOUNT: AccountRef = { platform: "discord", id: "u-owen" };

/** A resolver that knows one server, its channel, one DM and Owen's account. */
export function fakeResolver(): ScopeResolver {
  return {
    spaceOf: (platform, guild) => (platform === "discord" && guild === "g1" ? SPACE : null),
    guildOf: (space) => (space === SPACE ? { platform: "discord", guild: "g1" } : null),
    roomOf: (ctx) => (ctx.channel === "c1" ? ROOM : ctx.channel === "d1" ? DM_ROOM : null),
    contextOf: (room) => (room === ROOM ? CHANNEL : room === DM_ROOM ? DM_CHANNEL : null),
    personOf: (account) => (account.id === "u-owen" ? OWEN : null),
    accountOf: (person) => (person === OWEN ? OWEN_ACCOUNT : null),
  };
}
