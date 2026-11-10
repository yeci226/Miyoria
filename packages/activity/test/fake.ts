// A fake outside world for the manager: capabilities that change it and publish what the real
// modules publish (`voice.joined`, `voice.golive`, `stage.status`, `game.director.session`), with
// knobs for slow and failing steps.

import type { ActionResult } from "@miyoria/actions";
import {
  type ActivityTransition,
  type ContextKey,
  customEvent,
  type Event,
  type JsonObject,
  newEnvelope,
  type Principal,
  Principals,
  v2Payload,
} from "@miyoria/types";
import { type ActivityConfig, defaultActivityConfig } from "../src/config.js";
import { ActivityService } from "../src/manager.js";
import type { ActivityPort, StepCall } from "../src/port.js";
import { StepError } from "../src/port.js";

export const GUILD = "g1";
export const CHAT: ContextKey = {
  platform: "discord",
  scope: GUILD,
  channel: "c1",
  kind: "channel",
};
export const OWEN = { platform: "discord", id: "100" };

export function voiceCtx(guild: string, channel: string): ContextKey {
  return { platform: "discord", scope: guild, channel, kind: "voice" };
}

/** Resolves after pending microtasks and `ms` of (fake or real) time. */
export const tick = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));

export interface FakeOptions {
  /** Delay of each world reaction (ms). */
  latency?: number;
  /** `game.start` takes this long (the launch). */
  launchMs?: number;
  obs?: boolean;
  stage?: boolean;
  config?: Partial<ActivityConfig>;
}

export class FakeWorld implements ActivityPort {
  readonly calls: StepCall[] = [];
  readonly events: Event[] = [];
  readonly service: ActivityService;
  latency: number;
  launchMs: number;
  /** Fail the next call of these capabilities with this error. */
  readonly failNext = new Map<string, Error>();
  /** Go Live reports `failed` instead of `live`. */
  goliveFails: string | null = null;
  /** OBS does not start streaming. */
  obsStuck = false;
  /** Go Live waits for OBS's video before it is `live`, like the node's ffmpeg listener. */
  liveNeedsObs = false;
  /** Go Live stays `starting`, whatever OBS does. */
  goliveHangs = false;
  /** The director publishes `game.director.session` when a game starts. */
  sessionEvent = true;
  /** Capabilities that are not registered. */
  readonly missing = new Set<string>();
  /** Run primary steps through the routed call's executor (router tests). */
  primaries = false;
  /** Called with everything the manager publishes. */
  readonly listeners: ((event: Event) => void)[] = [];
  /** Shown before OBS stops (the stage's ending scene). */
  curtain: (() => Promise<void>) | null = null;

  voice = new Map<string, string>();
  golive = new Map<string, string>();
  obsStreaming = false;
  obs: boolean;
  stage: boolean;
  session: string | null = null;
  scene: string | null = null;
  /** Started game sessions (to catch double starts). */
  starts = 0;

  constructor(options: FakeOptions = {}) {
    this.latency = options.latency ?? 5;
    this.launchMs = options.launchMs ?? 20;
    this.obs = options.obs ?? true;
    this.stage = options.stage ?? true;
    this.service = new ActivityService({
      port: this,
      config: { ...defaultActivityConfig(), obs_start_delay_ms: 10, ...(options.config ?? {}) },
      publish: (e) => {
        this.events.push(e);
        for (const listen of this.listeners) listen(e);
      },
    });
    this.#stageStatus();
  }

  has(capability: string): boolean {
    return !this.missing.has(capability);
  }

  emit(event: Event): void {
    this.service.observe(newEnvelope("fake", event));
  }

  #later(fn: () => void): void {
    setTimeout(fn, this.latency);
  }

  #stageStatus(): void {
    this.emit(
      customEvent(
        "stage.status",
        this.stage
          ? { connected: true, obs: this.obs, streaming: this.obsStreaming, scene: this.scene }
          : { connected: false },
      ),
    );
  }

  setObs(obs: boolean): void {
    this.obs = obs;
    this.#stageStatus();
  }

  async run(call: StepCall): Promise<ActionResult> {
    // A routed capability's own executor (tests of the router pass one).
    if (call.primary !== null && this.primaries) {
      return call.primary({ signal: call.signal, task: call.task });
    }
    this.calls.push(call);
    const fail = this.failNext.get(call.capability);
    if (fail) {
      this.failNext.delete(call.capability);
      throw fail;
    }
    const args = call.args as JsonObject;
    const guild = typeof args.guild === "string" ? args.guild : GUILD;
    switch (call.capability) {
      case "voice.join": {
        const channel = typeof args.channel === "string" ? args.channel : "v1";
        await tick(this.latency);
        this.voice.set(guild, channel);
        this.emit({
          type: "voice_joined",
          data: { context: voiceCtx(guild, channel), participants: [] },
        });
        return { text: `joined ${channel}`, data: { channel } };
      }
      case "voice.leave": {
        const channel = this.voice.get(guild);
        if (channel === undefined) return { text: "not in voice", data: { left: false } };
        this.#later(() => {
          this.voice.delete(guild);
          this.emit({
            type: "voice_left",
            data: { context: voiceCtx(guild, channel), reason: null },
          });
        });
        return { text: "left", data: { left: true } };
      }
      case "stream.start": {
        if (!this.voice.has(guild)) {
          await tick(this.latency);
          this.voice.set(guild, "v1");
          this.emit({
            type: "voice_joined",
            data: { context: voiceCtx(guild, "v1"), participants: [] },
          });
        }
        if (this.golive.get(guild) === "live")
          return { text: "already live", data: { already: true } };
        this.golive.set(guild, "starting");
        this.emit(
          customEvent("voice.golive", { guild, state: "starting", error: null, reason: null }),
        );
        this.#later(() => {
          if (this.golive.get(guild) !== "starting") return;
          if (this.liveNeedsObs || this.goliveHangs) return;
          const failed = this.goliveFails;
          if (failed !== null) {
            this.golive.delete(guild);
            this.emit(
              customEvent("voice.golive", { guild, state: "failed", error: failed, reason: null }),
            );
            return;
          }
          this.golive.set(guild, "live");
          this.emit(
            customEvent("voice.golive", { guild, state: "live", error: null, reason: null }),
          );
        });
        return { text: "Go Live started", data: { already: false } };
      }
      case "stream.stop": {
        if (!this.golive.has(guild)) return { text: "not live", data: { stopped: false } };
        this.#later(() => {
          this.golive.delete(guild);
          this.emit(
            customEvent("voice.golive", { guild, state: "stopped", error: null, reason: null }),
          );
        });
        return { text: "Go Live stopped", data: { stopped: true } };
      }
      case "stage.stream": {
        if (!this.stage) throw new StepError("precondition", "the stage node is not connected");
        if (!this.obs) throw new Error("OBS is not connected");
        if (args.action === "stop") await this.curtain?.();
        await tick(this.latency);
        if (args.action === "start" && !this.obsStuck) this.obsStreaming = true;
        if (args.action === "stop") this.obsStreaming = false;
        this.#stageStatus();
        if (this.liveNeedsObs && this.obsStreaming) {
          for (const [g, state] of this.golive) {
            if (state !== "starting") continue;
            this.golive.set(g, "live");
            this.emit(
              customEvent("voice.golive", { guild: g, state: "live", error: null, reason: null }),
            );
          }
        }
        return {
          text: `OBS stream ${String(args.action)}`,
          data: { streaming: this.obsStreaming },
        };
      }
      case "stage.scene": {
        this.scene = String(args.name ?? args.role ?? "?");
        return { text: `switched to ${this.scene}`, data: null };
      }
      case "game.start": {
        const game = String(args.game);
        if (this.session !== null)
          throw Object.assign(new Error(`已經在玩 ${this.session}`), { name: "GameError" });
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, this.launchMs);
          call.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(call.signal.reason);
            },
            { once: true },
          );
        });
        this.session = game;
        this.starts += 1;
        if (this.sessionEvent)
          this.emit(
            customEvent("game.director.session", {
              state: "started",
              game,
              game_name: game === "minecraft" ? "Minecraft" : game,
              context: null,
            }),
          );
        return {
          text: `她開始玩 ${game} 了`,
          data: {
            session: {
              game,
              game_name: game === "minecraft" ? "Minecraft" : game,
              context: null,
            },
          },
        };
      }
      case "game.stop": {
        const game = this.session;
        if (game === null)
          throw Object.assign(new Error("她目前沒有在玩遊戲。"), { name: "GameError" });
        this.session = null;
        this.emit(
          customEvent("game.director.session", { state: "stopped", game, game_name: game }),
        );
        return { text: `她已停止玩 ${game}。`, data: null };
      }
      default:
        throw new StepError("precondition", `unknown capability ${call.capability}`);
    }
  }

  /** The game disconnects on its own (the director ends the session). */
  disconnect(): void {
    const game = this.session;
    if (game === null) return;
    this.session = null;
    this.emit(
      customEvent("game.director.session", {
        state: "stopped",
        game,
        game_name: "Minecraft",
        reason: "遊戲斷線了",
        code: "disconnected",
      }),
    );
  }

  transition(
    request: ActivityTransition["request"],
    principal: Principal = Principals.user(OWEN, CHAT),
  ): ActivityTransition {
    return { request, principal, turn: null, context: CHAT, why: "test" };
  }

  /** Payloads of a v2 topic published so far. */
  published<T extends Parameters<typeof v2Payload>[1]>(topic: T) {
    return this.events.map((e) => v2Payload(e, topic)).filter((p) => p !== null);
  }

  /** Calls of `capability` so far. */
  count(capability: string): number {
    return this.calls.filter((c) => c.capability === capability).length;
  }
}

/** Waits until `check()` holds (real or fake timers advance `step` ms per round). */
export async function until(check: () => boolean, rounds = 400, step = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    if (check()) return;
    await tick(step);
  }
  throw new Error("condition not reached");
}
