// The karaoke room on the stream (docs/design/karaoke.md 「做了什麼第五步」): the bus events → the
// `karaoke` / `karaoke_lyrics` stage messages (Forwarder, with the resume for a node that
// reconnects), the overlay hub's snapshot (the song moved on, the lip-sync latency taken off) and
// the round's video served from the one file Core named.

import { rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { OverlayMessageSchema } from "@miyoria/contracts/overlay";
import { EventBus, ServiceRegistry, Supervisor } from "@miyoria/runtime/kernel";
import {
  type AnyEventDefinition,
  type Envelope,
  type EventPayload,
  Events,
  eventEnvelope,
  type PublishMetaArgs,
} from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  type BoundAddress,
  byteRange,
  type CoreMessage,
  Forwarder,
  formatAddress,
  type KaraokeStageLyrics,
  type KaraokeStageScene,
  OverlayHub,
  parseCoreMessage,
  parseStageConfig,
  runStage,
  StageLinkKey,
  StageLinkModule,
  serveOverlay,
} from "../src/index.js";
import { FakeObs, type Json, tempDir, waitUntil } from "./common.js";

/** An absolute path on this platform (a Windows one is not absolute on Linux). */
const abs = (...parts: string[]) => resolve("/", ...parts);

const ev = <D extends AnyEventDefinition>(
  def: D,
  data: EventPayload<D>,
  ...meta: PublishMetaArgs<D>
): Envelope => eventEnvelope("test", def, data, ...meta);

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

function dir(): string {
  const d = tempDir();
  cleanup.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

function scene(extra: Partial<KaraokeStageScene> = {}): KaraokeStageScene {
  return {
    room: "K7PQ2M",
    state: "singing",
    round: 2,
    rounds_left: 2,
    song: { id: "yt-abc", title: "夜に駆ける", artist: "YOASOBI", duration_ms: 261_000 },
    shift: 0,
    members: [
      { name: "Mia", color: 0, role: "singer", ready: true, opener: true },
      { name: "小明", color: 1, role: "spectator", ready: false, opener: false },
    ],
    position_ms: 12_000,
    board: [
      {
        name: "Mia",
        color: 0,
        rank: 1,
        total: 81.4,
        source: "estimate",
        move: "same",
        winner: false,
        coins: 0,
        finished: false,
        on_air: true,
        parts: null,
        pitch: { from: 550, track: Buffer.from([0, 100, 101, 102]).toString("base64") },
        cheers: 2,
      },
    ],
    note: null,
    currency: "魚幣",
    air: {
      backing: true,
      relay: "Mia",
      delay_ms: 2_000,
      backing_gain: 0.8,
      voice_gain: 1,
      duck_gain: 0.35,
    },
    queue: [
      { title: "群青", artist: "YOASOBI", by: "小明", state: "ready" },
      { title: "怪物", artist: null, by: "Mia", state: "preparing" },
    ],
    join_url: "https://example.test/karaoke/room/K7PQ2M",
    qr_while_singing: false,
    settling: null,
    cheers: [
      { id: "c2-1", kind: "wow", to: { name: "Mia", color: 0 }, by: { name: "小明", color: 1 } },
    ],
    ...extra,
  };
}

function lyrics(extra: Partial<KaraokeStageLyrics> = {}): KaraokeStageLyrics {
  return {
    room: "K7PQ2M",
    round: 2,
    song: "yt-abc",
    lyrics: null,
    video: abs("karaoke", "yt-abc", "video.mp4"),
    backing: { path: abs("karaoke", "yt-abc", "play_karaoke.pcm"), format: "pcm", rate: 48_000 },
    notes: [
      { start: 11.5, end: 12.1, midi: 64 },
      { start: 12.2, end: 12.9, midi: 66.5 },
    ],
    ...extra,
  };
}

/** A tenth of a second of µ-law silence, base64. */
const VOICE = {
  room: "K7PQ2M",
  round: 2,
  at_ms: 12_000,
  audio: Buffer.alloc(1_600, 0xff).toString("base64"),
};

const END: KaraokeStageScene = {
  room: null,
  state: null,
  round: 0,
  rounds_left: 0,
  song: null,
  shift: 0,
  queue: [],
  join_url: null,
  qr_while_singing: false,
  members: [],
  position_ms: null,
  board: [],
  note: null,
  currency: "",
  air: { backing: false, relay: null, delay_ms: 0, backing_gain: 0, voice_gain: 0, duck_gain: 0 },
  settling: null,
  cheers: [],
};

describe("karaoke on the stage link", () => {
  it("forwards the scene and the words as stage messages the node parses", () => {
    const f = new Forwarder(false, { now: () => 0 });
    const out = f.onEvent(ev(Events.KaraokeStage, scene()));
    expect(out).toStrictEqual([{ type: "karaoke", ...scene() }]);
    expect(parseCoreMessage(JSON.parse(JSON.stringify(out[0])))).toStrictEqual(out[0]);
    const words = f.onEvent(ev(Events.KaraokeStageLyrics, lyrics()));
    expect(words).toStrictEqual([{ type: "karaoke_lyrics", ...lyrics() }]);
    expect(parseCoreMessage(JSON.parse(JSON.stringify(words[0])))).toStrictEqual(words[0]);
  });

  it("passes the relayed voice straight on and never keeps it", () => {
    const f = new Forwarder(false, { now: () => 0 });
    f.onEvent(ev(Events.KaraokeStage, scene()));
    const out = f.onEvent(ev(Events.KaraokeStageVoice, VOICE));
    expect(out).toStrictEqual([{ type: "karaoke_voice", ...VOICE }]);
    expect(parseCoreMessage(JSON.parse(JSON.stringify(out[0])))).toStrictEqual(out[0]);
    expect(f.resumeKaraoke().map((m) => m.type)).toStrictEqual(["karaoke"]);
  });

  it("gives a node that reconnects the scene with the song moved on, then the words", () => {
    let now = 1_000;
    const f = new Forwarder(false, { now: () => now });
    expect(f.resumeKaraoke()).toStrictEqual([]);
    f.onEvent(ev(Events.KaraokeStageLyrics, lyrics()));
    f.onEvent(ev(Events.KaraokeStage, scene({ position_ms: -3_000, state: "countdown" })));
    now += 4_250;
    const resumed = f.resumeKaraoke();
    expect(resumed).toHaveLength(2);
    expect(resumed[0]).toMatchObject({ type: "karaoke", position_ms: 1_250, state: "countdown" });
    expect(resumed[1]).toStrictEqual({ type: "karaoke_lyrics", ...lyrics() });

    // A lobby has no song clock: nothing to move on.
    f.onEvent(ev(Events.KaraokeStage, scene({ state: "lobby", position_ms: null })));
    now += 10_000;
    expect(f.resumeKaraoke()[0]).toMatchObject({ type: "karaoke", position_ms: null });
  });

  it("forgets both when the scene ends, and another room's words are not resumed", () => {
    const f = new Forwarder(false, { now: () => 0 });
    f.onEvent(ev(Events.KaraokeStage, scene()));
    f.onEvent(ev(Events.KaraokeStageLyrics, lyrics()));
    const ended = f.onEvent(ev(Events.KaraokeStage, END));
    expect(ended).toStrictEqual([{ type: "karaoke", ...END }]);
    expect(f.resumeKaraoke()).toStrictEqual([]);

    f.onEvent(ev(Events.KaraokeStageLyrics, lyrics()));
    f.onEvent(ev(Events.KaraokeStage, scene({ room: "ABCDEF" })));
    const resumed: CoreMessage[] = f.resumeKaraoke();
    expect(resumed.map((m) => m.type)).toStrictEqual(["karaoke"]);
  });
});

describe("karaoke on the overlay hub", () => {
  it("passes the scene on as it is (its sound is in the stream), a later page gets it moved on", () => {
    let now = 50_000;
    const hub = new OverlayHub(() => now);
    const sent: string[] = [];
    hub.listen((t) => sent.push(t));
    hub.karaoke(scene());
    expect(JSON.parse(sent[0] as string)).toStrictEqual({ type: "karaoke", ...scene() });
    now += 2_000;
    const later = hub.initial().map((t) => JSON.parse(t));
    expect(later).toContainEqual({ type: "karaoke", ...scene(), position_ms: 14_000 });
  });

  it("keeps the queue, the join link, the settling, the pitch and the notes for a later page", () => {
    let now = 0;
    const hub = new OverlayHub(() => now);
    const settling = scene({
      state: "singing",
      settling: { waiting: ["Mia"] },
      qr_while_singing: true,
      board: [
        {
          ...(scene().board[0] as KaraokeStageScene["board"][number]),
          parts: { pitch: 40.5, stability: 12, rhythm: null, expression: 8 },
        },
      ],
    });
    hub.karaoke(settling);
    hub.karaokeLyrics(lyrics());
    now += 1_000;
    const [shown, words] = hub.initial().map((t) => JSON.parse(t));
    expect(shown).toStrictEqual({ type: "karaoke", ...settling, position_ms: 13_000 });
    expect(words.notes).toStrictEqual(lyrics().notes);
    // The page's own parse of the feed takes them as they are.
    expect(OverlayMessageSchema.parse(shown)).toStrictEqual(shown);
  });

  it("ends the scene with a frame that has every field, and reads an older Core's without them", () => {
    const hub = new OverlayHub(() => 0);
    const sent: string[] = [];
    hub.listen((t) => sent.push(t));
    hub.karaoke(scene());
    hub.clearKaraoke();
    const ended = JSON.parse(sent.at(-1) as string);
    expect(ended).toStrictEqual({ type: "karaoke", ...END });
    expect(OverlayMessageSchema.parse(ended)).toStrictEqual(ended);

    const {
      queue: _q,
      join_url: _j,
      qr_while_singing: _w,
      settling: _s,
      ...old
    } = scene({ board: [] });
    const parsed = parseCoreMessage({ type: "karaoke", ...old });
    expect(parsed).toMatchObject({ queue: [], join_url: null, qr_while_singing: false });
    expect(parsed).toMatchObject({ settling: null });
    const { notes: _n, ...oldWords } = lyrics();
    expect(parseCoreMessage({ type: "karaoke_lyrics", ...oldWords })).toMatchObject({ notes: [] });
  });

  it("passes the voice to the pages there now, and keeps none of it", () => {
    const hub = new OverlayHub(() => 0);
    hub.karaokeVoice(VOICE);
    hub.karaoke(scene());
    expect(hub.initial().map((t) => JSON.parse(t).type)).toStrictEqual(["karaoke"]);
    const sent: string[] = [];
    hub.listen((t) => sent.push(t));
    hub.karaokeVoice(VOICE);
    expect(sent.map((t) => JSON.parse(t))).toStrictEqual([{ type: "karaoke_voice", ...VOICE }]);
    expect(hub.initial().some((t) => t.includes("karaoke_voice"))).toBe(false);
  });

  it("gives the words with the video and backing as its own URLs, and drops them when the scene ends", () => {
    const hub = new OverlayHub(() => 0);
    const sent: string[] = [];
    hub.listen((t) => sent.push(t));
    hub.karaoke(scene());
    hub.karaokeLyrics(lyrics());
    expect(JSON.parse(sent[1] as string)).toStrictEqual({
      type: "karaoke_lyrics",
      ...lyrics(),
      video: "karaoke/video?r=K7PQ2M-2",
      backing: { path: "karaoke/backing?r=K7PQ2M-2", format: "pcm", rate: 48_000 },
    });
    expect(hub.karaokeVideo("K7PQ2M-2")).toBe(abs("karaoke", "yt-abc", "video.mp4"));
    expect(hub.karaokeVideo("K7PQ2M-1")).toBeNull();
    expect(hub.karaokeBacking("K7PQ2M-2")).toStrictEqual({
      path: abs("karaoke", "yt-abc", "play_karaoke.pcm"),
      type: "application/octet-stream",
    });
    expect(hub.karaokeBacking("K7PQ2M-1")).toBeNull();

    // A backing whose file is not what it says, or relative, is never offered.
    for (const path of [
      abs("karaoke", "x", "karaoke.m4a"),
      "play_karaoke.pcm",
      abs("x", "notes.txt"),
    ]) {
      hub.karaokeLyrics(lyrics({ round: 5, backing: { path, format: "pcm", rate: 48_000 } }));
      expect(JSON.parse(sent.at(-1) as string).backing, path).toBeNull();
      expect(hub.karaokeBacking("K7PQ2M-5")).toBeNull();
    }
    hub.karaokeLyrics(
      lyrics({ round: 5, backing: { path: abs("k", "karaoke.m4a"), format: "m4a", rate: 44_100 } }),
    );
    expect(hub.karaokeBacking("K7PQ2M-5")?.type).toBe("audio/mp4");
    expect(hub.initial().map((t) => JSON.parse(t).type)).toStrictEqual([
      "karaoke",
      "karaoke_lyrics",
    ]);

    // A relative path or another kind of file is never offered.
    hub.karaokeLyrics(lyrics({ round: 3, video: "video.mp4" }));
    expect(JSON.parse(sent.at(-1) as string).video).toBeNull();
    expect(hub.karaokeVideo("K7PQ2M-3")).toBeNull();
    hub.karaokeLyrics(lyrics({ round: 3, video: abs("karaoke", "x", "reference.json") }));
    expect(JSON.parse(sent.at(-1) as string).video).toBeNull();

    hub.karaokeLyrics(lyrics());
    hub.clearKaraoke();
    expect(JSON.parse(sent.at(-1) as string)).toMatchObject({ type: "karaoke", room: null });
    expect(hub.karaokeVideo("K7PQ2M-2")).toBeNull();
    expect(hub.initial()).toStrictEqual([]);
    // Nothing shows: clearing again sends nothing.
    const count = sent.length;
    hub.clearKaraoke();
    expect(sent).toHaveLength(count);
  });

  it("reads the byte ranges a video element asks for", () => {
    expect(byteRange(undefined, 100)).toBeNull();
    expect(byteRange("bytes=0-", 100)).toStrictEqual({ start: 0, end: 99 });
    expect(byteRange("bytes=10-19", 100)).toStrictEqual({ start: 10, end: 19 });
    expect(byteRange("bytes=90-500", 100)).toStrictEqual({ start: 90, end: 99 });
    expect(byteRange("bytes=-30", 100)).toStrictEqual({ start: 70, end: 99 });
    expect(byteRange("bytes=-300", 100)).toStrictEqual({ start: 0, end: 99 });
    expect(byteRange("bytes=100-", 100)).toBe("unsatisfiable");
    expect(byteRange("bytes=-0", 100)).toBe("unsatisfiable");
    expect(byteRange("bytes=0-1,5-6", 100)).toBeNull();
    expect(byteRange("items=0-1", 100)).toBeNull();
    expect(byteRange("bytes=5-2", 100)).toBeNull();
  });

  it("serves the round's video with ranges while it is shown, and nothing else", async () => {
    const d = dir();
    writeFileSync(join(d, "index.html"), "<p>overlay</p>");
    const songs = dir();
    const video = join(songs, "video.mp4");
    writeFileSync(video, "0123456789abcdef");
    const other = join(songs, "secret.txt");
    writeFileSync(other, "nope");
    const controller = new AbortController();
    cleanup.push(() => controller.abort());
    const hub = new OverlayHub(() => 0);
    const { addr } = await serveOverlay("127.0.0.1:0", d, hub, controller.signal);
    const url = (path: string) => `http://${formatAddress(addr)}/overlay/${path}`;
    const get = (path: string, range?: string) =>
      fetch(url(path), range === undefined ? {} : { headers: { range } });

    // Nothing shown yet.
    expect((await get("karaoke/video?r=K7PQ2M-2")).status).toBe(404);

    hub.karaoke(scene());
    hub.karaokeLyrics(lyrics({ video }));
    const part = await get("karaoke/video?r=K7PQ2M-2", "bytes=4-7");
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 4-7/16");
    expect(part.headers.get("accept-ranges")).toBe("bytes");
    expect(part.headers.get("cache-control")).toBe("no-store");
    expect(part.headers.get("content-type")).toBe("video/mp4");
    expect(await part.text()).toBe("4567");

    const whole = await get("karaoke/video?r=K7PQ2M-2");
    expect(whole.status).toBe(200);
    expect(whole.headers.get("content-length")).toBe("16");
    expect(await whole.text()).toBe("0123456789abcdef");

    const past = await get("karaoke/video?r=K7PQ2M-2", "bytes=99-");
    expect(past.status).toBe(416);
    expect(past.headers.get("content-range")).toBe("bytes */16");

    // Another key, no key, a path that tries to name a file: 404.
    expect((await get("karaoke/video?r=K7PQ2M-1")).status).toBe(404);
    expect((await get("karaoke/video")).status).toBe(404);
    expect((await get(`karaoke/video?r=${encodeURIComponent(other)}`)).status).toBe(404);

    // A file that is not a video, or is gone: 404.
    hub.karaokeLyrics(lyrics({ round: 3, video: other }));
    expect((await get("karaoke/video?r=K7PQ2M-3")).status).toBe(404);
    hub.karaokeLyrics(lyrics({ round: 4, video: join(songs, "gone.mp4") }));
    expect((await get("karaoke/video?r=K7PQ2M-4")).status).toBe(404);

    // Once the scene ends the file is no longer served.
    hub.karaokeLyrics(lyrics({ video }));
    expect((await get("karaoke/video?r=K7PQ2M-2")).status).toBe(200);
    hub.karaoke(END);
    expect((await get("karaoke/video?r=K7PQ2M-2")).status).toBe(404);
  });

  it("serves the round's backing the same way", async () => {
    const d = dir();
    const songs = dir();
    const pcm = join(songs, "play_karaoke.pcm");
    writeFileSync(pcm, Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]));
    const controller = new AbortController();
    cleanup.push(() => controller.abort());
    const hub = new OverlayHub(() => 0);
    const { addr } = await serveOverlay("127.0.0.1:0", d, hub, controller.signal);
    const get = (path: string, range?: string) =>
      fetch(
        `http://${formatAddress(addr)}/overlay/${path}`,
        range === undefined ? {} : { headers: { range } },
      );
    expect((await get("karaoke/backing?r=K7PQ2M-2")).status).toBe(404);
    hub.karaoke(scene());
    hub.karaokeLyrics(lyrics({ backing: { path: pcm, format: "pcm", rate: 16_000 } }));
    const whole = await get("karaoke/backing?r=K7PQ2M-2");
    expect(whole.status).toBe(200);
    expect(whole.headers.get("cache-control")).toBe("no-store");
    expect([...new Uint8Array(await whole.arrayBuffer())]).toStrictEqual([1, 0, 2, 0, 3, 0, 4, 0]);
    const part = await get("karaoke/backing?r=K7PQ2M-2", "bytes=2-3");
    expect(part.status).toBe(206);
    expect([...new Uint8Array(await part.arrayBuffer())]).toStrictEqual([2, 0]);
    expect((await get("karaoke/backing?r=K7PQ2M-1")).status).toBe(404);
    hub.karaoke(END);
    expect((await get("karaoke/backing?r=K7PQ2M-2")).status).toBe(404);
  });
});

describe("karaoke from Core to the overlay page", () => {
  it("reaches a node that connects mid-round, and ends when Core goes away", async () => {
    const TOKEN = "stage-secret";
    const bus = new EventBus();
    const services = new ServiceRegistry();
    const sup = new Supervisor({ bus, services });
    const module = new StageLinkModule();
    await sup.register(
      module,
      { bind: "127.0.0.1:0", token: TOKEN, scenes: { director: false } },
      true,
    );
    await sup.startAll();
    let coreUp = true;
    cleanup.push(async () => {
      if (coreUp) await sup.stopAll();
    });

    // The round is on before the stage node is there.
    bus.publish("karaoke", Events.KaraokeStageLyrics, lyrics());
    bus.publish("karaoke", Events.KaraokeStage, scene({ position_ms: 5_000 }));
    const published = Date.now();

    const addr = module.localAddr() as BoundAddress;
    const config = parseStageConfig({
      core_url: `ws://${formatAddress(addr)}/stage-link`,
      token: TOKEN,
      data_dir: dir(),
      overlay_bind: "127.0.0.1:0",
      overlay_dir: join(dir(), "missing"),
      vts: { enabled: false },
      lipsync: { bind: "127.0.0.1:0", latency_ms: 200 },
    });
    const controller = new AbortController();
    const stage = runStage(config, { obs: new FakeObs("Talk"), signal: controller.signal });
    cleanup.push(async () => {
      controller.abort();
      await stage.catch(() => undefined);
    });
    const link = services.require(StageLinkKey);
    await waitUntil(() => link.status()?.overlay_url != null, "stage up");

    const page = new WebSocket(`${(link.status()?.overlay_url ?? "").replace(/^http/, "ws")}ws`);
    cleanup.push(() => page.terminate());
    const seen: Json[] = [];
    page.on("message", (data) => seen.push(JSON.parse(data.toString())));
    await waitUntil(() => seen.some((m) => m.type === "karaoke_lyrics"), "the round's words");
    const shown = seen.find((m) => m.type === "karaoke");
    expect(shown).toMatchObject({ type: "karaoke", room: "K7PQ2M", state: "singing" });
    // Moved on by the time since it was published; the lip-sync latency is not taken off.
    const moved = (shown.position_ms as number) - 5_000;
    expect(moved).toBeGreaterThanOrEqual(0);
    expect(moved).toBeLessThanOrEqual(Date.now() - published + 50);
    expect(seen.find((m) => m.type === "karaoke_lyrics")).toMatchObject({
      room: "K7PQ2M",
      round: 2,
      video: "karaoke/video?r=K7PQ2M-2",
      backing: { path: "karaoke/backing?r=K7PQ2M-2", format: "pcm" },
    });

    // The relayed voice goes through as it comes.
    bus.publish("karaoke", Events.KaraokeStageVoice, VOICE);
    await waitUntil(() => seen.some((m) => m.type === "karaoke_voice"), "the voice");
    expect(seen.find((m) => m.type === "karaoke_voice")).toStrictEqual({
      type: "karaoke_voice",
      ...VOICE,
    });

    // Core goes away: nobody drives the room on the stream any more.
    await sup.stopAll();
    coreUp = false;
    await waitUntil(
      () => seen.some((m) => m.type === "karaoke" && m.room === null),
      "the scene ends",
    );
  }, 15_000);
});
