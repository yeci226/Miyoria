// Her mind and the watch together: the person she picks in a thought is the person she watches.
// It lives here because core is the package that depends on both.

import { MockProvider } from "@miyoria/llm";
import { PlatformSinks, type WorldState } from "@miyoria/types";
import {
  NoticeBook,
  PendingStart,
  StartLog,
  WatchConfigSchema,
  watchCapabilities,
} from "@miyoria/watch";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GUILD, OWEN, rig, salient, stopRigs, VOICE, wait } from "../../mind/test/helpers.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-11-02T12:00:00.000Z")); // 20:00 at UTC+8
});

afterEach(async () => {
  await stopRigs();
  vi.useRealTimers();
});

describe("picking a stream in a thought", () => {
  it("person_reaches_watcher_start_with_two_people_streaming", async () => {
    const provider = new MockProvider("p").reply(
      JSON.stringify({
        thought: "阿華在玩的那個我想看",
        intents: [{ action: "watch.start", person: "u2", why: "好奇" }],
      }),
    );
    const r = await rig(provider, { withIntents: false });
    const hua = { platform: "discord", id: "200" };
    r.world.herVoice = VOICE;
    r.world.voiceMembers = [
      { account: OWEN, name: "Owen" },
      { account: hua, name: "阿華" },
    ];
    const snapshot = r.world.snapshot.bind(r.world);
    const world: WorldState = r.world;
    world.snapshot = () => {
      const s = snapshot();
      for (const room of s.voice_channels) for (const m of room.members) m.streaming = true;
      return s;
    };
    const sinks = new PlatformSinks();
    const send = vi.fn(async (context) => ({ context, id: "m" }));
    sinks.register({ platform: "discord", send } as never);
    const start = vi.fn(async () => {});
    const now = () => Date.now();
    const capabilities = watchCapabilities({
      cfg: WatchConfigSchema.parse({}),
      link: {
        channel: (guild) => (guild === GUILD ? VOICE.channel : null),
        isStreaming: () => false,
      },
      watcher: { view: () => null, start, stop: async () => {} },
      notices: new NoticeBook(24, now),
      starts: new StartLog(6, now),
      pending: new PendingStart(),
      world: () => world,
      sink: (platform) => sinks.get(platform),
      canLook: () => true,
      watchAllowed: async () => true,
      hidden: () => false,
      now,
      onStarted: () => {},
      warn: () => {},
    });
    for (const capability of capabilities) r.registry.register(capability);

    r.publish(salient("阿華開了直播", null));
    await wait(4100);

    expect(start).toHaveBeenCalledOnce();
    expect(start.mock.calls[0]).toEqual([
      expect.objectContaining({ guild: GUILD, channel: VOICE.channel, account: hua, name: "阿華" }),
      expect.any(AbortSignal),
    ]);
  });
});
