import type { ActionResult, DirectRun, RoutedCall } from "@miyoria/actions";
import {
  ACTIVITY_DONE_TOPIC,
  ACTIVITY_FAILED_TOPIC,
  ACTIVITY_STARTED_TOPIC,
  type ActivityRequest,
  customEvent,
  NOTICE_TOPIC,
  Principals,
} from "@miyoria/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHAT, FakeWorld, GUILD, OWEN, tick, until } from "./fake.js";

const JOIN: ActivityRequest = {
  type: "ensure_voice",
  platform: "discord",
  guild: GUILD,
  channel: null,
  follow: OWEN,
};
const LIVE: ActivityRequest = {
  type: "ensure_live",
  platform: "discord",
  guild: GUILD,
  source: null,
};
const MC: ActivityRequest = { type: "start", activity: "game", target: "minecraft", goal: null };

afterEach(() => {
  vi.useRealTimers();
});

async function settle(w: FakeWorld, id: string | null): Promise<void> {
  if (id === null) return;
  await until(() => {
    const t = w.service.task(id);
    return t !== null && (t.status === "done" || t.status === "failed");
  });
}

describe("presence", () => {
  it("joins once; asking again is idempotent and does not switch channels", async () => {
    const w = new FakeWorld();
    const first = await w.service.request(w.transition(JOIN));
    expect(first.status).toBe("started");
    // Concurrent: the same task answers.
    const second = await w.service.request(w.transition(JOIN));
    expect(second).toEqual({
      status: "already",
      task: first.status === "started" ? first.task : null,
      resource: "presence",
    });
    expect(w.service.snapshot().presence.type).toBe("joining");
    await settle(w, first.status === "started" ? first.task : null);
    expect(w.service.snapshot().presence).toMatchObject({
      type: "in",
      channel: { scope: GUILD, channel: "v1" },
    });
    const third = await w.service.request(w.transition(JOIN));
    expect(third).toEqual({ status: "already", task: null, resource: "presence" });
    expect(w.count("voice.join")).toBe(1);
  });

  it("leaving stops the broadcast first (curtain and OBS, then Go Live), then leaves", async () => {
    const w = new FakeWorld();
    const live = await w.service.request(w.transition(LIVE));
    await settle(w, live.status === "started" ? live.task : null);
    expect(w.service.snapshot().broadcast).toMatchObject({ type: "live", golive: true, obs: true });
    const leave = await w.service.request(w.transition({ type: "leave_voice" }));
    await settle(w, leave.status === "started" ? leave.task : null);
    const order = w.calls.map(
      (c) => `${c.capability}${c.args.action ? `:${String(c.args.action)}` : ""}`,
    );
    const tail = order.slice(order.indexOf("stage.stream:start") + 1);
    expect(tail).toEqual(["stage.stream:stop", "stream.stop", "voice.leave"]);
    const snap = w.service.snapshot();
    expect(snap.presence).toEqual({ type: "none" });
    expect(snap.broadcast).toEqual({ type: "off" });
  });

  it("speak then leave: waits for the asking turn, then leaves behind her speech", async () => {
    const w = new FakeWorld();
    w.voice.set(GUILD, "v1");
    w.emit({
      type: "voice_joined",
      data: { context: { ...CHAT, channel: "v1", kind: "voice" }, participants: [] },
    });
    w.emit({ type: "agent_turn_started", data: { turn: "t1", context: CHAT } });
    const leave = await w.service.request({ ...w.transition({ type: "leave_voice" }), turn: "t1" });
    expect(leave.status).toBe("started");
    await tick(30);
    expect(w.count("voice.leave")).toBe(0);
    w.emit({ type: "agent_turn_completed", data: { turn: "t1", context: CHAT, text: "掰掰" } });
    await settle(w, leave.status === "started" ? leave.task : null);
    const call = w.calls.find((c) => c.capability === "voice.leave");
    expect(call).toMatchObject({ priority: "idle", lane: "voice:discord:g1" });
    expect(w.service.snapshot().presence.type).toBe("none");
  });

  it("leaving while a join is in flight supersedes the join", async () => {
    const w = new FakeWorld({ latency: 20 });
    const join = await w.service.request(w.transition(JOIN));
    const leave = await w.service.request(w.transition({ type: "leave_voice" }));
    expect(leave.status).toBe("queued");
    await settle(w, leave.status === "queued" ? leave.task : null);
    const joined = w.service.task(join.status === "started" ? join.task : "");
    expect(joined?.failure?.code).toBe("superseded");
  });
});

describe("broadcast", () => {
  it("reports success only once Go Live is live and OBS streams", async () => {
    const w = new FakeWorld();
    const r = await w.service.request(w.transition(LIVE));
    expect(r.status).toBe("started");
    expect(w.service.snapshot().broadcast.type).toBe("starting");
    await settle(w, r.status === "started" ? r.task : null);
    expect(w.count("voice.join")).toBe(0); // stream.start joins by itself
    expect(w.calls.map((c) => c.capability)).toEqual(["stream.start", "stage.stream"]);
    // OBS following Go Live is an implied step: through the gate (not the primary capability).
    expect(w.calls[1]?.primary).toBeNull();
    expect(w.calls[1]?.principal.kind).toBe("director");
    const done = w.published(ACTIVITY_DONE_TOPIC);
    expect(done).toHaveLength(1);
    const notices = w.published(NOTICE_TOPIC);
    expect(notices.at(-1)).toMatchObject({ ok: true, context: CHAT, source: "activity" });
    // Idempotent once live.
    expect((await w.service.request(w.transition(LIVE))).status).toBe("already");
  });

  it("OBS starts while Go Live is starting: the node goes live on OBS's video", async () => {
    const w = new FakeWorld();
    w.liveNeedsObs = true;
    const r = await w.service.request(w.transition(LIVE));
    await settle(w, r.status === "started" ? r.task : null);
    expect(w.published(ACTIVITY_FAILED_TOPIC)).toHaveLength(0);
    expect(w.service.snapshot().broadcast).toMatchObject({ type: "live", golive: true, obs: true });
    expect(w.calls.map((c) => c.capability)).toEqual(["stream.start", "stage.stream"]);
  });

  it("a Go Live that never comes up stops OBS and Go Live again", async () => {
    const w = new FakeWorld({ config: { golive_timeout_ms: 60 } });
    w.goliveHangs = true;
    const r = await w.service.request(w.transition(LIVE));
    await settle(w, r.status === "started" ? r.task : null);
    expect(w.published(ACTIVITY_FAILED_TOPIC)[0]?.detail).toContain("還沒開始");
    expect(
      w.calls.map((c) => `${c.capability}${c.args.action ? `:${String(c.args.action)}` : ""}`),
    ).toEqual(["stream.start", "stage.stream:start", "stage.stream:stop", "stream.stop"]);
    await until(() => w.golive.size === 0);
    expect(w.service.snapshot().broadcast.type).toBe("off");
  });

  it("a failed Go Live reaches the requester as a notice", async () => {
    const w = new FakeWorld();
    w.goliveFails = "ffmpeg exited";
    const r = await w.service.request(w.transition(LIVE));
    await settle(w, r.status === "started" ? r.task : null);
    const failed = w.published(ACTIVITY_FAILED_TOPIC);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.detail).toContain("ffmpeg exited");
    expect(w.published(NOTICE_TOPIC).at(-1)).toMatchObject({
      ok: false,
      text: expect.stringContaining("開台失敗"),
    });
    expect(w.service.snapshot().broadcast.type).toBe("off");
  });

  it("OBS not open: the broadcast fails with 開台失敗:OBS 沒開 and Go Live is rolled back", async () => {
    const w = new FakeWorld({ obs: false });
    const r = await w.service.request(w.transition(LIVE));
    await settle(w, r.status === "started" ? r.task : null);
    expect(w.published(NOTICE_TOPIC).at(-1)?.text).toBe("開台失敗:OBS 沒開");
    expect(w.published(ACTIVITY_FAILED_TOPIC)[0]?.code).toBe("precondition");
    expect(w.count("stream.stop")).toBe(1);
    await until(() => w.service.snapshot().broadcast.type === "off");
  });

  it("without a stage node it is Go Live only", async () => {
    const w = new FakeWorld({ stage: false });
    const r = await w.service.request(w.transition(LIVE));
    await settle(w, r.status === "started" ? r.task : null);
    expect(w.count("stage.stream")).toBe(0);
    expect(w.service.snapshot().broadcast).toMatchObject({
      type: "live",
      golive: true,
      obs: false,
    });
  });

  it("OBS follows a Go Live started elsewhere, and stops when it ends", async () => {
    const w = new FakeWorld();
    w.emit(customEvent("voice.golive", { guild: GUILD, state: "live", error: null, reason: null }));
    w.golive.set(GUILD, "live");
    await until(() => w.obsStreaming);
    expect(w.calls.map((c) => c.capability)).toEqual(["stream.start", "stage.stream"]);
    w.golive.delete(GUILD);
    w.emit(
      customEvent("voice.golive", {
        guild: GUILD,
        state: "failed",
        error: "node crashed",
        reason: null,
      }),
    );
    await until(() => !w.obsStreaming);
    expect(w.service.snapshot().broadcast.type).toBe("off");
  });

  it("stop_live while starting supersedes the start", async () => {
    const w = new FakeWorld({ latency: 20 });
    const start = await w.service.request(w.transition(LIVE));
    const stop = await w.service.request(w.transition({ type: "stop_live" }));
    expect(stop.status).toBe("queued");
    await settle(w, stop.status === "queued" ? stop.task : null);
    expect(w.service.task(start.status === "started" ? start.task : "")?.failure?.code).toBe(
      "superseded",
    );
    await until(() => w.golive.size === 0);
  });
});

describe("broadcast through the hub (obs_hub)", () => {
  const HUB = { obs_hub: true };
  const order = (w: FakeWorld) =>
    w.calls.map((c) => `${c.capability}${c.args.action ? `:${String(c.args.action)}` : ""}`);

  it("starts OBS first, waits obs_start_delay_ms after it streams, then Go Live", async () => {
    const w = new FakeWorld({ config: { ...HUB, obs_start_delay_ms: 40 } });
    const r = await w.service.request(w.transition(LIVE));
    expect(w.service.snapshot().broadcast.type).toBe("starting");
    await until(() => w.obsStreaming);
    const streamingAt = Date.now();
    await until(() => w.count("stream.start") === 1);
    expect(Date.now() - streamingAt).toBeGreaterThanOrEqual(30);
    await settle(w, r.status === "started" ? r.task : null);
    expect(order(w)).toEqual(["stage.stream:start", "stream.start"]);
    // OBS is an implied step; Go Live is the primary one.
    expect(w.calls[0]?.primary).toBeNull();
    expect(w.calls[0]?.principal.kind).toBe("director");
    expect(w.published(ACTIVITY_DONE_TOPIC)).toHaveLength(1);
    expect(w.service.snapshot().broadcast).toMatchObject({ type: "live", golive: true, obs: true });
    expect((await w.service.request(w.transition(LIVE))).status).toBe("already");
  });

  it("OBS already streaming (the website's): only Go Live starts", async () => {
    const w = new FakeWorld({ config: HUB });
    w.obsStreaming = true;
    w.setObs(true);
    expect(w.service.snapshot().broadcast).toEqual({ type: "off" });
    const r = await w.service.request(w.transition(LIVE));
    await settle(w, r.status === "started" ? r.task : null);
    expect(order(w)).toEqual(["stream.start"]);
    expect(w.service.snapshot().broadcast).toMatchObject({ type: "live", golive: true, obs: true });
  });

  it("OBS that does not stream fails before Go Live is touched", async () => {
    const w = new FakeWorld({ config: { ...HUB, obs_attempts: 2 } });
    w.obsStuck = true;
    const r = await w.service.request(w.transition(LIVE));
    await settle(w, r.status === "started" ? r.task : null);
    expect(order(w)).toEqual(["stage.stream:start", "stage.stream:start"]);
    expect(w.published(NOTICE_TOPIC).at(-1)?.text).toBe("開台失敗:OBS 沒有開始直播");
    expect(w.service.snapshot().broadcast.type).toBe("off");
  });

  it("OBS not open: 開台失敗:OBS 沒開, without starting Go Live", async () => {
    const w = new FakeWorld({ obs: false, config: HUB });
    const r = await w.service.request(w.transition(LIVE));
    await settle(w, r.status === "started" ? r.task : null);
    expect(w.published(NOTICE_TOPIC).at(-1)?.text).toBe("開台失敗:OBS 沒開");
    expect(w.calls).toEqual([]);
  });

  it("without a stage node Go Live starts directly", async () => {
    const w = new FakeWorld({ stage: false, config: HUB });
    const r = await w.service.request(w.transition(LIVE));
    await settle(w, r.status === "started" ? r.task : null);
    expect(order(w)).toEqual(["stream.start"]);
    expect(w.service.snapshot().broadcast).toMatchObject({ type: "live", golive: true });
  });

  it("stop_live ends Go Live only; OBS keeps streaming and reads as no broadcast", async () => {
    const w = new FakeWorld({ config: HUB });
    const live = await w.service.request(w.transition(LIVE));
    await settle(w, live.status === "started" ? live.task : null);
    const stop = await w.service.request(w.transition({ type: "stop_live" }));
    await settle(w, stop.status === "started" ? stop.task : null);
    expect(order(w)).toEqual(["stage.stream:start", "stream.start", "stream.stop"]);
    expect(w.obsStreaming).toBe(true);
    expect(w.service.snapshot().broadcast).toEqual({ type: "off" });
    // Nothing left to stop: OBS alone is the website's.
    expect(await w.service.request(w.transition({ type: "stop_live" }))).toMatchObject({
      status: "already",
    });
  });

  it("leaving voice stops Go Live but not OBS, and does not wait on OBS", async () => {
    const w = new FakeWorld({ config: HUB });
    const live = await w.service.request(w.transition(LIVE));
    await settle(w, live.status === "started" ? live.task : null);
    const leave = await w.service.request(w.transition({ type: "leave_voice" }));
    await settle(w, leave.status === "started" ? leave.task : null);
    expect(w.service.task(leave.status === "started" ? leave.task : "")?.status).toBe("done");
    expect(order(w)).toEqual(["stage.stream:start", "stream.start", "stream.stop", "voice.leave"]);
    expect(w.obsStreaming).toBe(true);
    const snap = w.service.snapshot();
    expect(snap.presence).toEqual({ type: "none" });
    expect(snap.broadcast).toEqual({ type: "off" });
  });

  it("leaving voice while only OBS streams just leaves", async () => {
    const w = new FakeWorld({ config: HUB });
    w.obsStreaming = true;
    w.setObs(true);
    w.voice.set(GUILD, "v1");
    w.emit({
      type: "voice_joined",
      data: { context: { ...CHAT, channel: "v1", kind: "voice" }, participants: [] },
    });
    const leave = await w.service.request(w.transition({ type: "leave_voice" }));
    await settle(w, leave.status === "started" ? leave.task : null);
    expect(order(w)).toEqual(["voice.leave"]);
    expect(w.obsStreaming).toBe(true);
  });

  it("a Go Live that fails is rolled back without stopping OBS", async () => {
    const w = new FakeWorld({ config: HUB });
    w.goliveFails = "rtmp pull: no publisher";
    const r = await w.service.request(w.transition(LIVE));
    await settle(w, r.status === "started" ? r.task : null);
    expect(w.published(ACTIVITY_FAILED_TOPIC)[0]?.detail).toContain("no publisher");
    expect(w.count("stage.stream")).toBe(1);
    expect(w.obsStreaming).toBe(true);
    expect(w.service.snapshot().broadcast.type).toBe("off");
  });

  it("a Go Live that never comes up stops Go Live only", async () => {
    const w = new FakeWorld({ config: { ...HUB, golive_timeout_ms: 60 } });
    w.goliveHangs = true;
    const r = await w.service.request(w.transition(LIVE));
    await settle(w, r.status === "started" ? r.task : null);
    expect(w.published(ACTIVITY_FAILED_TOPIC)[0]?.detail).toContain("還沒開始");
    expect(order(w)).toEqual(["stage.stream:start", "stream.start", "stream.stop"]);
    expect(w.obsStreaming).toBe(true);
  });

  it("a Go Live started elsewhere is adopted; when it ends OBS keeps streaming", async () => {
    const w = new FakeWorld({ config: HUB });
    w.obsStreaming = true;
    w.setObs(true);
    w.golive.set(GUILD, "live");
    w.emit(customEvent("voice.golive", { guild: GUILD, state: "live", error: null, reason: null }));
    expect(w.service.snapshot().broadcast).toMatchObject({ type: "live", golive: true, obs: true });
    w.golive.delete(GUILD);
    w.emit(
      customEvent("voice.golive", {
        guild: GUILD,
        state: "failed",
        error: "node crashed",
        reason: null,
      }),
    );
    await tick(30);
    expect(w.calls).toEqual([]);
    expect(w.obsStreaming).toBe(true);
    expect(w.service.snapshot().broadcast).toEqual({ type: "off" });
  });

  it("a Go Live started elsewhere while OBS is off brings OBS up", async () => {
    const w = new FakeWorld({ config: HUB });
    w.golive.set(GUILD, "live");
    w.emit(customEvent("voice.golive", { guild: GUILD, state: "live", error: null, reason: null }));
    await until(() => w.obsStreaming);
    await until(() => w.count("stream.start") === 1);
    expect(order(w)).toEqual(["stage.stream:start", "stream.start"]);
  });
});

describe("activity", () => {
  it("game start answers at once, never starts twice, and notices when it is up", async () => {
    const w = new FakeWorld({ launchMs: 60 });
    const a = await w.service.request(w.transition(MC));
    const b = await w.service.request(w.transition(MC));
    expect(a.status).toBe("started");
    expect(b).toEqual({
      status: "already",
      task: a.status === "started" ? a.task : null,
      resource: "activity",
    });
    expect(w.service.snapshot().activity).toMatchObject({
      type: "game",
      target: "minecraft",
      phase: "starting",
    });
    await settle(w, a.status === "started" ? a.task : null);
    expect(w.starts).toBe(1);
    expect(w.service.snapshot().activity).toMatchObject({ type: "game", phase: "running" });
    expect(w.published(NOTICE_TOPIC).at(-1)?.text).toBe("Minecraft 開好了,已經開始玩。");
    expect(w.published(ACTIVITY_STARTED_TOPIC).length).toBe(1);
  });

  it("a game start ends with its step, without waiting for the session event", async () => {
    const w = new FakeWorld({ launchMs: 20 });
    w.sessionEvent = false;
    const a = await w.service.request(w.transition(MC));
    await settle(w, a.status === "started" ? a.task : null);
    expect(w.service.task(a.status === "started" ? a.task : "")?.status).toBe("done");
    expect(w.service.snapshot().activity).toMatchObject({ type: "game", phase: "running" });
    expect(w.published(NOTICE_TOPIC).at(-1)?.text).toBe("Minecraft 開好了,已經開始玩。");
  });

  it("stop while the game is still launching cancels the launch", async () => {
    const w = new FakeWorld({ launchMs: 200 });
    const start = await w.service.request(w.transition(MC));
    const stop = await w.service.request(w.transition({ type: "stop", activity: "game" }));
    expect(stop.status).toBe("queued");
    await settle(w, stop.status === "queued" ? stop.task : null);
    expect(w.service.task(start.status === "started" ? start.task : "")?.failure?.code).toBe(
      "superseded",
    );
    expect(w.starts).toBe(0);
    expect(w.service.snapshot().activity.type).toBe("idle");
  });

  it("a disconnect fails the activity, tells whoever started it, and clears on the next request", async () => {
    const w = new FakeWorld();
    const start = await w.service.request(w.transition(MC));
    await settle(w, start.status === "started" ? start.task : null);
    w.disconnect();
    const snap = w.service.snapshot();
    expect(snap.activity).toMatchObject({
      type: "game",
      phase: "failed",
      failure: { code: "disconnected" },
    });
    expect(w.published(NOTICE_TOPIC).at(-1)).toMatchObject({
      ok: false,
      code: "disconnected",
      context: CHAT,
    });
    expect(w.published(ACTIVITY_FAILED_TOPIC).at(-1)?.code).toBe("disconnected");
    const again = await w.service.request(w.transition(MC));
    await settle(w, again.status === "started" ? again.task : null);
    expect(w.service.snapshot().activity).toMatchObject({ phase: "running" });
  });

  it("a failing launch holds failed(reason) with the code", async () => {
    const w = new FakeWorld();
    w.failNext.set(
      "game.start",
      Object.assign(new Error("Minecraft 開不起來:找不到 Prism"), { name: "GameError" }),
    );
    const r = await w.service.request(w.transition(MC));
    await settle(w, r.status === "started" ? r.task : null);
    expect(w.service.snapshot().activity).toMatchObject({
      phase: "failed",
      failure: { code: "precondition", detail: expect.stringContaining("Prism") },
    });
  });

  it("browse needs the web; chatting needs no driver", async () => {
    const w = new FakeWorld();
    w.missing.add("web.search");
    const browse = await w.service.request(
      w.transition({ type: "start", activity: "browse", target: "threads", goal: null }),
    );
    expect(browse).toMatchObject({ status: "refused", code: "precondition" });
    const chat = await w.service.request(
      w.transition({ type: "start", activity: "chatting", target: null, goal: null }),
    );
    await settle(w, chat.status === "started" ? chat.task : null);
    expect(w.service.snapshot().activity).toMatchObject({ type: "chatting", phase: "running" });
  });

  it("singing shows up from the song cues", () => {
    const w = new FakeWorld();
    w.emit(customEvent("sing.cue", { state: "started", song: "s1", title: "夜に駆ける" }));
    expect(w.service.snapshot().activity).toMatchObject({ type: "singing", target: "夜に駆ける" });
    w.emit(customEvent("sing.cue", { state: "ended", song: "s1" }));
    expect(w.service.snapshot().activity.type).toBe("idle");
  });
});

describe("mutex and cancellation", () => {
  it("tasks on one resource run one at a time, in order", async () => {
    const w = new FakeWorld({ launchMs: 40 });
    const order: string[] = [];
    const a = await w.service.request(w.transition(MC));
    const b = await w.service.request(
      w.transition({ type: "start", activity: "game", target: "osu", goal: null }),
    );
    expect(b.status).toBe("queued");
    await settle(w, b.status === "queued" ? b.task : null);
    for (const c of w.calls) order.push(`${c.capability}:${String(c.args.game ?? "")}`);
    expect(order).toEqual(["game.start:minecraft", "game.stop:", "game.start:osu"]);
    expect(w.service.task(a.status === "started" ? a.task : "")?.status).toBe("done");
  });

  it("an aborted signal cancels the task while it is queued", async () => {
    const w = new FakeWorld({ launchMs: 40 });
    await w.service.request(w.transition(MC));
    const controller = new AbortController();
    const b = await w.service.request(
      w.transition({ type: "start", activity: "game", target: "osu", goal: null }),
      controller.signal,
    );
    controller.abort();
    await settle(w, b.status === "queued" ? b.task : null);
    expect(w.service.task(b.status === "queued" ? b.task : "")?.failure?.code).toBe("cancelled");
    expect(w.count("game.start")).toBe(1);
  });

  it("cancel() ends a running task", async () => {
    const w = new FakeWorld({ launchMs: 500 });
    const r = await w.service.request(w.transition(MC));
    const id = r.status === "started" ? r.task : "";
    expect(w.service.cancel(id, "test")).toBe(true);
    await settle(w, id);
    expect(w.service.task(id)?.failure?.code).toBe("cancelled");
    expect(w.service.cancel(id, "again")).toBe(false);
  });
});

describe("scene override", () => {
  it("is timed and shows in the snapshot", async () => {
    vi.useFakeTimers();
    const w = new FakeWorld();
    const r = await w.service.request(
      w.transition(
        { type: "scene_override", scene: "唱歌", duration_ms: 1_000 },
        Principals.self(CHAT),
      ),
    );
    expect(r.status).toBe("started");
    expect(w.service.snapshot()).toMatchObject({ override: { scene: "唱歌" }, scene: "唱歌" });
    await vi.advanceTimersByTimeAsync(1_001);
    expect(w.service.snapshot().override).toBeNull();
  });
});

describe("router", () => {
  function routed(
    w: FakeWorld,
    requests: ActivityRequest[],
    wait: boolean,
    execute?: (run: DirectRun) => Promise<ActionResult>,
  ): RoutedCall {
    return {
      capability: {
        name: "game.start",
        summary: "",
        risk: "medium",
        args: null as never,
        permission: null,
        execute: async () => "",
      },
      args: {},
      requests,
      request: {
        principal: Principals.user(OWEN, CHAT),
        capability: "game.start",
        args: {},
        why: "想玩",
        turn: "t9",
      },
      decision: null as never,
      wait,
      signal: undefined,
      execute:
        execute ??
        ((run) =>
          w.run({
            capability: "game.start",
            args: { game: "minecraft" },
            principal: Principals.self(CHAT),
            why: "",
            turn: null,
            task: run.task ?? "",
            signal: run.signal,
            primary: null,
          })),
    };
  }

  it("detach answers once accepted, with the task id; the notice goes to her turn", async () => {
    const w = new FakeWorld({ launchMs: 30 });
    const result = await w.service.route(routed(w, [MC], false));
    expect(result.text).toMatch(/開始了\(task .{6}\)/);
    await until(
      () =>
        w.service.snapshot().activity.type === "game" &&
        w.service.snapshot().activity.type !== "idle" &&
        w.starts === 1,
    );
    await until(() => w.published(NOTICE_TOPIC).length > 0);
    expect(w.published(NOTICE_TOPIC)[0]).toMatchObject({ turn: "t9", context: CHAT, ok: true });
  });

  it("wait resolves with the outcome and rethrows the executor's own error", async () => {
    const w = new FakeWorld({ launchMs: 10 });
    w.primaries = true;
    const ok = await w.service.route(routed(w, [MC], true));
    expect(ok.text).toContain("開始玩");
    expect(w.published(NOTICE_TOPIC)).toHaveLength(0); // the waiting caller gets the answer
    const stop = await w.service.route(
      routed(w, [{ type: "stop", activity: "game" }], true, (run) =>
        w.run({
          capability: "game.stop",
          args: {},
          principal: Principals.self(CHAT),
          why: "",
          turn: null,
          task: run.task ?? "",
          signal: run.signal,
          primary: null,
        }),
      ),
    );
    expect(stop.text).toContain("停止");
    const failing = new Error("boom");
    failing.name = "GameError";
    await expect(
      w.service.route(
        routed(w, [MC], true, async () => {
          throw failing;
        }),
      ),
    ).rejects.toBe(failing);
  });
});
