import type { JsonObject } from "@miyoria/types";
import type { VoiceLink } from "@miyoria/voice";
import { describe, expect, it, vi } from "vitest";
import { DiscordSource, LIVE_WAIT_MS } from "../src/discord.js";
import type { WatchTarget } from "../src/source.js";
import { SNAPSHOT_TIMEOUT_MS } from "../src/watcher.js";

const target: WatchTarget = {
  guild: "g1",
  channel: "c1",
  context: { platform: "discord", scope: "g1", channel: "c1", kind: "voice" },
  account: { platform: "discord", id: "u1" },
  name: "小明",
};

const status = (over: Partial<JsonObject> = {}): JsonObject => ({
  platform: "discord",
  guild: "g1",
  user_id: "u1",
  state: "live",
  error: null,
  reason: null,
  ...over,
});

function fakeLink() {
  return {
    watchStart: vi.fn(async (_guild: string, _user: string) => {}),
    watchStop: vi.fn(async (_guild: string) => {}),
    snapshot: vi.fn(async () => Buffer.from([1])),
    subscribeWatchAudio: vi.fn((signal?: AbortSignal) => {
      const queue = { signal };
      return queue as unknown as AsyncIterable<Int16Array>;
    }),
  };
}

const source = (link: ReturnType<typeof fakeLink>, ms?: number) =>
  new DiscordSource(link as unknown as VoiceLink, ms);

const settled = (p: Promise<unknown>): Promise<boolean> =>
  Promise.race([
    p.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((r) => setTimeout(() => r(false), 10)),
  ]);

describe("DiscordSource", () => {
  it("waits 15 seconds for live by default", () => {
    expect(LIVE_WAIT_MS).toBe(15_000);
  });

  it("start_waits_for_live", async () => {
    const link = fakeLink();
    const s = source(link);
    const started = s.start(target, new AbortController().signal);
    expect(await settled(started)).toBe(false);
    expect(link.watchStart).toHaveBeenCalledWith("g1", "u1");
    s.onStatus(status({ state: "starting" }));
    expect(await settled(started)).toBe(false);
    s.onStatus(status());
    await expect(started).resolves.toBeUndefined();
  });

  it("failed_rejects_with_its_error", async () => {
    const s = source(fakeLink());
    const started = s.start(target, new AbortController().signal);
    s.onStatus(status({ state: "failed", error: "codec VP8" }));
    await expect(started).rejects.toThrow("codec VP8");
  });

  it("a_stop_before_live_rejects_the_start", async () => {
    const s = source(fakeLink());
    const started = s.start(target, new AbortController().signal);
    s.onStatus(status({ state: "stopped", reason: "stream ended" }));
    await expect(started).rejects.toThrow("stream ended");
  });

  it("gives_up_without_live", async () => {
    const s = source(fakeLink(), 5);
    await expect(s.start(target, new AbortController().signal)).rejects.toThrow("go live");
  });

  it("stopped_ends_with_its_reason", async () => {
    const s = source(fakeLink());
    const started = s.start(target, new AbortController().signal);
    s.onStatus(status());
    await started;
    s.onStatus(status({ state: "stopped", reason: "streamer stopped" }));
    await expect(s.ended()).resolves.toBe("streamer stopped");
  });

  it("failed_after_live_ends_with_its_error", async () => {
    const s = source(fakeLink());
    const started = s.start(target, new AbortController().signal);
    s.onStatus(status());
    await started;
    s.onStatus(status({ state: "failed", error: "decoder died" }));
    await expect(s.ended()).resolves.toBe("decoder died");
  });

  it("other_peoples_status_does_not_touch_this_watch", async () => {
    const s = source(fakeLink());
    const started = s.start(target, new AbortController().signal);
    s.onStatus(status({ user_id: "u2" }));
    s.onStatus(status({ guild: "g2" }));
    s.onStatus(status({ platform: "elsewhere" }));
    expect(await settled(started)).toBe(false);
    s.onStatus(status());
    await started;
    s.onStatus(status({ user_id: "u2", state: "stopped", reason: "old" }));
    expect(await settled(s.ended())).toBe(false);
  });

  it("start_honours_its_signal", async () => {
    const link = fakeLink();
    const already = new AbortController();
    const reason = new Error("too late");
    already.abort(reason);
    await expect(source(link).start(target, already.signal)).rejects.toBe(reason);
    expect(link.watchStart).not.toHaveBeenCalled();

    const ctl = new AbortController();
    const s = source(link);
    const started = s.start(target, ctl.signal);
    ctl.abort(reason);
    await expect(started).rejects.toBe(reason);
  });

  it("stop_tolerates_a_failed_start", async () => {
    const link = fakeLink();
    link.watchStart.mockRejectedValue(new Error("no voice node connected"));
    link.watchStop.mockRejectedValue(new Error("no voice node connected"));
    const s = source(link);
    await expect(s.start(target, new AbortController().signal)).rejects.toThrow("no voice node");
    await expect(s.stop()).resolves.toBeUndefined();
  });

  it("stop_without_a_start_does_nothing", async () => {
    const link = fakeLink();
    await source(link).stop();
    expect(link.watchStop).not.toHaveBeenCalled();
  });

  it("stop_tells_the_node_once", async () => {
    const link = fakeLink();
    const s = source(link);
    const started = s.start(target, new AbortController().signal);
    s.onStatus(status());
    await started;
    await s.stop();
    await s.stop();
    expect(link.watchStop).toHaveBeenCalledTimes(1);
    expect(link.watchStop).toHaveBeenCalledWith("g1");
    await expect(s.ended()).resolves.toBeTypeOf("string");
  });

  it("a_stream_the_node_already_ended_is_not_stopped_again", async () => {
    const link = fakeLink();
    const s = source(link);
    const started = s.start(target, new AbortController().signal);
    s.onStatus(status());
    await started;
    s.onStatus(status({ state: "stopped", reason: "gone" }));
    await s.stop();
    expect(link.watchStop).not.toHaveBeenCalled();
  });

  it("a_timed_out_start_is_stopped_at_the_node", async () => {
    const link = fakeLink();
    const s = source(link, 5);
    await expect(s.start(target, new AbortController().signal)).rejects.toThrow();
    await s.stop();
    expect(link.watchStop).toHaveBeenCalledWith("g1");
  });

  it("snapshots_ask_the_guild_of_the_watch", async () => {
    const link = fakeLink();
    const s = source(link);
    const started = s.start(target, new AbortController().signal);
    s.onStatus(status());
    await started;
    const { signal } = new AbortController();
    await s.snapshot(signal);
    expect(link.snapshot).toHaveBeenCalledWith("g1", SNAPSHOT_TIMEOUT_MS, signal);
  });

  it("audio_ends_with_the_watch", async () => {
    const link = fakeLink();
    const s = source(link);
    const started = s.start(target, new AbortController().signal);
    s.onStatus(status());
    await started;
    s.audio();
    const signal = link.subscribeWatchAudio.mock.calls[0]?.[0];
    expect(signal?.aborted).toBe(false);
    await s.stop();
    expect(signal?.aborted).toBe(true);
  });
});
