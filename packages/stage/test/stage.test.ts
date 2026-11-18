// End to end: `stage.link` on Core ↔ the Stage runtime, with a fake VTube Studio and a fake OBS.
// Plus the levels and overlay endpoints.

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { EventBus, ServiceRegistry, Supervisor } from "@miyoria/runtime/kernel";
import { type ContextKey, Events, newId } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  AvatarProfile,
  type BoundAddress,
  defaultLipSyncConfig,
  defaultStageStatus,
  formatAddress,
  Levels,
  OverlayHub,
  parseStageConfig,
  runStage,
  type StageConfig,
  StageLinkKey,
  StageLinkModule,
  serveLevels,
  serveOverlay,
} from "../src/index.js";
import { delay, FakeObs, FakeVts, type Json, tempDir, WAIT_MS, waitUntil } from "./common.js";

const TOKEN = "stage-secret";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

async function core() {
  const services = new ServiceRegistry();
  const bus = new EventBus();
  const sup = new Supervisor({ bus, services });
  const module = new StageLinkModule();
  // The scene director would switch scenes on its own when the stream starts; these tests drive OBS.
  await sup.register(
    module,
    { bind: "127.0.0.1:0", token: TOKEN, scenes: { director: false } },
    true,
  );
  await sup.startAll();
  cleanup.push(() => sup.stopAll());
  return { sup, services, bus, module };
}

async function fakeVts(): Promise<FakeVts> {
  const vts = await FakeVts.start();
  cleanup.push(() => vts.close());
  return vts;
}

function dir(): string {
  const d = tempDir();
  cleanup.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

function stageConfig(module: StageLinkModule, vts: FakeVts): StageConfig {
  const addr = module.localAddr() as BoundAddress;
  const avatar = new AvatarProfile();
  avatar.emotions.set("happy", { type: "expression", file: "happy.exp3.json" });
  avatar.emotions.set("smug", { type: "hotkey", name: "Wave" });
  return parseStageConfig(
    {
      core_url: `ws://${formatAddress(addr)}/stage-link`,
      token: TOKEN,
      data_dir: dir(),
      overlay_bind: "127.0.0.1:0",
      overlay_dir: join(dir(), "missing"),
      vts: {
        url: vts.url(),
        emotion_hold_ms: 300,
        after_speech_ms: 100,
        only_while_streaming: false,
      },
      obs: { subtitle_source: "Subtitle", subtitle_clear_ms: 0, poll_ms: 100 },
      lipsync: { bind: "127.0.0.1:0" },
    },
    avatar,
  );
}

function expressionRequests(vts: FakeVts): [string, boolean][] {
  return vts
    .requests()
    .filter((r: Json) => r.messageType === "ExpressionActivationRequest")
    .map((r: Json) => [r.data.expressionFile, r.data.active]);
}

const textCtx = (): ContextKey => ({
  platform: "discord",
  scope: "g",
  channel: "c",
  kind: "channel",
});

const voiceCtx = (): ContextKey => ({
  platform: "discord",
  scope: "g",
  channel: "vc",
  kind: "voice",
});

describe("stage", () => {
  it("stage_end_to_end", async () => {
    const { services, bus, module } = await core();
    const link = services.require(StageLinkKey);
    const vts = await fakeVts();
    const obs = new FakeObs("Talk");
    const config = stageConfig(module, vts);
    const controller = new AbortController();
    const stage = runStage(config, { obs, signal: controller.signal });
    let stageError: unknown = null;
    stage.catch((e: unknown) => {
      stageError = e;
    });
    cleanup.push(async () => {
      controller.abort();
      await stage.catch(() => undefined);
    });

    await waitUntil(() => {
      const s = link.status();
      return (s?.vts ?? false) && (s?.obs ?? false) && s?.scene === "Talk";
    }, "stage up");
    expect(stageError).toBeNull();
    expect(readFileSync(join(config.data_dir, "vts-token.txt"), "utf8")).toBe("tok-1");
    const caps = link.node()?.[1] ?? [];
    for (const cap of ["vts", "obs", "lipsync", "overlay"]) expect(caps).toContain(cap);

    // OBS: scenes and streaming.
    let status = await link.setScene("Game");
    expect(status.scene).toBe("Game");
    await expect(link.setScene("Missing")).rejects.toThrow("Missing");
    status = await link.stream("start");
    expect(status.streaming).toBe(true);
    const stopped = await link.stream("stop");
    expect(stopped).toMatchObject({
      vts: true,
      obs: true,
      scene: "Game",
      streaming: false,
      scenes: ["Talk", "Game"],
      hotkeys: ["Wave", "Clear"],
    });
    expect(stopped.overlay_url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/overlay\/$/);
    expect(stopped.overlay_url).not.toContain(":0/");
    expect(obs.state.calls).toStrictEqual([
      "ensure Subtitle",
      "scene Game",
      "scene Missing",
      "start",
      "stop",
    ]);

    // VTS: hotkeys, emotions with hold, batched parameter injection.
    await link.hotkey("wave");
    expect(
      vts
        .requests()
        .some(
          (r: Json) => r.messageType === "HotkeyTriggerRequest" && r.data.hotkeyID === "hk-wave",
        ),
    ).toBe(true);
    await expect(link.hotkey("Dance")).rejects.toThrow("Dance");

    bus.publish("agent", Events.AgentEmotion, {
      turn: newId(),
      context: textCtx(),
      emotion: "happy",
    });
    const t0 = Date.now();
    await waitUntil(() => {
      const e = expressionRequests(vts);
      return e.length === 1 && e[0]?.[0] === "happy.exp3.json" && e[0][1];
    }, "expression on");
    await waitUntil(() => expressionRequests(vts).length === 2, "expression off");
    expect(expressionRequests(vts)[1]).toStrictEqual(["happy.exp3.json", false]);
    expect(Date.now() - t0, "held").toBeGreaterThanOrEqual(250);

    await waitUntil(() =>
      vts.injections().some((d: Json) => {
        const ids = d.parameterValues.map((p: Json) => p.id);
        return ["MouthOpen", "MouthSmile", "FaceAngleX", "EyeRightY"].every((id) =>
          ids.includes(id),
        );
      }),
    );
    // Custom parameters are created on connect and then driven; VTS is told a face is found
    // (no tracking-lost idle animation).
    expect(vts.state.custom).toContain("MiyoriaEyeSmile");
    expect(vts.state.custom).toContain("JawOpen");
    await waitUntil(() =>
      vts
        .injections()
        .some((d: Json) => d.parameterValues.some((p: Json) => p.id === "MiyoriaBodyX")),
    );
    expect(vts.injections().every((d: Json) => d.faceFound === true && d.mode === "set")).toBe(
      true,
    );
    const first = vts.injections().length;
    await delay(500);
    const rate = vts.injections().length - first;
    expect(rate, `about 60 Hz: ${rate} in 500 ms`).toBeGreaterThanOrEqual(5);
    expect(rate).toBeLessThanOrEqual(45);

    // Subtitles reach the OBS text source.
    const turn = newId();
    bus.publish(
      "agent",
      Events.VoicePlaybackEvent,
      { context: voiceCtx(), turn, state: "started", text: "早安。" },
      { turn },
    );
    await waitUntil(() => obs.state.texts.some(([s, t]) => s === "Subtitle" && t === "早安。"));

    // What she is doing reaches the overlay, and a client that connects later gets it too.
    const overlayWs = (stopped.overlay_url ?? "").replace(/^http/, "ws");
    const seen: Json[] = [];
    const early = new WebSocket(`${overlayWs}ws`);
    cleanup.push(() => early.terminate());
    early.on("message", (data) => seen.push(JSON.parse(data.toString())));
    await new Promise<void>((r, j) => early.once("open", () => r()).once("error", j));
    bus.publish("sing", Events.SingPrepare, {
      no: 1,
      title: "夜に駆ける",
      stage: "download",
      progress: 0.25,
      exclusive: null,
    });
    const activity = {
      type: "activity",
      kind: "song_prepare",
      label: "下載中",
      detail: "夜に駆ける",
      progress: 0.25,
      elapsed_ms: null,
      duration_ms: null,
    };
    await waitUntil(() => seen.some((m) => m.type === "activity"), "activity on the overlay");
    expect(seen.find((m) => m.type === "activity")).toStrictEqual(activity);
    const late: Json[] = [];
    const lateWs = new WebSocket(`${overlayWs}ws`);
    cleanup.push(() => lateWs.terminate());
    lateWs.on("message", (data) => late.push(JSON.parse(data.toString())));
    await waitUntil(() => late.some((m) => m.type === "activity"), "activity for a new client");
    expect(late.find((m) => m.type === "activity")).toStrictEqual(activity);

    controller.abort();
    await Promise.race([
      stage,
      delay(WAIT_MS).then(() => Promise.reject(new Error("stage stops"))),
    ]);
    await waitUntil(() => !link.isConnected());
  });

  it("wrong_token_is_fatal", async () => {
    const { module } = await core();
    const vts = await fakeVts();
    const config = stageConfig(module, vts);
    config.token = "wrong";
    config.vts.enabled = false;
    config.obs.enabled = false;
    const controller = new AbortController();
    cleanup.push(() => controller.abort());
    const result = runStage(config, { obs: new FakeObs(), signal: controller.signal });
    await expect(
      Promise.race([result, delay(WAIT_MS).then(() => "still running")]),
    ).rejects.toThrow(/token/);
  });

  it("empty_token_is_rejected", async () => {
    const config = parseStageConfig({});
    await expect(
      runStage(config, { obs: new FakeObs(), signal: new AbortController().signal }),
    ).rejects.toThrow("STAGE_LINK_TOKEN");
  });

  it("reconnects_after_core_restarts", async () => {
    const { sup, services, module } = await core();
    const vts = await fakeVts();
    const config = stageConfig(module, vts);
    config.vts.enabled = false;
    const controller = new AbortController();
    const stage = runStage(config, { obs: new FakeObs("Talk"), signal: controller.signal });
    cleanup.push(async () => {
      controller.abort();
      await stage.catch(() => undefined);
    });
    await waitUntil(() => services.get(StageLinkKey)?.status()?.obs ?? false, "first session");
    // Same port again: restart the module with the bound address.
    const addr = module.localAddr() as BoundAddress;
    await sup.stopAll();
    const services2 = new ServiceRegistry();
    const sup2 = new Supervisor({ services: services2 });
    await sup2.register(new StageLinkModule(), { bind: formatAddress(addr), token: TOKEN }, true);
    await sup2.startAll();
    cleanup.push(() => sup2.stopAll());
    await waitUntil(
      () => services2.get(StageLinkKey)?.status()?.scene === "Talk",
      "second session",
    );
  }, 15_000);

  it("danmaku_answers_reach_core_and_wait_for_it_while_it_restarts", async () => {
    const { sup, bus, services, module } = await core();
    const vts = await fakeVts();
    const config = stageConfig(module, vts);
    config.vts.enabled = false;
    const controller = new AbortController();
    const stage = runStage(config, { obs: new FakeObs("Talk"), signal: controller.signal });
    cleanup.push(async () => {
      controller.abort();
      await stage.catch(() => undefined);
    });
    const link = services.require(StageLinkKey);
    await waitUntil(() => link.status()?.overlay_url != null, "stage up");
    expect(link.node()?.[1]).toContain("danmaku");
    // The overlay page: its danmaku layer is on.
    const page = new WebSocket(`${(link.status()?.overlay_url ?? "").replace(/^http/, "ws")}ws`);
    const lines: Json[] = [];
    page.on("message", (data) => {
      const m = JSON.parse(data.toString());
      if (m.type === "danmaku") lines.push(m);
    });
    await new Promise<void>((r, j) => page.once("open", () => r()).once("error", j));
    cleanup.push(() => page.terminate());
    page.send(JSON.stringify({ type: "danmaku_ready" }));
    const answers = bus.subscribe([Events.StageDanmaku.type]);
    const line = { name: "Mia", text: "好", max_on_screen: 12, queue_max: 20, max_wait_ms: 30_000 };
    await delay(50);
    bus.publish("test", Events.EconomyDanmaku, { id: "L1", ...line });
    await waitUntil(() => lines.length === 1, "line on the page");
    page.send(JSON.stringify({ type: "danmaku_shown", id: "L1" }));
    expect((await answers.recv())?.data).toEqual({ id: "L1", outcome: "shown" });

    // Core goes away while the page still shows a line: the node keeps the answer.
    bus.publish("test", Events.EconomyDanmaku, { id: "L2", ...line });
    await waitUntil(() => lines.length === 2, "second line on the page");
    const addr = module.localAddr() as BoundAddress;
    await sup.stopAll();
    page.send(JSON.stringify({ type: "danmaku_dropped", id: "L2", reason: "too_late" }));
    const bus2 = new EventBus();
    const services2 = new ServiceRegistry();
    const sup2 = new Supervisor({ bus: bus2, services: services2 });
    const later = bus2.subscribe([Events.StageDanmaku.type]);
    await sup2.register(new StageLinkModule(), { bind: formatAddress(addr), token: TOKEN }, true);
    await sup2.startAll();
    cleanup.push(() => sup2.stopAll());
    const env = await Promise.race([later.recv(), delay(10_000).then(() => null)]);
    expect(env?.data).toEqual({ id: "L2", outcome: "too_late" });
  }, 20_000);

  it("levels_endpoint_feeds_lip_sync", async () => {
    const levels = new Levels(defaultLipSyncConfig());
    const controller = new AbortController();
    const { addr, done } = await serveLevels("127.0.0.1:0", levels, controller.signal);
    const ws = new WebSocket(`ws://${formatAddress(addr)}/levels`);
    await new Promise<void>((r, j) => ws.once("open", () => r()).once("error", j));
    for (const [t, rms] of [
      [0, 0.1],
      [20, 0.3],
    ]) {
      ws.send(JSON.stringify({ t, rms }));
    }
    ws.send("not json");
    await waitUntil(() => Math.abs(levels.current(Date.now()) - 0.3) < 1e-6);
    // Without new levels the mouth closes.
    await waitUntil(() => levels.current(Date.now()) === 0);
    controller.abort();
    await Promise.race([done, delay(WAIT_MS).then(() => Promise.reject(new Error("stopped")))]);
    ws.terminate();
  });

  it("overlay_serves_the_backdrop_picture", async () => {
    const d = dir();
    writeFileSync(join(d, "index.html"), "<p>overlay</p>");
    const pictures = dir();
    const picture = join(pictures, "snow.png");
    writeFileSync(picture, "PNG");
    const controller = new AbortController();
    cleanup.push(() => controller.abort());
    const hub = new OverlayHub();
    const { addr } = await serveOverlay("127.0.0.1:0", d, hub, controller.signal, picture);
    const res = await httpGet(addr, "/overlay/backdrop");
    expect(res.startsWith("HTTP/1.1 200")).toBe(true);
    expect(res.toLowerCase()).toContain("content-type: image/png");
    expect(res.endsWith("PNG")).toBe(true);

    // No picture configured: 404, and the page draws its gradient.
    const bare = await serveOverlay("127.0.0.1:0", d, hub, controller.signal);
    expect((await httpGet(bare.addr, "/overlay/backdrop")).startsWith("HTTP/1.1 404")).toBe(true);
  });

  it("overlay_serves_files_and_events", async () => {
    const d = dir();
    writeFileSync(join(d, "index.html"), "<p>overlay</p>");
    writeFileSync(join(d, "app.js"), "console.log(1)");
    const hub = new OverlayHub();
    hub.status({ ...defaultStageStatus(), vts: true, scenes: ["Talk"] }, true);
    const controller = new AbortController();
    cleanup.push(() => controller.abort());
    const { addr } = await serveOverlay("127.0.0.1:0", d, hub, controller.signal);

    const index = await httpGet(addr, "/overlay/");
    expect(index.startsWith("HTTP/1.1 200")).toBe(true);
    expect(index).toContain("<p>overlay</p>");
    expect(index.toLowerCase()).toContain("content-type: text/html");
    expect(await httpGet(addr, "/overlay/app.js")).toContain("console.log(1)");
    const redirect = await httpGet(addr, "/overlay");
    expect(redirect.startsWith("HTTP/1.1 30")).toBe(true);
    expect(redirect.toLowerCase()).toContain("location: /overlay/");
    expect((await httpGet(addr, "/overlay/nope.js")).startsWith("HTTP/1.1 404")).toBe(true);
    expect((await httpGet(addr, "/overlay/../stage.test.ts")).startsWith("HTTP/1.1 404")).toBe(
      true,
    );
    expect((await httpGet(addr, "/overlay/%2e%2e/x")).startsWith("HTTP/1.1 404")).toBe(true);

    const ws = new WebSocket(`ws://${formatAddress(addr)}/overlay/ws`);
    const queue: Json[] = [];
    ws.on("message", (data) => queue.push(JSON.parse(data.toString())));
    const next = async (): Promise<Json> => {
      await waitUntil(() => queue.length > 0, "overlay message");
      return queue.shift();
    };
    expect(await next()).toStrictEqual({
      type: "status",
      core: true,
      vts: true,
      obs: false,
      scene: null,
      streaming: false,
    });
    // The client subscribed before its snapshot was sent.
    hub.subtitle("t1", "早安", false);
    hub.emotion("happy", 0.8);
    hub.speaking("started");
    expect(await next()).toStrictEqual({
      type: "subtitle",
      turn: "t1",
      text: "早安",
      final: false,
    });
    const emotion = await next();
    expect(emotion.type).toBe("emotion");
    expect(emotion.name).toBe("happy");
    expect(await next()).toStrictEqual({ type: "speaking", state: "started" });

    // A new client gets status, emotion and subtitle first.
    const late = new WebSocket(`ws://${formatAddress(addr)}/overlay/ws`);
    const lateQueue: Json[] = [];
    late.on("message", (data) => lateQueue.push(JSON.parse(data.toString())));
    await waitUntil(() => lateQueue.length === 3);
    expect(lateQueue.map((m) => m.type)).toStrictEqual(["status", "emotion", "subtitle"]);
    ws.terminate();
    late.terminate();
  });
});

function httpGet(addr: BoundAddress, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(addr.port, addr.host, () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
    });
    let out = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      out += chunk;
    });
    socket.on("end", () => resolve(out));
    socket.on("error", reject);
  });
}
