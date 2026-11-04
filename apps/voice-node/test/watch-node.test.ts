import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { OpusDecoderLike } from "../src/capture.js";
import { loadConfig } from "../src/config.js";
import { noopLogger } from "../src/log.js";
import { VoiceNode } from "../src/node.js";
import type { CoreMessage, NodeMessage } from "../src/protocol.js";
import type { WatchEngine, WatchHooks, WatchPlan } from "../src/watch/manager.js";

vi.mock("../src/watch/snapshot.js", () => ({
  keyframeToJpeg: async (h264: Buffer) => Buffer.concat([Buffer.from("JPEG:"), h264]),
}));
vi.mock("../src/capture.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/capture.js")>();
  const decoder: OpusDecoderLike = { decode: () => Buffer.alloc(960 * 4), delete: () => {} };
  return { ...orig, createOpusDecoder: () => decoder };
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

interface Run {
  plan: WatchPlan;
  hooks: WatchHooks;
  signal: AbortSignal;
  fail(e: Error): void;
}

function setup(over: { streaming?: boolean; channel?: string; ready?: boolean; inGuild?: boolean } = {}) {
  const sent: NodeMessage[] = [];
  const binary: Buffer[] = [];
  const link = Object.assign(new EventEmitter(), {
    send: (m: NodeMessage) => {
      sent.push(m);
      return true;
    },
    sendAudio: (b: Buffer) => {
      binary.push(b);
      return true;
    },
  });
  const voiceStates = new Map<string, { channelId: string; streaming: boolean }>();
  voiceStates.set("u1", { channelId: over.channel ?? "vc", streaming: over.streaming ?? true });
  const guilds = new Map<string, unknown>();
  guilds.set("g1", { id: "g1", voiceStates: { cache: voiceStates } });
  const client = Object.assign(new EventEmitter(), { user: { id: "self" }, guilds: { cache: guilds } });

  const runs: Run[] = [];
  const requestKeyframe = vi.fn();
  const engine: WatchEngine = {
    run: (plan, hooks, signal) =>
      new Promise<string>((resolve, reject) => {
        runs.push({ plan, hooks, signal, fail: reject });
        signal.addEventListener("abort", () => resolve("aborted"), { once: true });
      }),
    requestKeyframe,
  };

  const node = new VoiceNode(client as never, link as never, loadConfig({ SELF_TOKEN: "x" }), noopLogger, {
    watchEngine: engine,
    goLiveEngine: { run: () => new Promise(() => {}) } as never,
    probeNvenc: async () => false,
  });
  node.start();
  const session = {
    guildId: "g1",
    channelId: "vc",
    isClosed: false,
    queue: undefined,
    voiceSessionId: () => (over.ready === false ? undefined : "sess-1"),
    close: vi.fn(),
    onLinkDown: vi.fn(),
    onLinkReset: vi.fn(),
    announce: vi.fn(),
  };
  if (over.inGuild !== false) (node as unknown as { sessions: Map<string, unknown> }).sessions.set("g1", session);
  const core = (msg: CoreMessage): void => {
    link.emit("message", msg);
  };
  const watchMsgs = (): Array<Extract<NodeMessage, { type: "watch" }>> =>
    sent.filter((m): m is Extract<NodeMessage, { type: "watch" }> => m.type === "watch");
  return { node, link, sent, binary, runs, session, core, watchMsgs, requestKeyframe };
}

describe("VoiceNode watch", () => {
  it("watch_messages_reach_the_manager", async () => {
    const t = setup();
    t.core({ type: "watch_start", guild: "g1", user_id: "u1" });
    await flush();
    expect(t.runs).toHaveLength(1);
    expect(t.runs[0]?.plan).toEqual({ guild: "g1", channel: "vc", userId: "u1", sessionId: "sess-1" });
    expect(t.watchMsgs().map((m) => m.state)).toEqual(["starting"]);
    t.core({ type: "watch_snapshot", id: 7 });
    expect(t.requestKeyframe).toHaveBeenCalled();
    t.core({ type: "watch_stop", guild: "g1" });
    await flush();
    expect(t.watchMsgs().at(-1)).toMatchObject({ state: "stopped" });
  });

  it("events_become_link_messages", async () => {
    const t = setup();
    t.core({ type: "watch_start", guild: "g1", user_id: "u1" });
    await flush();
    const hooks = t.runs[0]?.hooks as WatchHooks;
    hooks.onLive();
    expect(t.watchMsgs().at(-1)).toEqual({ type: "watch", guild: "g1", user_id: "u1", state: "live" });

    t.core({ type: "watch_snapshot", id: 7 });
    hooks.onKeyframe(Buffer.from("frame"));
    await flush();
    const snap = t.binary.find((b) => b[0] === 0x04);
    expect(snap?.readUInt32LE(1)).toBe(7);
    expect(snap?.subarray(5).toString()).toBe("JPEG:frame");

    for (let i = 0; i < 5; i++) hooks.onOpus(Buffer.from([1, 2, 3, 4]));
    expect(t.binary.some((b) => b[0] === 0x05)).toBe(true);

    t.core({ type: "watch_snapshot", id: 8 });
    t.core({ type: "watch_stop", guild: "g1" });
    await flush();
    expect(t.sent).toContainEqual({ type: "watch_snapshot_failed", id: 8, error: "watch ended" });
  });

  it("leaving_voice_stops_the_watch", async () => {
    const t = setup();
    t.core({ type: "watch_start", guild: "g1", user_id: "u1" });
    await flush();
    t.core({ type: "leave", guild: "g1" });
    await flush();
    expect(t.watchMsgs().at(-1)).toMatchObject({ state: "stopped", reason: "left voice" });
  });

  it("core_going_down_stops_the_watch", async () => {
    const t = setup();
    t.core({ type: "watch_start", guild: "g1", user_id: "u1" });
    await flush();
    t.link.emit("down");
    await flush();
    expect(t.watchMsgs().at(-1)).toMatchObject({ state: "stopped", reason: "core disconnected" });
  });

  it("go_live_start_stops_the_watch_first", async () => {
    const t = setup();
    t.core({ type: "watch_start", guild: "g1", user_id: "u1" });
    await flush();
    t.core({ type: "golive_start", guild: "g1", source: "srt://127.0.0.1:9999" });
    await flush();
    expect(t.watchMsgs().at(-1)).toMatchObject({ state: "stopped", reason: "go live" });
  });

  it("watch_failure_leaves_voice_alone", async () => {
    const t = setup();
    t.core({ type: "watch_start", guild: "g1", user_id: "u1" });
    await flush();
    t.runs[0]?.fail(new Error("library exploded"));
    await flush();
    expect(t.watchMsgs().at(-1)).toMatchObject({ state: "failed", error: "library exploded" });
    expect(t.session.close).not.toHaveBeenCalled();
    expect(t.sent.some((m) => m.type === "left")).toBe(false);
    expect((t.node as unknown as { sessions: Map<string, unknown> }).sessions.has("g1")).toBe(true);
  });

  it("target_must_be_streaming_in_her_channel", async () => {
    for (const over of [{ streaming: false }, { channel: "other" }, { inGuild: false }, { ready: false }]) {
      const t = setup(over);
      t.core({ type: "watch_start", guild: "g1", user_id: "u1" });
      await flush();
      expect(t.runs, JSON.stringify(over)).toHaveLength(0);
      expect(t.watchMsgs().at(-1), JSON.stringify(over)).toMatchObject({ state: "failed" });
      expect(t.watchMsgs().at(-1)?.error).toBeTruthy();
    }
  });
});
