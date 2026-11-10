// The feed's privacy rule (privacy.ts) on the real overlay machinery: what reaches a page, and
// what never does.

import {
  type ActivitySnapshot,
  AFFECT_CHANGED_TOPIC,
  type ContextKey,
  customEvent,
  type Event,
  type JsonObject,
  type LiveEvent,
  SONG_TOPIC,
} from "@miyoria/types";
import { describe, expect, it } from "vitest";
import {
  isPublicPlace,
  LiveState,
  MAX_LINE_CHARS,
  mayShow,
  placeOf,
  type Screen,
} from "../src/index.js";

const GUILD = "900";
const OPEN = "100"; // listed
const CLOSED = "200"; // not listed

const text = (channel: string, kind: ContextKey["kind"] = "channel"): ContextKey => ({
  platform: "discord",
  scope: kind === "dm" ? null : GUILD,
  channel,
  kind,
});
const voice = (channel: string): ContextKey => text(channel, "voice");
/** A place inside a bus payload. */
const ctx = (c: ContextKey): JsonObject => ({ ...c });

/** Moderation passes everything but "BAD"; the names everyone goes by are Alice and 小明. */
function screen(over: Partial<Screen> = {}): Screen {
  return {
    names: () => ["Alice", "小明", "Miyoria"],
    own: ["Miyoria", "米優"],
    moderate: (t) => !t.includes("BAD"),
    ...over,
  };
}

function rig(over: Partial<Screen> = {}, channels = [OPEN]) {
  let clock = 1_000_000;
  const state = new LiveState(
    { channels, screen: screen(over), maxViewers: 3, pats: { recent: 0, open: false } },
    () => clock,
  );
  const seen: LiveEvent[] = [];
  state.follow((e) => seen.push(e));
  const send = (event: Event) => state.onEvent(event, clock);
  const advance = (ms: number) => {
    clock += ms;
    state.tick(clock);
  };
  const lines = () => seen.flatMap((e) => (e.type === "line" ? [e.line] : []));
  return { state, seen, send, advance, lines };
}

const started = (turn: string, context: ContextKey): Event => ({
  type: "agent_turn_started",
  data: { turn, context },
});
const completed = (turn: string, context: ContextKey, said: string): Event => ({
  type: "agent_turn_completed",
  data: { turn, context, text: said },
});
const playback = (
  turn: string | null,
  context: ContextKey,
  state: "started" | "finished",
  said: string,
  extra: { emotion?: string | null; blocked?: string | null } = {},
): Event => ({
  type: "voice_playback",
  data: { context, turn, state, text: said, ...extra },
});

describe("the place rule", () => {
  it("takes listed server channels only: never a DM, a place outside a server or her own", () => {
    const listed = new Set([OPEN]);
    expect(isPublicPlace(text(OPEN), listed)).toBe(true);
    expect(isPublicPlace(voice(OPEN), listed)).toBe(true);
    expect(isPublicPlace(text(CLOSED), listed)).toBe(false);
    expect(isPublicPlace(text(OPEN, "dm"), listed)).toBe(false);
    expect(isPublicPlace({ ...text(OPEN), kind: "dm", scope: GUILD }, listed)).toBe(false);
    expect(isPublicPlace({ ...text(OPEN), scope: null }, listed)).toBe(false);
    expect(isPublicPlace({ ...text(OPEN), platform: "core" }, listed)).toBe(false);
    expect(isPublicPlace(null, listed)).toBe(false);
  });

  it("shows a line typed in a listed channel", () => {
    const r = rig();
    r.send(started("t1", text(OPEN)));
    r.send(completed("t1", text(OPEN), "今天好冷喔"));
    expect(r.lines()).toEqual([{ id: 1, text: "今天好冷喔", final: true, via: "text" }]);
    expect(r.state.snapshot().line?.text).toBe("今天好冷喔");
  });

  it("never shows a DM, an unlisted channel, or a thread listed only by its parent", () => {
    const r = rig();
    for (const [turn, context] of [
      ["d", text(OPEN, "dm")],
      ["c", text(CLOSED)],
      ["th", { ...text("300"), kind: "thread" as const }],
    ] as const) {
      r.send(started(turn, context));
      r.send(completed(turn, context, "秘密"));
    }
    expect(r.seen).toEqual([]);
    expect(r.state.snapshot().line).toBeNull();
  });

  it("lets a private turn change nothing: no thinking, no face, no speaking", () => {
    const r = rig();
    const dm = text(OPEN, "dm");
    r.send(started("d", dm));
    r.advance(2_000);
    r.send(customEvent("agent.emotion", { emotion: "sad", context: ctx(dm), turn: "d" }));
    r.send(customEvent("agent.emotion", { emotion: "sad", turn: "d" }));
    r.send(playback("d", voice(CLOSED), "started", "悄悄話", { emotion: "sad" }));
    expect(r.seen).toEqual([]);
    expect(r.state.snapshot()).toMatchObject({ activity: null, speaking: false });
  });

  it("follows a voice line as it is spoken, then makes it final", () => {
    const r = rig();
    const vc = voice(OPEN);
    r.send(started("v", vc));
    r.send(playback("v", vc, "started", "欸,", { emotion: "happy" }));
    r.send(playback("v", vc, "finished", "欸,"));
    r.send(playback("v", vc, "started", "你回來啦"));
    r.send(completed("v", vc, ""));
    r.send(playback("v", vc, "finished", "你回來啦"));
    expect(r.lines()).toEqual([
      { id: 1, text: "欸,", final: false, via: "voice" },
      { id: 1, text: "欸,你回來啦", final: false, via: "voice" },
      { id: 1, text: "欸,你回來啦", final: true, via: "voice" },
    ]);
    const kinds = r.seen.map((e) => e.type);
    expect(kinds).toContain("speaking");
    expect(r.seen).toContainEqual({ type: "emotion", emotion: { name: "happy", intensity: 1 } });
    expect(r.state.snapshot().speaking).toBe(false);
  });

  it("drops a line moderation replaced", () => {
    const r = rig();
    const vc = voice(OPEN);
    r.send(playback("b", vc, "started", "原本想說的", { blocked: "rule" }));
    expect(r.lines()).toEqual([]);
  });

  it("shows her resting face from anywhere: how she feels, not about what", () => {
    const r = rig();
    r.send(
      customEvent(AFFECT_CHANGED_TOPIC, {
        shown: { tag: "shy", from: "embarrassed" },
        top: [{ name: "embarrassed", intensity: 0.6 }],
      }),
    );
    expect(r.state.snapshot().emotion).toEqual({ name: "shy", intensity: 0.6 });
  });

  it("refuses an emotion name that is not one", () => {
    const r = rig();
    r.send(customEvent("agent.emotion", { emotion: "<img src=x>", context: ctx(text(OPEN)) }));
    r.send(customEvent("agent.emotion", { emotion: "x".repeat(40), context: ctx(text(OPEN)) }));
    expect(r.seen).toEqual([]);
  });
});

describe("the words rule", () => {
  it("drops a line that names anyone but her, a mention or an id", () => {
    const r = rig();
    const lines = [
      "Alice 早安",
      "小明你好",
      "<@123456789012345678> 來了",
      "看看 123456789012345678",
      "u1 你好",
    ];
    lines.forEach((said, i) => {
      r.send(started(`t${i}`, text(OPEN)));
      r.send(completed(`t${i}`, text(OPEN), said));
    });
    expect(r.lines()).toEqual([]);
  });

  it("lets her say her own name", () => {
    expect(mayShow(screen(), "Miyoria 今天也很可愛")).toBe(true);
    expect(mayShow(screen(), "米優肚子餓了")).toBe(true);
  });

  it("shows nothing when the names cannot be read, or without moderation", () => {
    expect(mayShow(screen({ names: () => null }), "今天好冷")).toBe(false);
    expect(mayShow(screen({ moderate: () => null }), "今天好冷")).toBe(false);
    expect(mayShow(screen(), "BAD 字")).toBe(false);
  });

  it("takes back a line that names someone halfway, and leaves it taken back", () => {
    const r = rig();
    const vc = voice(OPEN);
    r.send(started("v", vc));
    r.send(playback("v", vc, "started", "我跟你說,"));
    r.send(playback("v", vc, "started", "Alice 剛剛"));
    r.send(playback("v", vc, "started", "又來了"));
    r.send(completed("v", vc, ""));
    expect(r.lines()).toEqual([
      { id: 1, text: "我跟你說,", final: false, via: "voice" },
      { id: 1, text: "", final: true, via: "voice" },
    ]);
  });

  it("shows the end of a very long line", () => {
    const r = rig();
    r.send(started("t", text(OPEN)));
    r.send(completed("t", text(OPEN), `開頭${"嗯".repeat(400)}結尾`));
    const [line] = r.lines();
    expect([...(line?.text ?? "")].length).toBe(MAX_LINE_CHARS);
    expect(line?.text.startsWith("…")).toBe(true);
    expect(line?.text.endsWith("結尾")).toBe(true);
  });
});

describe("what she is doing", () => {
  const body = (over: Partial<ActivitySnapshot> = {}): ActivitySnapshot => ({
    version: 1,
    at: "2026-11-10T00:00:00.000Z",
    presence: { type: "none" },
    broadcast: { type: "off" },
    activity: { type: "idle", since: "2026-11-10T00:00:00.000Z" },
    override: null,
    scene: null,
    ...over,
  });

  it("reads her place like the public status", () => {
    expect(placeOf(null, false)).toEqual({ place: "offline", game: null });
    expect(placeOf(body(), false)).toEqual({ place: "idle", game: null });
    const vc = voice(OPEN);
    expect(placeOf(body({ presence: { type: "in", channel: vc, since: "x" } }), false).place).toBe(
      "in_voice",
    );
    const game = body({
      activity: {
        type: "game",
        target: "minecraft",
        phase: "running",
        task: null,
        failure: null,
        since: "x",
      },
    });
    expect(placeOf(game, false)).toEqual({ place: "playing", game: "minecraft" });
    expect(placeOf(game, true).place).toBe("singing");
  });

  it("shows thinking only for a public turn, after a moment", () => {
    const r = rig();
    r.send(started("t", text(OPEN)));
    expect(r.state.snapshot().activity).toBeNull();
    r.advance(500);
    expect(r.state.snapshot().activity?.kind).toBe("thinking");
    r.send(completed("t", text(OPEN), "好"));
    expect(r.state.snapshot().activity).toBeNull();
  });

  it("sings with the title on show and the lyrics left out", () => {
    const r = rig();
    r.state.setPresence(body());
    r.send(customEvent(SONG_TOPIC, { state: "started", song: "s1", title: "春日影" }));
    r.send(customEvent(SONG_TOPIC, { state: "line", song: "s1", index: 0, text: "歌詞" }));
    const snap = r.state.snapshot();
    expect(snap.activity).toMatchObject({ kind: "singing", detail: "春日影" });
    expect(snap.presence.place).toBe("singing");
    expect(r.lines()).toEqual([]);
    r.send(customEvent(SONG_TOPIC, { state: "ended", song: "s1", outcome: "finished" }));
    expect(r.state.snapshot().presence.place).toBe("idle");
  });

  it("leaves out a title moderation does not pass", () => {
    const r = rig();
    r.send(customEvent(SONG_TOPIC, { state: "started", song: "s1", title: "BAD song" }));
    expect(r.state.snapshot().activity).toMatchObject({ kind: "singing", detail: null });
  });
});

describe("watchers", () => {
  it("takes as many as configured, then turns the next away until one leaves", () => {
    const r = rig(); // one follows already
    const a = r.state.follow(() => {});
    const b = r.state.follow(() => {});
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(r.state.follow(() => {})).toBeNull();
    a?.();
    expect(r.state.follow(() => {})).not.toBeNull();
  });

  it("drops a watcher that throws, and goes on telling the others", () => {
    const r = rig();
    r.state.follow(() => {
      throw new Error("gone");
    });
    r.state.setPats({ recent: 1, open: true }, true);
    r.state.setPats({ recent: 2, open: true }, true);
    expect(r.seen.filter((e) => e.type === "pat")).toHaveLength(2);
    expect(r.state.viewers()).toBe(1);
  });
});
