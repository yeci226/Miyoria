// Stage Link protocol tests: `stage.link` on a real socket and a scripted Stage node.

import { ActuatorRegistry, ActuatorRegistryKey, defineCapability } from "@miyoria/actions";
import {
  CommandRegistry,
  CommandRegistryKey,
  commandName,
  Invocation,
  Permissions,
} from "@miyoria/commands";
import { EventBus, ServiceRegistry, type Subscription, Supervisor } from "@miyoria/kernel";
import {
  type ContextKey,
  customEvent,
  type Envelope,
  type Event,
  type JsonObject,
  newId,
  Principals,
  SONG_PREPARE_TOPIC,
  SONG_TOPIC,
} from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { z } from "zod";
import {
  EMOTION_TOPIC,
  formatAddress,
  STATUS_TOPIC,
  STREAM_COMMAND_PATHS,
  type StageLink,
  StageLinkKey,
  StageLinkModule,
  VOICE_GOLIVE_TOPIC,
} from "../src/index.js";
import { delay, type Json, WAIT_MS, waitUntil } from "./common.js";

const TOKEN = "stage-secret";

class Harness {
  private constructor(
    readonly sup: Supervisor,
    readonly services: ServiceRegistry,
    readonly bus: EventBus,
    readonly module: StageLinkModule,
  ) {}

  static async start(
    config: JsonObject = {},
    prepare: (services: ServiceRegistry) => void = () => undefined,
  ): Promise<Harness> {
    const services = new ServiceRegistry();
    prepare(services);
    services.provide("commands", CommandRegistryKey, new CommandRegistry(new Permissions()));
    const bus = new EventBus();
    const sup = new Supervisor({ bus, services });
    const module = new StageLinkModule();
    await sup.register(module, { bind: "127.0.0.1:0", token: TOKEN, ...config }, true);
    await sup.startAll();
    const h = new Harness(sup, services, bus, module);
    harnesses.push(h);
    return h;
  }

  url(): string {
    const addr = this.module.localAddr();
    if (!addr) throw new Error("not running");
    return `ws://${formatAddress(addr)}/stage-link`;
  }

  link(): StageLink {
    return this.services.require(StageLinkKey);
  }

  registry(): CommandRegistry {
    return this.services.require(CommandRegistryKey);
  }

  subscribe(topics: string[]): Subscription {
    return this.bus.subscribe(topics);
  }

  publish(event: Event): void {
    this.bus.publish("test", event);
  }

  async node(): Promise<Node> {
    const node = await Node.connect(this.url());
    node.hello(TOKEN);
    const welcome = await node.recvJson();
    expect(welcome.type, JSON.stringify(welcome)).toBe("welcome");
    const link = this.link();
    await waitUntil(() => link.isConnected());
    return node;
  }
}

const harnesses: Harness[] = [];
const nodes: Node[] = [];
afterEach(async () => {
  for (const n of nodes.splice(0)) n.ws.terminate();
  for (const h of harnesses.splice(0)) await h.sup.stopAll();
});

async function nextEvent(sub: Subscription): Promise<Envelope> {
  const env = await Promise.race([sub.recv(), delay(WAIT_MS).then(() => null)]);
  if (!env) throw new Error("no event in time");
  return env;
}

/** A scripted Stage node. */
class Node {
  readonly #queue: Json[] = [];
  #close: number | null = null;
  readonly #waiters = new Set<() => void>();

  private constructor(readonly ws: WebSocket) {
    ws.on("message", (data) => {
      const v = JSON.parse(data.toString());
      if (v.type === "ping") {
        this.sendJson({ type: "pong" });
        return;
      }
      this.#queue.push(v);
      this.#wake();
    });
    ws.on("close", (code) => {
      this.#close = code;
      this.#wake();
    });
    ws.on("error", () => {});
  }

  #wake(): void {
    for (const w of [...this.#waiters]) w();
  }

  static connect(url: string): Promise<Node> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const node = new Node(ws);
      nodes.push(node);
      ws.once("open", () => resolve(node));
      ws.once("error", reject);
    });
  }

  sendJson(value: unknown): void {
    this.ws.send(JSON.stringify(value));
  }

  hello(token: string): void {
    this.sendJson({
      type: "hello",
      version: 1,
      token,
      node: "test-stage",
      capabilities: ["vts", "obs"],
    });
  }

  async #wait<T>(take: () => T | undefined, what: string): Promise<T> {
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
      const v = take();
      if (v !== undefined) return v;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`no ${what} in time`);
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.#waiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, left);
        this.#waiters.add(done);
      });
    }
  }

  /** Next JSON message (pings are answered). */
  recvJson(): Promise<Json> {
    return this.#wait(() => {
      if (this.#queue.length > 0) return this.#queue.shift();
      if (this.#close !== null) throw new Error(`socket closed (${this.#close})`);
      return undefined;
    }, "message");
  }

  expectClose(): Promise<number> {
    return this.#wait(() => this.#close ?? undefined, "close");
  }
}

const voiceCtx = (): ContextKey => ({
  platform: "discord",
  scope: "g1",
  channel: "vc1",
  kind: "voice",
});

function invocation(path: string): Invocation {
  const inv = Invocation.create(
    path,
    { platform: "discord", id: "7" },
    { platform: "discord", scope: "g1", channel: "c1", kind: "channel" },
  );
  // Starting and stopping the stream needs `stream.start` / `stream.stop` (admin).
  inv.invoker_is_guild_admin = true;
  return inv;
}

/** Answers the next request with `status`; returns the request. */
async function answer(node: Node, status: JsonObject): Promise<Json> {
  const req = await node.recvJson();
  node.sendJson({ ...status, id: req.id, type: "status" });
  return req;
}

describe("stage.link", () => {
  it("empty_token_fails_to_start", async () => {
    const h = await Harness.start({ token: "" });
    let state: ReturnType<Supervisor["list"]>[number] | undefined;
    await waitUntil(() => {
      state = h.sup.list().find((s) => s.id === "stage.link");
      return state?.state === "failed";
    });
    expect(state?.reason).toContain("STAGE_LINK_TOKEN");
    expect(h.services.has(StageLinkKey)).toBe(false);
  });

  it("hello_is_authenticated_and_newer_node_wins", async () => {
    const h = await Harness.start({ hello_timeout_ms: 300 });

    const wrong = await Node.connect(h.url());
    wrong.hello("nope");
    expect(await wrong.expectClose()).toBe(4401);

    const old = await Node.connect(h.url());
    old.sendJson({ type: "hello", version: 9, token: TOKEN });
    expect(await old.expectClose()).toBe(4400);

    const silent = await Node.connect(h.url());
    expect(await silent.expectClose()).toBe(4400);
    expect(h.link().isConnected()).toBe(false);

    const status = h.subscribe([STATUS_TOPIC]);
    const first = await h.node();
    const link = h.link();
    expect(link.node()).toStrictEqual(["test-stage", ["vts", "obs"]]);
    const env = await nextEvent(status);
    expect(env.event).toStrictEqual(
      customEvent(STATUS_TOPIC, {
        connected: true,
        vts: false,
        obs: false,
        scene: null,
        streaming: false,
        scenes: [],
        hotkeys: [],
        overlay_url: null,
      }),
    );
    expect(env.source).toBe("stage.link");

    first.sendJson({ type: "status", vts: true, obs: true, scene: "Talk", streaming: false });
    await waitUntil(() => (link.status()?.vts ?? false) && (link.status()?.obs ?? false));
    expect(link.status()?.scene).toBe("Talk");

    await h.node();
    expect(await first.expectClose()).toBe(4409);
    expect(link.isConnected()).toBe(true);
  });

  it("forwards_emotions_speaking_and_subtitles", async () => {
    const h = await Harness.start();
    const node = await h.node();
    const turn = newId();

    // A text turn's emotion goes out at once.
    h.publish(customEvent(EMOTION_TOPIC, { emotion: "smug" }));
    expect(await node.recvJson()).toStrictEqual({ type: "emotion", name: "smug", intensity: 1 });
    // A voice turn's emotion waits for the sentence spoken with it.
    h.publish(
      customEvent(EMOTION_TOPIC, {
        turn,
        context: { ...voiceCtx() },
        emotion: "annoyed",
        intensity: 0.6,
      }),
    );
    h.publish({
      type: "voice_playback",
      data: { context: voiceCtx(), turn, state: "started", text: "哼,", emotion: "annoyed" },
    });
    expect(await node.recvJson()).toStrictEqual({ type: "speaking", state: "started" });
    expect(await node.recvJson()).toStrictEqual({
      type: "subtitle",
      turn,
      text: "哼,",
      final: false,
    });
    expect(await node.recvJson()).toStrictEqual({
      type: "emotion",
      name: "annoyed",
      intensity: 0.6,
    });
    h.publish({ type: "agent_turn_completed", data: { turn, context: voiceCtx(), text: "哼," } });
    h.publish({
      type: "voice_playback",
      data: { context: voiceCtx(), turn, state: "finished", text: "哼," },
    });
    expect(await node.recvJson()).toStrictEqual({ type: "speaking", state: "stopped" });
    expect(await node.recvJson()).toStrictEqual({
      type: "subtitle",
      turn,
      text: "哼,",
      final: true,
    });

    h.link().gaze("game");
    expect(await node.recvJson()).toStrictEqual({ type: "gaze", target: "game" });
  });

  it("tells_the_node_what_she_is_doing", async () => {
    const h = await Harness.start();
    // Known before the node connects: it is told once it reports its status.
    h.publish(
      customEvent(SONG_PREPARE_TOPIC, {
        no: 1,
        title: "夜に駆ける",
        stage: "convert",
        progress: 0.5,
        exclusive: "active",
      }),
    );
    const node = await h.node();
    node.sendJson({ type: "status", vts: false, obs: false, scene: null, streaming: false });
    expect(await node.recvJson()).toStrictEqual({
      type: "activity",
      kind: "song_prepare",
      label: "轉換歌聲",
      detail: "夜に駆ける",
      progress: 0.5,
      elapsed_ms: null,
      duration_ms: null,
    });
    h.publish(customEvent(SONG_PREPARE_TOPIC, { no: null }));
    expect(await node.recvJson()).toMatchObject({ type: "activity", kind: null });

    // A voice turn that has not spoken yet: thinking, after the show delay (on the timer).
    const turn = newId();
    h.publish({ type: "agent_turn_started", data: { turn, context: voiceCtx() } });
    expect(await node.recvJson()).toMatchObject({ type: "activity", kind: "thinking" });
    h.publish(
      customEvent(SONG_TOPIC, {
        state: "started",
        song: "s1",
        title: "アイドル",
        duration_ms: 200_000,
      }),
    );
    expect(await node.recvJson()).toStrictEqual({ type: "speaking", state: "started" });
    expect(await node.recvJson()).toMatchObject({
      type: "activity",
      kind: "singing",
      detail: "アイドル",
      duration_ms: 200_000,
    });
  });

  it("follows_go_live_with_obs", async () => {
    const h = await Harness.start({ golive_start_delay_ms: 0 });
    const node = await h.node();
    node.sendJson({ type: "status", vts: true, obs: true, scene: "Talk", streaming: false });
    await waitUntil(() => h.link().status()?.obs === true);

    // The voice node started Go Live: Stage presses OBS "Start Streaming".
    h.publish(customEvent(VOICE_GOLIVE_TOPIC, { guild: "g1", state: "starting" }));
    const start = await node.recvJson();
    expect(start.type).toBe("stream");
    expect(start.action).toBe("start");
    node.sendJson({
      type: "status",
      vts: true,
      obs: true,
      scene: "Talk",
      streaming: true,
      id: start.id,
    });
    await waitUntil(() => h.link().status()?.streaming === true);

    // "live" does not touch OBS again.
    h.publish(customEvent(VOICE_GOLIVE_TOPIC, { guild: "g1", state: "live" }));
    // Go Live ended: Stage presses OBS "Stop Streaming".
    h.publish(customEvent(VOICE_GOLIVE_TOPIC, { guild: "g1", state: "stopped" }));
    const stop = await node.recvJson();
    expect(stop.type).toBe("stream");
    expect(stop.action).toBe("stop");
    node.sendJson({
      type: "status",
      vts: true,
      obs: true,
      scene: "Talk",
      streaming: false,
      id: stop.id,
    });
    await waitUntil(() => h.link().status()?.streaming === false);
  });

  it("requests_are_answered_by_id", async () => {
    const h = await Harness.start({ request_timeout_ms: 500 });
    const link = h.link();
    await expect(link.setScene("Game"), "no node yet").rejects.toThrow("not connected");
    expect(() => link.gaze("chat")).toThrow("not connected");
    const node = await h.node();

    let pending = link.setScene("Game");
    let req = await node.recvJson();
    expect(req.type).toBe("scene");
    expect(req.name).toBe("Game");
    node.sendJson({
      type: "status",
      vts: false,
      obs: true,
      scene: "Game",
      streaming: false,
      id: req.id,
    });
    expect((await pending).scene).toBe("Game");

    pending = link.stream("start");
    req = await node.recvJson();
    expect(req.type).toBe("stream");
    expect(req.action).toBe("start");
    const errors = h.subscribe(["stage.error"]);
    node.sendJson({ type: "error", message: "OBS is not connected", id: req.id });
    await expect(pending).rejects.toThrow("OBS is not connected");
    expect((await nextEvent(errors)).event).toStrictEqual(
      customEvent("stage.error", { message: "OBS is not connected" }),
    );

    // Unanswered requests time out.
    await expect(link.hotkey("Wave")).rejects.toThrow("in time");
    expect((await node.recvJson()).type).toBe("avatar_hotkey");

    // A disconnect fails pending requests.
    pending = link.refreshStatus();
    expect((await node.recvJson()).type).toBe("status_request");
    node.ws.close();
    await expect(pending).rejects.toThrow("stage node disconnected");
    await waitUntil(() => !link.isConnected());
    expect(link.status()).toBeNull();
  });

  it("stream_commands", async () => {
    const h = await Harness.start();
    const registry = h.registry();
    let reply = await registry.dispatch(invocation("stream status"));
    expect(reply.text).toContain("直播機目前沒有連線");

    const node = await h.node();

    let call = registry.dispatch(invocation("stream start"));
    let req = await answer(node, { vts: true, obs: true, scene: "Talk", streaming: true });
    expect(req.action).toBe("start");
    reply = await call;
    expect(registry.get(["stream", "start"])?.ephemeral).toBe(false);
    expect(reply.text).toBe("已開始直播。");

    call = registry.dispatch(invocation("stream scene").withArg("name", "Game"));
    req = await answer(node, { vts: true, obs: true, scene: "Game", streaming: true });
    expect(req.name).toBe("Game");
    expect((await call).text).toContain("Game");

    call = registry.dispatch(invocation("stream status"));
    req = await answer(node, { vts: false, obs: true, scene: "Game", streaming: true });
    expect(req.type).toBe("status_request");
    reply = await call;
    expect(registry.get(["stream", "status"])?.ephemeral).toBe(false);
    expect(reply.text).toContain("直播中");
    expect(reply.text).toContain("Game");

    const paths = registry.specs().map((s) => commandName(s));
    for (const p of STREAM_COMMAND_PATHS) expect(paths, `${p} registered`).toContain(p);
    expect(registry.get(["stream", "start"])?.permission).toBe("stream.start");
    expect(registry.groupDescription("stream")).toContain("OBS");
    expect(registry.get(["stream", "scene"])?.args[0]?.autocomplete).toBe(true);
    expect(await registry.autocomplete(invocation("stream scene"), "name", "ga")).toEqual([
      { name: "Game", value: "Game" },
    ]);

    await h.sup.stopAll();
    for (const p of STREAM_COMMAND_PATHS) {
      expect(registry.get(p.split(" ")), `${p} unregistered on stop`).toBeUndefined();
    }
  });

  it("starts and stops the whole broadcast when the voice module is there", async () => {
    const h = await Harness.start({}, (services) => {
      services.provide("actuators", ActuatorRegistryKey, new ActuatorRegistry({ services }));
    });
    const asked: string[] = [];
    const actuators = h.services.require(ActuatorRegistryKey);
    for (const name of ["stream.start", "stream.stop"]) {
      actuators.register(
        defineCapability({
          name,
          summary: name,
          risk: "low",
          args: z.object({}),
          permission: "voice.golive",
          async execute() {
            asked.push(name);
            return { text: "ok", data: null };
          },
        }),
      );
    }
    const registry = h.registry();
    expect((await registry.dispatch(invocation("stream start"))).text).toBe("已開始直播。");
    expect((await registry.dispatch(invocation("stream stop"))).text).toBe("已停止直播。");
    expect(asked).toEqual(["stream.start", "stream.stop"]);
  });

  it("shows_a_gift_expression_through_the_gate_and_forwards_gifts", async () => {
    const h = await Harness.start({ request_timeout_ms: 500 }, (services) => {
      services.provide("actuators", ActuatorRegistryKey, new ActuatorRegistry({ services }));
    });
    const actuators = h.services.require(ActuatorRegistryKey);
    const ask = (args: JsonObject) =>
      actuators.invoke({
        principal: Principals.panel("api"),
        capability: "stage.expression",
        args,
        why: "bought",
        turn: null,
      });

    // No node: the capability fails (the caller refunds).
    const none = await ask({ expression: "heart", seconds: 5 });
    expect(none).toMatchObject({
      status: "failed",
      error: expect.stringContaining("not connected"),
    });

    const node = await h.node();
    const done = ask({ expression: "big_bowl", seconds: 4 });
    const req = await node.recvJson();
    expect(req).toMatchObject({ type: "avatar_expression", expression: "big_bowl", seconds: 4 });
    node.sendJson({ type: "status", vts: true, obs: false, id: req.id });
    expect(await done).toMatchObject({ status: "done" });

    // The node says no (VTube Studio is off): the capability fails.
    const failing = ask({ expression: "blush", seconds: 2 });
    const req2 = await node.recvJson();
    node.sendJson({ type: "error", message: "VTube Studio is not connected", id: req2.id });
    expect(await failing).toMatchObject({
      status: "failed",
      error: expect.stringContaining("VTube Studio is not connected"),
    });

    // Bad arguments never reach the node.
    expect((await ask({ expression: "wink", seconds: 5 })).status).toBe("denied");
    expect((await ask({ expression: "heart", seconds: 99 })).status).toBe("denied");

    // `economy.gift` goes to the node as `gift`; junk is dropped.
    h.publish(
      customEvent("economy.gift", { name: "Owen", item: "rice", count: 1, label: "一碗白飯" }),
    );
    expect(await node.recvJson()).toStrictEqual({
      type: "gift",
      name: "Owen",
      item: "rice",
      count: 1,
      label: "一碗白飯",
    });
    h.publish(customEvent("economy.gift", { name: "", item: "rice", count: 1, label: "x" }));
    h.link().gaze("chat");
    expect(await node.recvJson()).toStrictEqual({ type: "gaze", target: "chat" });
  });

  it("stop_closes_the_node_with_going_away_and_heartbeat_times_out", async () => {
    let h = await Harness.start();
    let node = await h.node();
    await h.sup.stopAll();
    expect(await node.expectClose()).toBe(1001);
    expect(h.module.localAddr()).toBeNull();
    const health = await h.module.health();
    expect(health).toStrictEqual({ status: "healthy" });

    // A silent node is dropped with 4408; pings come every ping_interval_ms.
    h = await Harness.start({ peer_timeout_ms: 300, ping_interval_ms: 100 });
    expect(await h.module.health()).toStrictEqual({
      status: "degraded",
      reason: "stage node not connected",
    });
    node = await Node.connect(h.url());
    node.ws.removeAllListeners("message");
    let pings = 0;
    node.ws.on("message", (data) => {
      if (JSON.parse(data.toString()).type === "ping") pings++;
    });
    node.hello(TOKEN);
    expect(await node.expectClose()).toBe(4408);
    expect(pings).toBeGreaterThanOrEqual(1);
  });
});

describe("scene director on the link", () => {
  const SCENES = { vts: true, obs: true, scenes: ["Talk", "Game", "Bye"] };
  const scenes = {
    roles: { chat: "Talk", game: "Game", ending: "Bye" },
    transition: { name: "Fade", duration_ms: 300 },
    transitions: { game: { name: "Stinger" } },
    debounce_ms: 0,
    min_switch_ms: 0,
    ending_ms: 50,
  };

  it("switches to the game scene with its transition when a session starts", async () => {
    const h = await Harness.start({ scenes });
    const node = await h.node();
    node.sendJson({ type: "status", ...SCENES, scene: "Talk", streaming: false });
    await waitUntil(() => h.link().status()?.scene === "Talk");

    h.publish(customEvent("game.director.session", { state: "started", game: "minecraft" }));
    let req = await answer(node, { ...SCENES, scene: "Game", streaming: false });
    expect(req).toMatchObject({ type: "scene", name: "Game", transition: "Stinger" });
    expect(req.transition_ms).toBeUndefined();

    h.publish(customEvent("game.director.session", { state: "stopped", game: "minecraft" }));
    req = await answer(node, { ...SCENES, scene: "Talk", streaming: false });
    expect(req).toMatchObject({
      type: "scene",
      name: "Talk",
      transition: "Fade",
      transition_ms: 300,
    });
  });

  it("shows the ending scene before /stream stop stops OBS", async () => {
    const h = await Harness.start({ scenes: { ...scenes, starting_ms: 0 } });
    const node = await h.node();
    node.sendJson({ type: "status", ...SCENES, scene: "Talk", streaming: true });
    await waitUntil(() => h.link().status()?.streaming === true);

    const call = h.registry().dispatch(invocation("stream stop"));
    const ending = await answer(node, { ...SCENES, scene: "Bye", streaming: true });
    expect(ending).toMatchObject({ type: "scene", name: "Bye" });
    const stop = await answer(node, { ...SCENES, scene: "Bye", streaming: false });
    expect(stop).toMatchObject({ type: "stream", action: "stop" });
    expect((await call).text).toBe("已停止直播。");
  });
});
