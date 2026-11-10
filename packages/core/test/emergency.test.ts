// The emergency stop on the real pieces: the gate, the ActivityManager, the scheduler and the voice
// sink with a fake voice node. Only the outside world is fake. This is the proof that the stop works
// with the pause on: the same tools in her own hands are refused.

import {
  ActionsModule,
  ActuatorRegistry,
  ActuatorRegistryKey,
  defineCapability,
} from "@miyoria/actions";
import { ActivityModule } from "@miyoria/activity";
import { CommandsModule } from "@miyoria/commands";
import { defineManifest, type Module, type ModuleContext } from "@miyoria/kernel";
import { SchedulerModule } from "@miyoria/scheduler";
import {
  type AudioChunk,
  type AudioStream,
  SpeechService,
  SpeechServiceKey,
  type TtsProvider,
} from "@miyoria/speech";
import {
  ActionSinkKey,
  ActivityManagerKey,
  ActuatorExecutorKey,
  type ContextKey,
  customEvent,
  newAction,
  newId,
  Principals,
  voiceLane,
} from "@miyoria/types";
import { VoiceModule } from "@miyoria/voice";
import { afterEach, describe, expect, it } from "vitest";
import {
  deepseekVoice,
  Harness,
  type Node,
  nextEvent,
  SELF_ID,
  waitUntil,
} from "../../voice/test/harness.js";

const GUILD = "g1";
const VOICE: ContextKey = { platform: "discord", scope: GUILD, channel: "vc1", kind: "voice" };

/** The schema of a capability that takes anything (this package has no `zod` of its own). */
const noArgs = { safeParse: (data: unknown) => ({ success: true, data }) } as never;

/** What the bus would say once a capability had its effect. */
class World implements Module {
  readonly manifest = defineManifest("world.fake", "fake world");
  ctx: ModuleContext | null = null;

  async start(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;
  }

  session(state: "started" | "stopped"): void {
    this.ctx?.publish(
      customEvent("game.director.session", {
        state,
        game: "minecraft",
        game_name: "Minecraft",
        context: { ...VOICE },
      }),
    );
  }
}

class Tts implements TtsProvider {
  readonly name = "fake-tts";

  async synthesize(): Promise<AudioStream> {
    const chunks: AudioChunk[] = [{ sampleRate: 24_000, samples: new Int16Array(2400).fill(100) }];
    return (async function* () {
      yield* chunks;
      await new Promise(() => undefined);
    })();
  }
}

class FakeSpeech implements Module {
  readonly manifest = defineManifest("speech", "Fake speech");

  async start(ctx: ModuleContext): Promise<void> {
    ctx.provide(SpeechServiceKey, new SpeechService([], [new Tts()]));
  }
}

let stack: Harness | null = null;

afterEach(async () => {
  await stack?.stop();
  stack = null;
});

/** The voice node while she stops: answers what Core asks of it, and remembers what that was. */
async function serve(node: Node, answerLeave = true): Promise<string[]> {
  const seen: string[] = [];
  for (;;) {
    const message = await node.recv();
    if (message.kind !== "text") continue;
    const { type } = JSON.parse(message.text) as { type: string };
    seen.push(type);
    if (type === "golive_stop") {
      node.sendJson({ type: "golive", guild: GUILD, state: "stopped", reason: "stop requested" });
    }
    if (type === "leave") {
      if (answerLeave) node.sendJson({ type: "left", guild: GUILD });
      return seen;
    }
  }
}

async function rig() {
  const world = new World();
  const ran: string[] = [];
  const h = await Harness.start(
    {},
    [
      [new CommandsModule({ owners: ["discord:1"] }), null],
      [new ActionsModule("DeepSeek-chan"), { emergency_step_ms: 1000 }],
      [new ActivityModule(), null],
      [world, null],
      [new FakeSpeech(), null],
      [new SchedulerModule(), null],
      [new VoiceModule("deepseek-chan", deepseekVoice()), { barge_in: "ignore" }],
    ],
    (services) => {
      const registry = new ActuatorRegistry({ services, builtins: false });
      services.provide("app", ActuatorRegistryKey, registry);
      services.provide("app", ActuatorExecutorKey, registry);
      registry.register(
        defineCapability({
          name: "game.stop",
          summary: "stops the game",
          risk: "low",
          args: noArgs,
          permission: null,
          async execute() {
            ran.push("game.stop");
            world.session("stopped");
            return "ok";
          },
        }),
      );
    },
  );
  stack = h;
  const node: Node = await h.node(SELF_ID, ["play_duck", "play_pause"]);
  node.sendJson({
    type: "voice_state",
    guild: GUILD,
    channel: "vc1",
    participants: [{ user_id: SELF_ID, display_name: "DeepSeek-chan", is_self: true }],
  });
  node.sendJson({ type: "joined", guild: GUILD, channel: "vc1" });
  const link = h.link();
  await waitUntil(() => link.participants(GUILD).length === 1);
  node.sendJson({ type: "golive", guild: GUILD, state: "live" });
  world.session("started");
  const manager = h.services.require(ActivityManagerKey);
  await waitUntil(() => {
    const s = manager.snapshot();
    return s.presence.type === "in" && s.broadcast.type !== "off" && s.activity.type === "game";
  });
  const registry = h.services.require(ActuatorRegistryKey);
  return { h, world, ran, node, manager, registry };
}

const lane = voiceLane("discord", GUILD);
const line = (text: string, turn = newId()) =>
  newAction(lane, "direct", { type: "speak", context: VOICE, text, emotion: null }, { turn });

describe("the stop, for real", () => {
  it("cuts her off mid-sentence, drops what was queued, and ends stream, voice and game", async () => {
    const { h, node, registry, manager, ran } = await rig();
    const actions = h.services.require(ActionSinkKey);
    await actions.submit(line("第一句說很久"));
    await actions.submit(line("第二句排隊中"));
    const start = await node.recvType("play_start");
    node.sendJson({ type: "playback", play: start.play as number, state: "started" });

    const [report, seen] = await Promise.all([
      registry.emergency.stop("panel:test", "test"),
      serve(node),
    ]);
    expect(seen).toEqual(["play_stop", "golive_stop", "leave"]);
    expect(report.steps.map((s) => [s.step, s.ok])).toEqual([
      ["pause", true],
      ["silence", true],
      ["song", true],
      ["stream", true],
      ["voice", true],
      ["game", true],
    ]);
    expect(ran).toEqual(["game.stop"]);
    const snapshot = manager.snapshot();
    expect(snapshot.broadcast.type).toBe("off");
    expect(snapshot.presence.type).toBe("none");
    expect(snapshot.activity.type).not.toBe("game");
    expect(registry.emergency.last).toBe(report);
  });

  it("the tools she would use herself are refused while it is on; the panel's are not", async () => {
    const { registry } = await rig();
    await registry.setPaused(true);
    const request = { capability: "game.stop", args: {}, why: null, turn: null };
    const hers = await registry.invoke({ ...request, principal: Principals.self(VOICE) });
    expect(hers).toMatchObject({ status: "denied", decision: { stage: "pause" } });
    const panel = await registry.invoke({ ...request, principal: Principals.panel("test") });
    expect(panel.status).toBe("done");
  });

  it("a step that fails is told, the game still stops", async () => {
    const { registry, manager, node } = await rig();
    const [report] = await Promise.all([
      registry.emergency.stop("panel:test", "test"),
      serve(node, false),
    ]);
    expect(report.steps.find((s) => s.step === "stream")?.ok).toBe(true);
    expect(report.steps.find((s) => s.step === "voice")).toMatchObject({
      ok: false,
      detail: expect.stringContaining("逾時"),
    });
    expect(report.steps.find((s) => s.step === "game")?.ok).toBe(true);
    expect(manager.snapshot().activity.type).not.toBe("game");
    expect(registry.paused).toBe(true);
  });

  it("while it is on nothing of hers goes out; after resume it does", async () => {
    const { h, node, registry } = await rig();
    await Promise.all([registry.emergency.stop("panel:test", "test"), serve(node)]);
    const completed = h.subscribe(["action.completed"]);
    const actions = h.services.require(ActionSinkKey);
    await actions.submit(line("還在講話"));
    const muted = (await nextEvent(completed)).event;
    expect(muted).toMatchObject({ type: "action_completed", data: { ok: false, error: "muted" } });

    await registry.emergency.resume("panel:test");
    node.sendJson({ type: "joined", guild: GUILD, channel: "vc1" });
    await actions.submit(line("回來了"));
    const start = await node.recvType("play_start");
    expect(start.guild).toBe(GUILD);
  });
});

describe("cutting one line short (§7.3)", () => {
  it("`interruptTurn` stops the audio through the abort signal and reports it as cut", async () => {
    const { h, node } = await rig();
    const actions = h.services.require(ActionSinkKey);
    const playback = h.subscribe(["voice.playback"]);
    const turn = newId();
    await actions.submit(line("這句會被切掉", turn));
    const start = await node.recvType("play_start");
    node.sendJson({ type: "playback", play: start.play as number, state: "started" });
    await new Promise((resolve) => setTimeout(resolve, 60));
    await actions.interruptTurn?.(turn);
    expect(await node.recvType("play_stop")).toMatchObject({ play: start.play });
    for (;;) {
      const event = (await nextEvent(playback)).event;
      if (event.type !== "voice_playback" || event.data.state === "started") continue;
      expect(event.data).toMatchObject({ state: "interrupted", turn, text: "這句會被切掉" });
      expect(event.data.heard_ms).toBeGreaterThanOrEqual(40);
      break;
    }
  });
});
