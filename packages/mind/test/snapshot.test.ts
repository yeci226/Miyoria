// What her mind is told about singing and about hearing the voice channel.

import { ActuatorRegistry, defineCapability } from "@miyoria/actions";
import { ServiceRegistry } from "@miyoria/kernel";
import { SpeechPauseKey, type VoiceChannelState, VoiceFloorKey } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { capabilityInfo, singing, voiceTalk } from "../src/snapshot.js";

function services(song: { playing: boolean; pending: number } | null, paused: boolean) {
  const s = new ServiceRegistry();
  if (song) {
    s.provide("test", VoiceFloorKey, {
      holder: () => (song.playing ? "song" : null),
      pending: () => song.pending,
    });
  }
  s.provide("test", SpeechPauseKey, { paused: () => (paused ? "song" : null) });
  return s;
}

describe("capabilityInfo", () => {
  it("shows the values an argument accepts, so Plan does not guess them", () => {
    const registry = new ActuatorRegistry({
      services: new ServiceRegistry(),
      builtins: false,
      publish: () => {},
    });
    registry.register(
      defineCapability({
        name: "game.start",
        summary: "開始玩遊戲",
        risk: "medium",
        args: z.looseObject({}),
        permission: null,
        tool: {
          name: "game_start",
          description: "開始玩遊戲",
          properties: {
            game: { type: "string", description: "遊戲 id" },
            where: { type: "string", enum: ["auto", "voice", "here", "stream"] },
            song: { type: "integer", description: "歌單編號(可省略)" },
            stream: { type: "boolean" },
          },
        },
        async execute() {
          return "ok";
        },
      }),
    );
    expect(capabilityInfo(registry)[0]?.params).toEqual([
      "game",
      "where=auto|voice|here|stream",
      "song(整數:歌單編號(可省略))",
      "stream(true/false)",
    ]);
  });
});

describe("singing", () => {
  it("lists the songs by the numbers she sings them with", () => {
    const s = new ServiceRegistry();
    s.provide("test", VoiceFloorKey, {
      holder: () => null,
      pending: () => 2,
      setlist: () => [
        { no: 251, label: "「櫻ノ詩」", ready: true },
        { no: 252, label: "「體操」", ready: false },
      ],
    });
    const { note } = singing(s, "g1");
    expect(note).toContain("#251 「櫻ノ詩」:好了,可以唱");
    expect(note).toContain("#252 「體操」:還在準備");
  });

  it("tells her a song is playing and how many are left", () => {
    const { note, deaf } = singing(services({ playing: true, pending: 3 }, false), "g1");
    expect(note).toContain("你正在唱歌:語音裡安靜是大家在聽");
    expect(note).toContain("歌單還有 2 首");
    expect(deaf).toBe(false);
  });

  it("tells her she cannot hear voice while a song is prepared", () => {
    const { note, deaf } = singing(services({ playing: false, pending: 1 }, true), "g1");
    expect(note).toContain("歌單還有 1 首");
    expect(note).toContain("你暫時聽不到語音裡的人說話");
    expect(deaf).toBe(true);
  });

  it("says nothing when no song is about and she can hear", () => {
    expect(singing(services({ playing: false, pending: 0 }, false), "g1")).toEqual({
      note: "",
      deaf: false,
    });
    expect(singing(services(null, false), null).note).toBe("");
  });
});

describe("voiceTalk", () => {
  const quiet = {
    activity: { recent_utterances: 0, secs_since_last: null, recent_speakers: [], lively: false },
  } as unknown as VoiceChannelState;

  it("does not call a channel quiet while she cannot hear it", () => {
    expect(voiceTalk(quiet)).toBe(";最近沒人說話");
    expect(voiceTalk(quiet, true)).toBe(";你現在聽不到這裡的人說話");
  });
});
