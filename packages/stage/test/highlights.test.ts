import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { customEvent, SONG_TOPIC } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import {
  EMOTION_TOPIC,
  Highlights,
  HighlightsConfigSchema,
  type Obs,
  ObsConfigSchema,
  ObsController,
  parseCoreMessage,
  parseStageMessage,
} from "../src/index.js";

const cfg = (over: object = {}) => HighlightsConfigSchema.parse({ cooldown_secs: 60, ...over });
const song = (state: string, extra: object = {}) =>
  customEvent(SONG_TOPIC, { state, song: "yt-a", title: "雪は何色", ...extra });

describe("highlights", () => {
  it("a_song_sung_to_the_end_is_one", () => {
    const h = new Highlights(cfg());
    expect(h.onEvent(song("started"), 0)).toBeNull();
    expect(h.onEvent(song("ended", { outcome: "finished" }), 1_000)).toBe("唱完《雪は何色》");
    const skipped = new Highlights(cfg());
    skipped.onEvent(song("started"), 0);
    expect(skipped.onEvent(song("ended", { outcome: "interrupted" }), 1_000)).toBeNull();
  });

  it("a_strong_feeling_counts_and_the_cooldown_holds", () => {
    const h = new Highlights(cfg());
    const feel = (emotion: string, intensity: number) =>
      customEvent(EMOTION_TOPIC, { emotion, intensity });
    expect(h.onEvent(feel("laugh", 0.5), 0)).toBeNull();
    expect(h.onEvent(feel("sad", 1), 0)).toBeNull();
    expect(h.onEvent(feel("LAUGH", 0.95), 0)).toContain("laugh");
    expect(h.onEvent(feel("laugh", 1), 30_000)).toBeNull();
    expect(h.onEvent(feel("surprised", 1), 61_000)).toContain("surprised");
  });

  it("the_chat_taking_off_counts", () => {
    const h = new Highlights(cfg({ chat_burst_messages: 3, chat_burst_secs: 10 }));
    expect(h.message(0)).toBeNull();
    expect(h.message(20_000)).toBeNull(); // the first one is out of the window
    expect(h.message(21_000)).toBeNull();
    expect(h.message(22_000)).toBe("聊天室突然熱起來");
    expect(new Highlights(cfg({ chat_burst_messages: 0 })).message(0)).toBeNull();
    expect(new Highlights(cfg({ enabled: false })).onEvent(song("ended"), 0)).toBeNull();
  });

  it("parses_the_wire_messages", () => {
    expect(parseCoreMessage({ type: "clip", reason: "唱完", id: 3 })).toStrictEqual({
      type: "clip",
      reason: "唱完",
      id: 3,
    });
    expect(parseStageMessage({ type: "clip_saved", reason: "唱完", path: "C:\\r.mkv" })).toEqual({
      type: "clip_saved",
      reason: "唱完",
      path: "C:\\r.mkv",
    });
  });
});

/** OBS with a replay buffer that writes `replay-<n>.mkv` into `dir`. */
function fakeObs(dir: string, active: boolean): Obs & { started: number } {
  let n = 0;
  const obs = {
    started: 0,
    currentScene: async () => "聊天",
    setScene: async () => undefined,
    streaming: async () => true,
    startStream: async () => undefined,
    stopStream: async () => undefined,
    setText: async () => undefined,
    replayBufferActive: async () => active,
    startReplayBuffer: async () => {
      obs.started++;
      active = true;
    },
    saveReplay: async () => {
      n++;
      const path = join(dir, `replay-${n}.mkv`);
      writeFileSync(path, "x");
      return path;
    },
  };
  return obs;
}

describe("ObsController highlights", () => {
  const connector = (obs: Obs) => ({ connect: async () => obs });

  it("saves_the_replay_with_a_note_and_keeps_the_buffer_running_while_live", async () => {
    const dir = mkdtempSync(join(tmpdir(), "miyoria-clip-"));
    const obs = fakeObs(dir, false);
    const controller = new ObsController(connector(obs), ObsConfigSchema.parse({}));
    const run = new AbortController();
    const running = controller.run(run.signal);
    for (let i = 0; i < 50 && controller.connection() === null; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    await controller.refresh();
    expect(obs.started).toBe(1);
    const path = await controller.clip("唱完《雪は何色》", () => Date.UTC(2026, 10, 10));
    expect(path).toBe(join(dir, "replay-1.mkv"));
    const note = JSON.parse(readFileSync(`${path}.json`, "utf8"));
    expect(note).toEqual({ reason: "唱完《雪は何色》", at: "2026-11-10T00:00:00.000Z" });
    run.abort();
    await running;
  });

  it("saves_nothing_while_the_buffer_is_off", async () => {
    const dir = mkdtempSync(join(tmpdir(), "miyoria-clip-"));
    const obs = fakeObs(dir, false);
    const controller = new ObsController(
      connector(obs),
      ObsConfigSchema.parse({ replay_buffer: false }),
    );
    const run = new AbortController();
    const running = controller.run(run.signal);
    for (let i = 0; i < 50 && controller.connection() === null; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    await controller.refresh();
    expect(obs.started).toBe(0);
    expect(await controller.clip("x")).toBeNull();
    run.abort();
    await running;
  });
});
