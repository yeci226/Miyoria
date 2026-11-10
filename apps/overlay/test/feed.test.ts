import { describe, expect, it } from "vitest";
import {
  type Action,
  initialState,
  MAX_QUEUE_ITEMS,
  MAX_SCREEN_CARDS,
  type OverlayState,
  parseMessage,
  parseQueueItem,
  reduce,
  shownActivity,
} from "../src/feed.js";

const run = (actions: Action[], from: OverlayState = initialState()): OverlayState => actions.reduce(reduce, from);
const sub = (turn: string, text: string, final = false): Action => ({ type: "subtitle", turn, text, final });

describe("gift line", () => {
  it("parses the Stage's gift frame; empty text hides it", () => {
    expect(parseMessage('{"type":"gift","text":"Owen 餵了她一碗白飯"}')).toEqual({ type: "gift", text: "Owen 餵了她一碗白飯" });
    expect(parseMessage('{"type":"gift","text":""}')).toEqual({ type: "gift", text: null });
    expect(parseMessage('{"type":"gift"}')).toEqual({ type: "gift", text: null });
  });

  it("shows, replaces and clears the line, and drops it with the connection", () => {
    const on = run([{ type: "gift", text: "a" }]);
    expect(on.gift).toBe("a");
    expect(reduce(on, { type: "gift", text: "a" })).toBe(on);
    expect(reduce(on, { type: "gift", text: "b" }).gift).toBe("b");
    expect(reduce(on, { type: "gift", text: null }).gift).toBeNull();
    expect(reduce(on, { type: "connection", connected: false }).gift).toBeNull();
  });
});

describe("screen cards", () => {
  const card = (text: string): Action => ({ type: "screen", kind: "message", name: "Owen", text, song: null });

  it("parses messages and dedications, and drops what is not a card", () => {
    expect(parseMessage('{"type":"screen","kind":"message","name":" Owen ","text":"加油","song":null}')).toEqual({
      type: "screen", kind: "message", name: "Owen", text: "加油", song: null,
    });
    expect(parseMessage('{"type":"screen","kind":"dedication","name":"A","text":"給 B","song":"春日影"}')).toMatchObject({
      kind: "dedication", song: "春日影",
    });
    // A dedication without a song is a message; a message has no song.
    expect(parseMessage('{"type":"screen","kind":"dedication","name":"A","text":"x","song":""}')).toMatchObject({ kind: "message", song: null });
    expect(parseMessage('{"type":"screen","kind":"message","name":"A","text":"x","song":"s"}')).toMatchObject({ song: null });
    for (const bad of [
      '{"type":"screen","kind":"other","name":"A","text":"x"}',
      '{"type":"screen","kind":"message","name":"","text":"x"}',
      '{"type":"screen","kind":"message","name":"A","text":" "}',
    ]) {
      expect(parseMessage(bad), bad).toBeNull();
    }
  });

  it("queues cards in order, each with its own id, even the same text twice", () => {
    const s = run([card("a"), card("a"), card("b")]);
    expect(s.screens.map((c) => [c.id, c.text])).toEqual([[1, "a"], [2, "a"], [3, "b"]]);
    expect(s.screenSeq).toBe(3);
  });

  it("moves on when the shown card is done, and ignores a late or wrong ack", () => {
    const s = run([card("a"), card("b")]);
    expect(reduce(s, { type: "screen_done", id: 2 })).toBe(s);
    const next = reduce(s, { type: "screen_done", id: 1 });
    expect(next.screens.map((c) => c.text)).toEqual(["b"]);
    expect(reduce(next, { type: "screen_done", id: 1 })).toBe(next);
    expect(reduce(next, { type: "screen_done", id: 2 }).screens).toEqual([]);
  });

  it("holds at most the cap: the oldest waiting one goes, never the one on screen", () => {
    expect(MAX_SCREEN_CARDS).toBe(5);
    const s = run(["1", "2", "3", "4", "5", "6", "7"].map((t) => card(t)));
    expect(s.screens).toHaveLength(MAX_SCREEN_CARDS);
    expect(s.screens.map((c) => c.text)).toEqual(["1", "4", "5", "6", "7"]);
  });

  it("drops every card with the connection", () => {
    expect(reduce(run([card("a"), card("b")]), { type: "connection", connected: false }).screens).toEqual([]);
  });
});

describe("parseMessage", () => {
  it("parses the Stage's subtitle frame", () => {
    expect(parseMessage('{"type":"subtitle","turn":"t1","text":"你好","final":false}')).toEqual({
      type: "subtitle", turn: "t1", text: "你好", final: false,
    });
    expect(parseMessage('{"type":"subtitle","turn":"t1","text":"你好。","final":true}')).toMatchObject({ final: true });
  });

  it("tolerates a missing / numeric turn and a missing final", () => {
    expect(parseMessage('{"type":"subtitle","text":"a"}')).toEqual({ type: "subtitle", turn: "", text: "a", final: false });
    expect(parseMessage('{"type":"subtitle","turn":7,"text":"a"}')).toMatchObject({ turn: "7" });
  });

  it("parses emotion: lowercases the name, defaults and clamps intensity", () => {
    expect(parseMessage('{"type":"emotion","name":"Happy","intensity":0.5}')).toEqual({ type: "emotion", name: "happy", intensity: 0.5 });
    expect(parseMessage('{"type":"emotion","name":"sad"}')).toMatchObject({ intensity: 1 });
    expect(parseMessage('{"type":"emotion","name":"sad","intensity":7}')).toMatchObject({ intensity: 1 });
    expect(parseMessage('{"type":"emotion","name":"sad","intensity":-1}')).toMatchObject({ intensity: 0 });
    expect(parseMessage('{"type":"emotion","name":"  "}')).toBeNull();
  });

  it("parses speaking and status", () => {
    expect(parseMessage('{"type":"speaking","state":"started"}')).toEqual({ type: "speaking", state: "started" });
    expect(parseMessage('{"type":"speaking","state":"maybe"}')).toBeNull();
    expect(parseMessage('{"type":"status","core":true,"vts":false,"obs":true,"scene":"Game","streaming":true}')).toEqual({
      type: "status",
      status: { core: true, vts: false, obs: true, scene: "Game", streaming: true },
    });
    expect(parseMessage('{"type":"status","scene":null}')).toEqual({
      type: "status",
      status: { core: false, vts: false, obs: false, scene: null, streaming: false },
    });
  });

  it("parses queue items given as strings or objects, skipping junk, capped", () => {
    const m = parseMessage(
      JSON.stringify({
        type: "queue",
        items: ["夜に駆ける", { title: "Minecraft", user: "阿翔" }, { text: "x", by: "" }, 5, null, {}, "  "],
      }),
    );
    expect(m).toEqual({
      type: "queue",
      items: [
        { title: "夜に駆ける", by: null },
        { title: "Minecraft", by: "阿翔" },
        { title: "x", by: null },
      ],
    });
    const many = parseMessage(JSON.stringify({ type: "queue", items: Array.from({ length: 40 }, (_, i) => `s${i}`) }));
    expect(many && many.type === "queue" && many.items.length).toBe(MAX_QUEUE_ITEMS);
    expect(parseMessage('{"type":"queue","items":"nope"}')).toBeNull();
  });

  it("returns null (never throws) for garbage", () => {
    for (const bad of ["", "not json", "[]", "null", "42", '{"type":"nope"}', '{"text":"x"}', '{"type":"subtitle","text":5}']) {
      expect(parseMessage(bad), bad).toBeNull();
    }
  });

  it("parseQueueItem prefers title over text and truncates long titles", () => {
    expect(parseQueueItem({ text: "b", title: "a" })).toEqual({ title: "a", by: null });
    expect(parseQueueItem({ title: "x".repeat(500) })?.title.length).toBe(160);
  });
});

describe("reduce", () => {
  it("starts empty and offline", () => {
    expect(initialState()).toEqual({
      connected: false, speaking: false, subtitleSeq: 0, subtitle: null, emotion: null, status: null, queue: [], notice: null, activity: null, gift: null, screens: [], screenSeq: 0,
    });
  });

  it("grows a subtitle across partials of one turn and bumps the sequence each time", () => {
    const s = run([sub("t1", "你"), sub("t1", "你好"), sub("t1", "你好嗎")]);
    expect(s.subtitle).toEqual({ turn: "t1", text: "你好嗎", final: false });
    expect(s.subtitleSeq).toBe(3);
  });

  it("marks the subtitle final; a late partial of the same turn does not reopen it", () => {
    const done = run([sub("t1", "你好"), sub("t1", "你好嗎。", true)]);
    expect(done.subtitle?.final).toBe(true);
    expect(reduce(done, sub("t1", "你好嗎"))).toBe(done);
  });

  it("ignores an identical repeat (the Stage resends the latest subtitle to a new client)", () => {
    const s = run([sub("t1", "你好", true)]);
    expect(reduce(s, sub("t1", "你好", true))).toBe(s);
  });

  it("a new turn replaces the old one, even after a final", () => {
    const s = run([sub("t1", "你好", true), sub("t2", "再見")]);
    expect(s.subtitle).toEqual({ turn: "t2", text: "再見", final: false });
  });

  it("accepts a revision of the same turn (a corrected transcript)", () => {
    const s = run([sub("t1", "你好嗎"), sub("t1", "妳好嗎")]);
    expect(s.subtitle?.text).toBe("妳好嗎");
    expect(s.subtitleSeq).toBe(2);
  });

  it("an empty final clears the subtitle; an empty partial does not", () => {
    expect(run([sub("t1", "你好"), sub("t1", "", true)]).subtitle).toBeNull();
    expect(run([sub("t1", "你好"), sub("t2", "")]).subtitle).toEqual({ turn: "t2", text: "", final: false });
  });

  it("keeps emotion, status and queue as the latest message", () => {
    const s = run([
      { type: "emotion", name: "happy", intensity: 1 },
      { type: "emotion", name: "sad", intensity: 0.4 },
      { type: "status", status: { core: true, vts: true, obs: false, scene: "Chat", streaming: false } },
      { type: "queue", items: [{ title: "a", by: null }] },
      { type: "queue", items: [] },
    ]);
    expect(s.emotion).toEqual({ name: "sad", intensity: 0.4 });
    expect(s.status?.scene).toBe("Chat");
    expect(s.queue).toEqual([]);
  });

  it("tracks speaking, and a dropped connection stops it", () => {
    const talking = run([{ type: "connection", connected: true }, { type: "speaking", state: "started" }]);
    expect(talking).toMatchObject({ connected: true, speaking: true });
    expect(reduce(talking, { type: "speaking", state: "stopped" }).speaking).toBe(false);
    expect(reduce(talking, { type: "connection", connected: false })).toMatchObject({ connected: false, speaking: false });
  });

  it("does not mutate the previous state", () => {
    const a = initialState();
    const frozen = Object.freeze({ ...a });
    expect(() => reduce(frozen, sub("t", "x"))).not.toThrow();
    expect(a.subtitle).toBeNull();
  });

  it("shows a notice until an empty one clears it", () => {
    const on = parseMessage('{"type":"notice","text":" 準備歌曲中… "}');
    expect(on).toEqual({ type: "notice", text: "準備歌曲中…" });
    expect(parseMessage('{"type":"notice"}')).toBeNull();
    const shown = run([on as Action]);
    expect(shown.notice).toBe("準備歌曲中…");
    expect(reduce(shown, on as Action)).toBe(shown);
    expect(run([{ type: "notice", text: "" }], shown).notice).toBeNull();
  });

  it("parses activity: kinds, determinate / indeterminate progress, a song's clock", () => {
    expect(
      parseMessage(
        '{"type":"activity","kind":"song_prepare","label":"轉換歌聲","detail":"夜に駆ける","progress":0.46,"elapsed_ms":null,"duration_ms":null}',
      ),
    ).toEqual({
      type: "activity",
      activity: { kind: "song_prepare", label: "轉換歌聲", detail: "夜に駆ける", progress: 0.46, elapsedMs: null, durationMs: null },
    });
    expect(parseMessage('{"type":"activity","kind":"thinking","label":"思考中…","detail":null,"progress":null}')).toEqual({
      type: "activity",
      activity: { kind: "thinking", label: "思考中…", detail: null, progress: null, elapsedMs: null, durationMs: null },
    });
    expect(
      parseMessage('{"type":"activity","kind":"singing","label":"正在唱","detail":"アイドル","elapsed_ms":4000,"duration_ms":200000}'),
    ).toMatchObject({ activity: { elapsedMs: 4000, durationMs: 200000, progress: null } });
    // A song without a usable length has no clock; progress is clamped.
    expect(parseMessage('{"type":"activity","kind":"singing","label":"正在唱","elapsed_ms":4000,"duration_ms":-1}')).toMatchObject({
      activity: { elapsedMs: null, durationMs: null },
    });
    expect(parseMessage('{"type":"activity","kind":"song_prepare","label":"x","progress":3}')).toMatchObject({ activity: { progress: 1 } });
    // Hidden: kind null, or nothing to say.
    expect(parseMessage('{"type":"activity","kind":null}')).toEqual({ type: "activity", activity: null });
    expect(parseMessage('{"type":"activity","kind":"thinking","label":"  "}')).toEqual({ type: "activity", activity: null });
    // Malformed: ignored.
    expect(parseMessage('{"type":"activity"}')).toBeNull();
    expect(parseMessage('{"type":"activity","kind":7,"label":"x"}')).toBeNull();
    expect(parseMessage('{"type":"activity","kind":"<b>","label":"x"}')).toBeNull();
    const long = parseMessage(JSON.stringify({ type: "activity", kind: "singing", label: "長".repeat(99), detail: "曲".repeat(999) }));
    expect(long?.type === "activity" && long.activity?.label.length).toBe(40);
    expect(long?.type === "activity" && long.activity?.detail?.length).toBe(160);
  });

  it("keeps the activity; the same one again is no change; a dropped feed clears it", () => {
    const thinking = parseMessage('{"type":"activity","kind":"thinking","label":"思考中…"}') as Action;
    const s = run([{ type: "connection", connected: true }, thinking]);
    expect(s.activity).toMatchObject({ kind: "thinking" });
    expect(reduce(s, thinking)).toBe(s);
    expect(reduce(s, { type: "activity", activity: null }).activity).toBeNull();
    expect(reduce(s, { type: "connection", connected: false }).activity).toBeNull();
  });

  it("the capsule shows the activity, else an older Core's notice", () => {
    const notice = run([{ type: "notice", text: "準備歌曲中…" }]);
    expect(shownActivity(notice)).toEqual({
      kind: "notice", label: "準備歌曲中…", detail: null, progress: null, elapsedMs: null, durationMs: null,
    });
    const both = run([parseMessage('{"type":"activity","kind":"song_prepare","label":"下載中","progress":0.1}') as Action], notice);
    expect(shownActivity(both)).toMatchObject({ kind: "song_prepare", label: "下載中" });
    expect(shownActivity(initialState())).toBeNull();
  });
});
