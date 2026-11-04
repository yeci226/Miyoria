// Voice Link protocol tests against a real server (port of `tests/link.rs`).

import type { AudioChunk, AudioStream } from "@miyoria/speech";
import {
  type Event,
  type EventData,
  type EventType,
  isEvent,
  VoicePlayerKey,
} from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { type AudioEvent, GOLIVE_TOPIC, type GoLiveRequest, WATCH_TOPIC } from "../src/index.js";
import type { BoundedQueue } from "../src/util.js";
import { Harness, nextEvent, SELF_ID, sleepMs, TOKEN, waitUntil } from "./harness.js";

let harness: Harness | null = null;

async function start(config = {}): Promise<Harness> {
  harness = await Harness.start(config);
  return harness;
}

afterEach(async () => {
  await harness?.stop();
  harness = null;
});

function chunk(rate: number, samples: number[] | Int16Array): AudioChunk {
  return { sampleRate: rate, samples: Int16Array.from(samples) };
}

async function* streamOf(chunks: AudioChunk[], thenPending = false): AudioStream {
  for (const c of chunks) yield c;
  if (thenPending) await new Promise(() => undefined);
}

async function recvAudio(q: BoundedQueue<AudioEvent>): Promise<AudioEvent> {
  const ev = await Promise.race([q.recv(), sleepMs(5_000).then(() => "timeout" as const)]);
  if (ev === "timeout" || ev === null) throw new Error("audio event in time");
  return ev;
}

function data<T extends EventType>(event: Event, type: T): EventData<T> {
  if (!isEvent(event, type)) throw new Error(`expected ${type}, got ${event.type}`);
  return event.data as unknown as EventData<T>;
}

async function rejection(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected a rejection");
}

describe("voice.link", () => {
  it("empty_token_fails_to_start", async () => {
    const h = await start({ token: "  " });
    let state = h.moduleState("voice.link");
    for (let i = 0; i < 200 && state.state !== "failed"; i++) {
      await sleepMs(10);
      state = h.moduleState("voice.link");
    }
    expect(state.state).toBe("failed");
    expect(state.reason).toContain("VOICE_LINK_TOKEN");
  });

  it("hello_is_authenticated", async () => {
    const h = await start({ hello_timeout_ms: 300 });

    const wrong = await h.connect();
    wrong.hello("nope", SELF_ID);
    expect(await wrong.expectClose()).toBe(4401);

    const old = await h.connect();
    old.sendJson({
      type: "hello",
      version: 2,
      token: TOKEN,
      self_account: { platform: "discord", id: SELF_ID },
    });
    expect(await old.expectClose()).toBe(4400);

    const garbage = await h.connect();
    garbage.sendJson({ type: "joined", guild: "g" });
    expect(await garbage.expectClose()).toBe(4400);

    const silent = await h.connect();
    expect(await silent.expectClose()).toBe(4400); // no hello in time

    expect(h.link().isConnected()).toBe(false);

    const ready = h.subscribe(["platform.ready"]);
    await h.node(SELF_ID);
    const link = h.link();
    expect(link.isConnected()).toBe(true);
    const account = link.selfAccount();
    expect(account).toEqual({ platform: "discord", id: SELF_ID });
    const ev = data((await nextEvent(ready)).event, "platform_ready");
    expect(ev.platform).toBe("discord");
    expect(ev.self_account).toEqual(account);
  });

  it("join_voice_state_and_leave", async () => {
    const h = await start({ join_timeout_ms: 300 });
    // The bot account announces itself; it must count as her.
    const bot = { platform: "discord", id: "99" };
    const ready = h.subscribe(["platform.ready"]);
    h.bus.publish("platform.discord.bot", {
      type: "platform_ready",
      data: { platform: "discord", self_account: bot },
    });
    await nextEvent(ready);
    const link = h.link();
    await waitUntil(() => link.isSelf(bot));

    const node = await h.node(SELF_ID);
    const events = h.subscribe(["voice.*"]);

    const joining = link.join("g1", null, "u1");
    expect(await node.recvJson()).toEqual({ type: "join", guild: "g1", user_id: "u1" });
    node.sendJson({
      type: "voice_state",
      guild: "g1",
      channel: "vc1",
      participants: [
        { user_id: "u1", display_name: "小明", is_self: false, muted: false, deafened: false },
        {
          user_id: SELF_ID,
          display_name: "DeepSeek-chan",
          is_self: true,
          muted: false,
          deafened: false,
        },
        { user_id: "99", display_name: "bot", is_self: false, muted: true, deafened: false },
      ],
    });
    node.sendJson({ type: "joined", guild: "g1", channel: "vc1" });
    expect(await joining).toBe("vc1");

    const vp = data((await nextEvent(events)).event, "voice_participants");
    expect(vp.context).toEqual({ platform: "discord", scope: "g1", channel: "vc1", kind: "voice" });
    expect(vp.participants.map((p) => p.is_self)).toEqual([false, true, true]);
    expect(vp.participants[2]?.muted).toBe(true);
    const vj = data((await nextEvent(events)).event, "voice_joined");
    expect(vj.context.channel).toBe("vc1");
    expect(vj.participants.length).toBe(3);
    expect(link.channel("g1")).toBe("vc1");
    expect(link.participants("g1")[0]?.display_name).toBe("小明");

    node.sendJson({ type: "speaking", guild: "g1", user_id: "u1", speaking: true });
    const vs = data((await nextEvent(events)).event, "voice_speaking");
    expect(vs.context.channel).toBe("vc1");
    expect(vs.account.id).toBe("u1");
    expect(vs.speaking).toBe(true);

    // A failing join resolves with the node's error.
    const failing = rejection(link.join("g2", "vc9", null));
    expect(await node.recvJson()).toEqual({ type: "join", guild: "g2", channel: "vc9" });
    node.sendJson({ type: "error", message: "no permission to connect" });
    expect(await failing).toContain("no permission");

    // No answer at all: times out.
    expect(await rejection(link.join("g3", "vc3", null))).toContain("in time");
    await node.recvType("join");

    await link.leave("g1");
    expect(await node.recvJson()).toEqual({ type: "leave", guild: "g1" });
    node.sendJson({ type: "left", guild: "g1", reason: "leave" });
    const vl = data((await nextEvent(events)).event, "voice_left");
    expect(vl.context.channel).toBe("vc1");
    expect(vl.reason).toBe("leave");
    expect(link.channel("g1")).toBeNull();
    expect(link.participants("g1")).toEqual([]);
  });

  it("captured_audio_becomes_audio_events", async () => {
    const h = await start();
    const node = await h.node(SELF_ID);
    const audio = h.link().subscribeAudio();

    node.sendJson({
      type: "stream_open",
      stream: 5,
      guild: "g1",
      channel: "vc1",
      user_id: "u1",
      display_name: "小明",
      sample_rate: 16000,
    });
    // Frames of unknown streams are ignored.
    node.sendAudio(77, new Int16Array(320).fill(9));
    const samples = Int16Array.from({ length: 640 }, (_, i) => i);
    node.sendAudio(5, samples);
    node.sendJson({ type: "stream_close", stream: 5 });

    const open = await recvAudio(audio);
    if (open.type !== "stream_open") throw new Error("expected stream_open");
    const info = open.info;
    expect(info.speaker.id).toBe("u1");
    expect(info.displayName).toBe("小明");
    expect(info.sampleRate).toBe(16_000);
    expect(info.context.scope).toBe("g1");
    expect(info.context.channel).toBe("vc1");
    const got: number[] = [];
    for (;;) {
      const ev = await recvAudio(audio);
      if (ev.type === "frame") {
        expect(ev.stream).toBe(info.stream);
        got.push(...ev.samples);
      } else if (ev.type === "stream_close") {
        expect(ev.stream).toBe(info.stream);
        break;
      } else {
        throw new Error(`unexpected ${ev.type}`);
      }
    }
    expect(got).toEqual([...samples]);
  });

  it("play_streams_audio_until_finished", async () => {
    const h = await start();
    const node = await h.node(SELF_ID);
    const link = h.link();

    const audio = streamOf([
      chunk(24_000, new Int16Array(4000).fill(1)),
      chunk(24_000, new Int16Array(3000).fill(2)),
    ]);
    const playback = await link.play("g1", 24_000, audio);
    const start_ = await node.recvJson();
    expect(start_.type).toBe("play_start");
    expect(start_.guild).toBe("g1");
    expect(start_.sample_rate).toBe(24_000);
    const id = start_.play as number;
    expect(id).toBe(playback.id);

    let samples = 0;
    for (;;) {
      const msg = await node.recv();
      if (msg.kind === "binary") {
        expect(msg.data[0]).toBe(0x02);
        expect(msg.data.readUInt32LE(1)).toBe(id);
        samples += (msg.data.length - 5) / 2;
      } else if (msg.kind === "text") {
        expect(JSON.parse(msg.text)).toEqual({ type: "play_end", play: id });
        break;
      } else {
        throw new Error("unexpected close");
      }
    }
    expect(samples).toBe(7000);
    expect(playback.state()).toBeNull();

    node.sendJson({ type: "playback", play: id, state: "started" });
    await waitUntil(() => playback.state() === "started");
    node.sendJson({ type: "playback", play: id, state: "finished" });
    expect(await playback.wait()).toBe("finished");
  });

  it("play_with_levels_sends_each_levels_frame_before_its_audio", async () => {
    const h = await start();
    const node = await h.node(SELF_ID);
    const player = h.sup.services.require(VoicePlayerKey);

    const audio = (async function* () {
      yield { samples: new Int16Array(4800).fill(7), levels: new Int16Array(4800).fill(3) };
    })();
    const playback = await player.play("g1", 48_000, audio, { levels: true });
    const start_ = await node.recvJson();
    expect(start_).toMatchObject({ type: "play_start", sample_rate: 48_000, levels: true });
    const tags: number[] = [];
    for (;;) {
      const msg = await node.recv();
      if (msg.kind !== "binary") break;
      tags.push(msg.data[0] as number);
      expect(msg.data.readInt16LE(5)).toBe(msg.data[0] === 0x03 ? 3 : 7);
    }
    expect(tags).toEqual([0x03, 0x02]);
    playback.stop(0);
  });

  it("play_stop_interrupts", async () => {
    const h = await start();
    const node = await h.node(SELF_ID);
    const link = h.link();

    // One chunk, then the TTS "keeps generating" forever.
    const audio = streamOf([chunk(16_000, new Int16Array(1600).fill(3))], true);
    const playback = await link.play("g1", 16_000, audio);
    expect((await node.recvJson()).type).toBe("play_start");
    expect((await node.recv()).kind).toBe("binary");
    playback.stop(80);
    expect(await node.recvType("play_stop")).toEqual({
      type: "play_stop",
      play: playback.id,
      fade_ms: 80,
    });
    expect(await playback.wait()).toBe("interrupted");

    // A stream error fails the playback.
    const broken: AudioStream = {
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(new Error("worker crashed")),
      }),
    };
    const failed = await link.play("g1", 16_000, broken);
    expect(await failed.wait()).toBe("failed");
  });

  it("new_connection_replaces_old", async () => {
    const h = await start();
    const first = await h.node(SELF_ID);
    const events = h.subscribe(["voice.left"]);
    first.sendJson({ type: "joined", guild: "g1", channel: "vc1" });
    const link = h.link();
    await waitUntil(() => link.channel("g1") !== null);

    const audio = link.subscribeAudio();
    first.sendJson({
      type: "stream_open",
      stream: 1,
      guild: "g1",
      channel: "vc1",
      user_id: "u1",
      display_name: "",
      sample_rate: 16000,
    });
    expect((await recvAudio(audio)).type).toBe("stream_open");

    const second = await h.connect();
    second.hello(TOKEN, SELF_ID);
    expect((await second.recvJson()).type).toBe("welcome");
    expect(await first.expectClose()).toBe(4409);
    // The old connection's streams are closed.
    expect((await recvAudio(audio)).type).toBe("stream_close");

    // The new connection is the one in use.
    expect(link.isConnected()).toBe(true);
    await link.leave("g1");
    expect((await second.recvJson()).type).toBe("leave");
    // Replacement is not reported as leaving voice.
    await sleepMs(200);
    expect(events.tryRecv()).toBeNull();
  });

  it("dead_peer_is_disconnected", async () => {
    const h = await start({ ping_interval_ms: 50, peer_timeout_ms: 400 });
    const link = h.link();

    // A node that answers pings stays connected well past the timeout.
    const alive = await h.node("1");
    const events = h.subscribe(["voice.left"]);
    alive.sendJson({ type: "joined", guild: "g1", channel: "vc1" });
    const until = Date.now() + 1000;
    while (Date.now() < until) await alive.tryRecv(50);
    expect(link.isSelf({ platform: "discord", id: "1" })).toBe(true);
    expect(link.isConnected()).toBe(true);

    // Stop answering: Core gives up after the peer timeout.
    alive.autoPong = false;
    expect(await alive.recvJson()).toEqual({ type: "ping" });
    expect(await alive.expectClose()).toBe(4408);
    await waitUntil(() => !link.isConnected());
    const vl = data((await nextEvent(events)).event, "voice_left");
    expect(vl.context.channel).toBe("vc1");
    expect(vl.reason).toBe("voice node disconnected");
  });

  it("ping_from_node_gets_pong", async () => {
    const h = await start();
    const node = await h.node(SELF_ID);
    node.sendJson({ type: "ping" });
    expect(await node.recvJson()).toEqual({ type: "pong" });
  });

  it("golive_start_stop_and_state_events", async () => {
    const h = await start();
    const node = await h.node(SELF_ID);
    const link = h.link();
    const events = h.subscribe([GOLIVE_TOPIC]);

    // Bad requests never reach the node.
    const bad: GoLiveRequest[] = [
      { guild: "g1", source: "  " },
      { guild: "g1", source: "srt://127.0.0.1:9999", encoder: "quicksync" },
      { guild: "g1", source: "srt://127.0.0.1:9999", fps: 0 },
    ];
    for (const req of bad) await rejection(link.goliveStart(req));

    await link.goliveStart({
      guild: "g1",
      channel: "vc1",
      source: "srt://127.0.0.1:9999",
      height: 1080,
      fps: 60,
      bitrateKbps: 6000,
      encoder: "nvenc",
    });
    const sent = await node.recv();
    expect(sent.kind === "text" && sent.text).toBe(
      '{"type":"golive_start","guild":"g1","channel":"vc1","source":"srt://127.0.0.1:9999","height":1080,"fps":60,"bitrate_kbps":6000,"encoder":"nvenc"}',
    );
    expect(link.golive("g1")).toBeNull();

    node.sendJson({ type: "golive", guild: "g1", state: "starting" });
    const ev = data((await nextEvent(events)).event, "custom");
    expect(ev.topic).toBe(GOLIVE_TOPIC);
    expect(ev.payload).toEqual({
      platform: "discord",
      guild: "g1",
      state: "starting",
      error: null,
      reason: null,
    });
    expect(link.isStreaming("g1")).toBe(true);

    node.sendJson({ type: "golive", guild: "g1", state: "live" });
    await nextEvent(events);
    expect(link.golive("g1")?.state).toBe("live");

    await link.goliveStop("g1");
    expect(await node.recvJson()).toEqual({ type: "golive_stop", guild: "g1" });
    node.sendJson({ type: "golive", guild: "g1", state: "stopped", reason: "stop requested" });
    const stopped = data((await nextEvent(events)).event, "custom").payload as Record<
      string,
      unknown
    >;
    expect(stopped.state).toBe("stopped");
    expect(stopped.reason).toBe("stop requested");
    expect(link.golive("g1")).toEqual({ state: "stopped", error: null, reason: "stop requested" });
    expect(link.isStreaming("g1")).toBe(false);

    node.sendJson({ type: "golive", guild: "g1", state: "failed", error: "ffmpeg not found" });
    const failed = data((await nextEvent(events)).event, "custom").payload as Record<
      string,
      unknown
    >;
    expect(failed.state).toBe("failed");
    expect(failed.error).toBe("ffmpeg not found");
    expect(link.golive("g1")?.error).toBe("ffmpeg not found");
  });

  it("golive_without_a_node_fails_and_disconnect_stops_it", async () => {
    const h = await start();
    const link = h.link();
    const req: GoLiveRequest = { guild: "g1", source: "rtmp://127.0.0.1/live/x" };
    expect(await rejection(link.goliveStart(req))).toContain("no voice node");
    await rejection(link.goliveStop("g1"));

    const node = await h.node(SELF_ID);
    const events = h.subscribe([GOLIVE_TOPIC]);
    node.sendJson({ type: "golive", guild: "g1", state: "live" });
    await nextEvent(events);
    expect(link.isStreaming("g1")).toBe(true);
    node.drop();
    const payload = data((await nextEvent(events)).event, "custom").payload as Record<
      string,
      unknown
    >;
    expect(payload.state).toBe("stopped");
    expect(payload.reason).toBe("voice node disconnected");
    await waitUntil(() => !link.isConnected());
    expect(link.golive("g1")).toBeNull();
  });

  // ── watching a stream ──────────────────────────────────────────────────────

  function snapshotFrame(id: number, jpeg: Buffer): Buffer {
    const head = Buffer.alloc(5);
    head[0] = 0x04;
    head.writeUInt32LE(id, 1);
    return Buffer.concat([head, jpeg]);
  }

  async function requestedSnapshot(node: Awaited<ReturnType<Harness["node"]>>): Promise<number> {
    const msg = await node.recvType("watch_snapshot");
    return msg.id as number;
  }

  it("watch_start_and_status", async () => {
    const h = await start();
    const node = await h.node(SELF_ID);
    const link = h.link();
    const events = h.subscribe([WATCH_TOPIC]);

    expect(link.watchStatus("g1")).toBeNull();
    await link.watchStart("g1", "u1");
    expect(await node.recvJson()).toEqual({ type: "watch_start", guild: "g1", user_id: "u1" });
    node.sendJson({ type: "watch", guild: "g1", user_id: "u1", state: "live" });
    const ev = data((await nextEvent(events)).event, "custom");
    expect(ev.topic).toBe(WATCH_TOPIC);
    expect(ev.payload).toEqual({
      platform: "discord",
      guild: "g1",
      user_id: "u1",
      state: "live",
      error: null,
      reason: null,
    });
    expect(link.watchStatus("g1")).toEqual({
      user_id: "u1",
      state: "live",
      error: null,
      reason: null,
    });

    await link.watchStop("g1");
    expect(await node.recvJson()).toEqual({ type: "watch_stop", guild: "g1" });
  });

  it("watch_without_a_node_fails", async () => {
    const h = await start();
    const link = h.link();
    expect(await rejection(link.watchStart("g1", "u1"))).toContain("no voice node");
    await rejection(link.watchStop("g1"));
    await rejection(link.snapshot("g1", 1000, new AbortController().signal));
  });

  it("stale_stop_does_not_clear_the_new_watch", async () => {
    const h = await start();
    const node = await h.node(SELF_ID);
    const link = h.link();
    const events = h.subscribe([WATCH_TOPIC]);

    node.sendJson({ type: "watch", guild: "g1", user_id: "u2", state: "live" });
    await nextEvent(events);
    node.sendJson({ type: "watch", guild: "g1", user_id: "u1", state: "stopped", reason: "old" });
    const stale = data((await nextEvent(events)).event, "custom").payload as Record<
      string,
      unknown
    >;
    expect(stale.user_id).toBe("u1");
    expect(link.watchStatus("g1")?.user_id).toBe("u2");
    expect(link.watchStatus("g1")?.state).toBe("live");

    node.sendJson({ type: "watch", guild: "g1", user_id: "u2", state: "failed", error: "boom" });
    await nextEvent(events);
    expect(link.watchStatus("g1")).toEqual({
      user_id: "u2",
      state: "failed",
      error: "boom",
      reason: null,
    });
  });

  it("snapshot_resolves_with_jpeg", async () => {
    const h = await start();
    const node = await h.node(SELF_ID);
    const link = h.link();
    const jpeg = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
    const pending = link.snapshot("g1", 5000, new AbortController().signal);
    const id = await requestedSnapshot(node);
    node.ws.send(snapshotFrame(id, jpeg), { binary: true });
    expect((await pending).equals(jpeg)).toBe(true);
  });

  it("snapshot_rejects_on_failed_message", async () => {
    const h = await start();
    const node = await h.node(SELF_ID);
    const link = h.link();
    const pending = rejection(link.snapshot("g1", 5000, new AbortController().signal));
    const id = await requestedSnapshot(node);
    node.sendJson({ type: "watch_snapshot_failed", id, error: "no frame yet" });
    expect(await pending).toContain("no frame yet");
  });

  it("snapshot_times_out", async () => {
    const h = await start();
    const node = await h.node(SELF_ID);
    const link = h.link();
    const first = rejection(link.snapshot("g1", 50, new AbortController().signal));
    const oldId = await requestedSnapshot(node);
    expect(await first).toContain("in time");

    // A late frame is dropped and is not paired with the next request.
    const second = link.snapshot("g1", 5000, new AbortController().signal);
    const newId = await requestedSnapshot(node);
    expect(newId).not.toBe(oldId);
    node.ws.send(snapshotFrame(oldId, Buffer.from([9, 9])), { binary: true });
    const jpeg = Buffer.from([1, 2, 3]);
    node.ws.send(snapshotFrame(newId, jpeg), { binary: true });
    expect((await second).equals(jpeg)).toBe(true);
  });

  it("snapshot_rejects_when_aborted_and_drops_the_late_frame", async () => {
    const h = await start();
    const node = await h.node(SELF_ID);
    const link = h.link();
    const abort = new AbortController();
    const pending = rejection(link.snapshot("g1", 5000, abort.signal));
    const id = await requestedSnapshot(node);
    abort.abort();
    expect(await pending).toContain("abort");
    node.ws.send(snapshotFrame(id, Buffer.from([1])), { binary: true });
    const next = link.snapshot("g1", 5000, new AbortController().signal);
    const nextId = await requestedSnapshot(node);
    node.ws.send(snapshotFrame(nextId, Buffer.from([2])), { binary: true });
    expect([...(await next)]).toEqual([2]);
  });

  it("snapshot_rejects_at_once_when_node_disconnects", async () => {
    const h = await start();
    const node = await h.node(SELF_ID);
    const link = h.link();
    const events = h.subscribe([WATCH_TOPIC]);
    node.sendJson({ type: "watch", guild: "g1", user_id: "u1", state: "live" });
    await nextEvent(events);

    const started = Date.now();
    const pending = rejection(link.snapshot("g1", 5000, new AbortController().signal));
    await requestedSnapshot(node);
    node.drop();
    expect(await pending).toContain("disconnected");
    expect(Date.now() - started).toBeLessThan(3000);
    const payload = data((await nextEvent(events)).event, "custom").payload as Record<
      string,
      unknown
    >;
    expect(payload.state).toBe("stopped");
    expect(payload.user_id).toBe("u1");
    expect(payload.reason).toBe("voice node disconnected");
  });

  it("watch_audio_is_not_capture_audio", async () => {
    const h = await start();
    const node = await h.node(SELF_ID);
    const link = h.link();
    const capture = link.subscribeAudio();
    const watched = link.subscribeWatchAudio();

    const frame = Buffer.alloc(1 + 4);
    frame[0] = 0x05;
    frame.writeInt16LE(7, 1);
    frame.writeInt16LE(-3, 3);
    node.ws.send(frame, { binary: true });
    const got = await Promise.race([watched.recv(), sleepMs(5_000).then(() => null)]);
    expect([...(got ?? [])]).toEqual([7, -3]);
    await sleepMs(50);
    expect(capture.length).toBe(0);
  });

  it("old_snapshot_id_is_ignored_after_switch", async () => {
    const h = await start();
    const node = await h.node(SELF_ID);
    const link = h.link();
    const abort = new AbortController();
    const old = rejection(link.snapshot("g1", 5000, abort.signal));
    const oldId = await requestedSnapshot(node);
    abort.abort();
    await old;

    const fresh = link.snapshot("g1", 5000, new AbortController().signal);
    const freshId = await requestedSnapshot(node);
    expect(freshId).not.toBe(oldId);
    node.sendJson({ type: "watch_snapshot_failed", id: oldId, error: "old" });
    node.ws.send(snapshotFrame(oldId, Buffer.from([0])), { binary: true });
    const jpeg = Buffer.from([5, 6]);
    node.ws.send(snapshotFrame(freshId, jpeg), { binary: true });
    expect((await fresh).equals(jpeg)).toBe(true);
  });

  // ── TS-specific ─────────────────────────────────────────────────────────────

  it("module_stop_closes_nodes_with_going_away", async () => {
    const h = await start();
    const node = await h.node(SELF_ID);
    const closed = node.expectClose();
    await h.stop();
    harness = null;
    expect(await closed).toBe(1001);
  });

  it("disconnect_fails_pending_join_and_playback", async () => {
    const h = await start();
    const node = await h.node(SELF_ID);
    const link = h.link();
    const joining = rejection(link.join("g1", "vc1", null));
    const playback = await link.play("g1", 16_000, streamOf([], true));
    await node.recvType("play_start");
    node.drop();
    expect(await joining).toContain("disconnected");
    expect(await playback.wait()).toBe("failed");
  });

  it("unknown_paths_are_rejected", async () => {
    const h = await start();
    const url = h.url().replace("/voice-link", "/other");
    await expect(
      new Promise((resolve, reject) => {
        import("ws").then(({ default: WS }) => {
          const ws = new WS(url);
          ws.once("open", resolve);
          ws.once("error", reject);
        }, reject);
      }),
    ).rejects.toThrow(/404/);
  });
});
