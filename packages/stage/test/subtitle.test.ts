// Voice-first lines: she speaks the (Japanese) voice line first, the written (Chinese) sentence
// arrives as `agent.subtitle` and replaces it in the subtitle.

import { type ContextKey, customEvent, type Event, VOICE_UPCOMING_TOPIC } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { type CoreMessage, Forwarder, parseCoreMessage, SUBTITLE_TOPIC } from "../src/index.js";

const VOICE: ContextKey = { platform: "discord", scope: "g1", channel: "v1", kind: "voice" };
const TURN = "01JTURN0000000000000000000";

const playback = (state: "started" | "finished", text: string): Event =>
  ({
    type: "voice_playback",
    data: { context: VOICE, turn: TURN, state, text, emotion: null },
  }) as Event;
const written = (spoken: string, text: string, turn = TURN): Event =>
  customEvent(SUBTITLE_TOPIC, { turn, context: { ...VOICE }, spoken, text });
const subtitles = (out: CoreMessage[]) => out.filter((m) => m.type === "subtitle");

describe("voice-first subtitles", () => {
  it("swaps the spoken line for its written sentence, then keeps it", () => {
    const f = new Forwarder(false);
    expect(subtitles(f.onEvent(playback("started", "こんにちは")))).toEqual([
      { type: "subtitle", turn: TURN, text: "こんにちは", final: false },
    ]);
    expect(f.onEvent(written("こんにちは", "你好"))).toEqual([
      { type: "subtitle", turn: TURN, text: "你好", final: false },
    ]);
    f.onEvent(playback("finished", "こんにちは"));
    expect(subtitles(f.onEvent(playback("started", "元気?")))).toEqual([
      { type: "subtitle", turn: TURN, text: "你好元気?", final: false },
    ]);
    f.onEvent(written("元気?", "還好嗎?"));
    f.onEvent(playback("finished", "元気?"));
    const done = f.onEvent({
      type: "agent_turn_completed",
      data: { turn: TURN, context: VOICE, text: "你好還好嗎?" },
    } as Event);
    expect(subtitles(done)).toEqual([
      { type: "subtitle", turn: TURN, text: "你好還好嗎?", final: true },
    ]);
  });

  it("a written sentence that comes before the line plays is used when it plays", () => {
    const f = new Forwarder(false);
    expect(f.onEvent(written("おはよう", "早安"))).toEqual([]);
    expect(subtitles(f.onEvent(playback("started", "おはよう")))).toEqual([
      { type: "subtitle", turn: TURN, text: "早安", final: false },
    ]);
  });

  it("after the final subtitle the correction is final too; junk is ignored", () => {
    const f = new Forwarder(false);
    f.onEvent(playback("started", "ありがとう"));
    f.onEvent({
      type: "agent_turn_completed",
      data: { turn: TURN, context: VOICE, text: "" },
    } as Event);
    expect(subtitles(f.onEvent(playback("finished", "ありがとう")))).toEqual([
      { type: "subtitle", turn: TURN, text: "ありがとう", final: true },
    ]);
    expect(f.onEvent(written("ありがとう", "謝謝"))).toEqual([
      { type: "subtitle", turn: TURN, text: "謝謝", final: true },
    ]);
    expect(f.onEvent(customEvent(SUBTITLE_TOPIC, { turn: TURN, spoken: "", text: "x" }))).toEqual(
      [],
    );
    expect(f.onEvent(customEvent(SUBTITLE_TOPIC, "junk"))).toEqual([]);
  });
});

describe("her resting face", () => {
  const affect = (tag: string | null, intensity = 0.6): Event =>
    customEvent("affect.changed", {
      shown: tag === null ? null : { from: "sorrow", tag, style: "", masked: false },
      top: tag === null ? [] : [{ name: "sorrow", intensity }],
    });
  const emotions = (out: CoreMessage[]) => out.filter((m) => m.type === "emotion");

  it("follows what she shows, also while she says nothing", () => {
    const f = new Forwarder(false);
    expect(f.onEvent(affect("sad"))).toEqual([
      { type: "emotion", name: "sad", intensity: 0.6, resting: true },
    ]);
    expect(f.onEvent(affect(null))).toEqual([
      { type: "emotion", name: "neutral", intensity: 0, resting: true },
    ]);
  });

  it("only when it changed", () => {
    const f = new Forwarder(false);
    expect(f.onEvent(affect(null))).toEqual([]);
    f.onEvent(affect("sad", 0.6));
    expect(f.onEvent(affect("sad", 0.65))).toEqual([]);
    expect(f.onEvent(affect("sad", 0.8))).toHaveLength(1);
    expect(f.onEvent(affect("annoyed", 0.8))).toHaveLength(1);
  });

  it("a node that connects gets it", () => {
    const f = new Forwarder(false);
    expect(f.resumeResting()).toBeNull();
    f.onEvent(affect("sad"));
    expect(f.resumeResting()).toEqual({
      type: "emotion",
      name: "sad",
      intensity: 0.6,
      resting: true,
    });
  });

  it("a line said in it without a marker shows it as strongly as she feels it", () => {
    const f = new Forwarder(false);
    f.onEvent(affect("sad", 0.5));
    const line = (emotion: string): Event =>
      ({
        type: "voice_playback",
        data: { context: VOICE, turn: TURN, state: "started", text: "嗯", emotion },
      }) as Event;
    expect(emotions(f.onEvent(line("sad")))).toEqual([
      { type: "emotion", name: "sad", intensity: 0.5 },
    ]);
    // Another tag than what she shows: the marker's own strength, as before.
    expect(emotions(f.onEvent(line("happy")))).toEqual([
      { type: "emotion", name: "happy", intensity: 1 },
    ]);
  });

  it("a payload that is not a snapshot is her plain rest", () => {
    const f = new Forwarder(false);
    expect(f.onEvent(customEvent("affect.changed", "no"))).toEqual([]);
  });

  it("the protocol carries it, and an older message still reads", () => {
    expect(parseCoreMessage({ type: "emotion", name: "sad", intensity: 1, resting: true })).toEqual(
      {
        type: "emotion",
        name: "sad",
        intensity: 1,
        resting: true,
      },
    );
    expect(parseCoreMessage({ type: "emotion", name: "sad", intensity: 1 })).toEqual({
      type: "emotion",
      name: "sad",
      intensity: 1,
    });
  });
});

describe("subtitles ahead of the voice", () => {
  const upcoming = (text: string, turn = TURN): Event =>
    customEvent(VOICE_UPCOMING_TOPIC, { turn, context: { ...VOICE }, text, emotion: null });
  const failed = (text: string): Event =>
    ({
      type: "voice_playback",
      data: { context: VOICE, turn: TURN, state: "failed", text, emotion: null },
    }) as Event;
  const completed = (): Event =>
    ({ type: "agent_turn_completed", data: { turn: TURN, context: VOICE, text: "" } }) as Event;

  it("a line announced as upcoming shows then, and its start adds nothing", () => {
    const f = new Forwarder(false);
    expect(subtitles(f.onEvent(upcoming("你好")))).toEqual([
      { type: "subtitle", turn: TURN, text: "你好", final: false },
    ]);
    expect(subtitles(f.onEvent(playback("started", "你好")))).toEqual([
      { type: "subtitle", turn: TURN, text: "你好", final: false },
    ]);
    // The next one is announced while the first still plays.
    expect(subtitles(f.onEvent(upcoming("還好嗎?")))).toEqual([
      { type: "subtitle", turn: TURN, text: "你好還好嗎?", final: false },
    ]);
    f.onEvent(playback("finished", "你好"));
    // The turn is written out but its last line has not played: not final yet.
    expect(subtitles(f.onEvent(completed()))).toEqual([]);
    f.onEvent(playback("started", "還好嗎?"));
    expect(subtitles(f.onEvent(playback("finished", "還好嗎?")))).toEqual([
      { type: "subtitle", turn: TURN, text: "你好還好嗎?", final: true },
    ]);
  });

  it("an announced line that fails is taken out again", () => {
    const f = new Forwarder(false);
    f.onEvent(upcoming("一"));
    f.onEvent(playback("started", "一"));
    f.onEvent(upcoming("二"));
    f.onEvent(upcoming("三"));
    f.onEvent(playback("finished", "一"));
    expect(subtitles(f.onEvent(failed("二")))).toEqual([
      { type: "subtitle", turn: TURN, text: "一三", final: false },
    ]);
    f.onEvent(completed());
    f.onEvent(playback("started", "三"));
    expect(subtitles(f.onEvent(playback("finished", "三")))).toEqual([
      { type: "subtitle", turn: TURN, text: "一三", final: true },
    ]);
  });

  it("the written sentence still replaces a line shown early", () => {
    const f = new Forwarder(false);
    f.onEvent(upcoming("こんにちは"));
    expect(f.onEvent(written("こんにちは", "你好"))).toEqual([
      { type: "subtitle", turn: TURN, text: "你好", final: false },
    ]);
  });
});
