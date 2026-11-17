// Subtitles of her speech ahead of the voice, and her resting face.

import {
  type AnyEventDefinition,
  type ContextKey,
  type Envelope,
  type EventPayload,
  Events,
  eventEnvelope,
  type PublishMetaArgs,
} from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { type CoreMessage, Forwarder, parseCoreMessage } from "../src/index.js";

/** An event as the bus delivers it. */
const ev = <D extends AnyEventDefinition>(
  def: D,
  data: EventPayload<D>,
  ...meta: PublishMetaArgs<D>
): Envelope => eventEnvelope("test", def, data, ...meta);

const VOICE: ContextKey = { platform: "discord", scope: "g1", channel: "v1", kind: "voice" };
const TURN = "01JTURN0000000000000000000";

const playback = (state: "started" | "finished", text: string) =>
  ev(Events.VoicePlaybackEvent, { context: VOICE, turn: TURN, state, text, emotion: null });
const subtitles = (out: CoreMessage[]) => out.filter((m) => m.type === "subtitle");

describe("her resting face", () => {
  const affect = (tag: string | null, intensity = 0.6) =>
    ev(Events.AffectChanged, {
      shown: tag === null ? null : { from: "sorrow", tag, style: "", masked: false },
      top: tag === null ? [] : [{ name: "sorrow", intensity }],
    } as never);
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
    const line = (emotion: string) =>
      ev(Events.VoicePlaybackEvent, {
        context: VOICE,
        turn: TURN,
        state: "started",
        text: "嗯",
        emotion,
      });
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
    expect(f.onEvent(ev(Events.AffectChanged, "no" as never))).toEqual([]);
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
  const upcoming = (text: string, turn = TURN) =>
    ev(Events.VoiceUpcoming, { turn, context: { ...VOICE }, text, emotion: null });
  const failed = (text: string) =>
    ev(Events.VoicePlaybackEvent, {
      context: VOICE,
      turn: TURN,
      state: "failed",
      text,
      emotion: null,
    });
  const completed = () => ev(Events.AgentTurnCompleted, { turn: TURN, context: VOICE, text: "" });

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
});
