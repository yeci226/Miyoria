// Module `stage.link`.

import { actuatorsFor } from "@miyoria/actions";
import { type CommandRegistry, CommandRegistryKey } from "@miyoria/commands";
import {
  defineManifest,
  errorMessage,
  HEALTHY,
  type Health,
  interval,
  type Module,
  type ModuleContext,
} from "@miyoria/kernel";
import { LlmRouterKey } from "@miyoria/llm";
import { SettingsStoreKey } from "@miyoria/store";
import {
  ACTIVITY_CHANGED_TOPIC,
  ActivityManagerKey,
  AFFECT_CHANGED_TOPIC,
  contextKeyString,
  type Envelope,
  isJsonObject,
  type JsonObject,
  Principals,
  parseSongCue,
  SceneRuleKey,
  SONG_PREPARE_TOPIC,
  SONG_TOPIC,
  SPEECH_PAUSE_TOPIC,
  SPEECH_SYNTH_TOPIC,
  StreamCurtainKey,
  VOICE_UPCOMING_TOPIC,
  v2Payload,
} from "@miyoria/types";
import { type BoundAddress, formatAddress, HttpServer, isLoopback } from "../net.js";
import { stageCapabilities } from "./actions.js";
import { ActivityTracker } from "./activity.js";
import { registerStreamCommands, unregisterStreamCommands } from "./commands.js";
import { MAX_MESSAGE } from "./conn.js";
import { type GoLiveState, SceneDirector } from "./director.js";
import { EMOTION_TOPIC, Forwarder, GIFT_TOPIC, SCREEN_TOPIC, SUBTITLE_TOPIC } from "./forward.js";
import { goliveFollow, VOICE_GOLIVE_TOPIC } from "./golive.js";
import {
  DEFAULT_BIND,
  StageLink,
  StageLinkConfigSchema,
  StageLinkError,
  StageLinkKey,
} from "./link.js";
import { SceneRoles, SceneRolesKey } from "./scenes.js";

/** Topic of the game director's session events (`{state: "started" | "stopped", game}`). */
export const GAME_SESSION_TOPIC = "game.director.session";

const GOLIVE_STATES: readonly GoLiveState[] = ["starting", "live", "stopped", "failed"];

/**
 * Feeds one bus event to the scene director. With the ActivityManager her situation comes from
 * its snapshots (`activity.changed`) and the director ignores the raw voice / Go Live / game /
 * song events below.
 */
function direct(director: SceneDirector, env: Envelope): void {
  const event = env.event;
  const snapshot = v2Payload(event, ACTIVITY_CHANGED_TOPIC);
  if (snapshot !== null) {
    director.onSnapshot(snapshot);
    return;
  }
  switch (event.type) {
    case "voice_joined":
    case "voice_participants":
      director.onVoice(contextKeyString(event.data.context), true);
      return;
    case "voice_left":
      director.onVoice(contextKeyString(event.data.context), false);
      return;
    case "voice_utterance":
    case "agent_turn_completed":
      director.onActivity();
      return;
    case "voice_playback":
      if (event.data.state === "started") director.onActivity();
      return;
    case "custom": {
      const { topic, payload } = event.data;
      const data = isJsonObject(payload) ? payload : {};
      if (topic === VOICE_GOLIVE_TOPIC) {
        const state = GOLIVE_STATES.find((s) => s === data.state);
        if (state) director.onGoLive(typeof data.guild === "string" ? data.guild : "", state);
      } else if (topic === GAME_SESSION_TOPIC) {
        director.onGame(data.state === "started", typeof data.game === "string" ? data.game : null);
      } else if (topic === SONG_TOPIC) {
        const cue = parseSongCue(payload);
        if (cue?.state === "started") director.onSong(true);
        else if (cue?.state === "ended") director.onSong(false);
      }
      return;
    }
    default:
      return;
  }
}

/** How often the activity line is re-evaluated (show delays, throttled progress, expiry). */
const ACTIVITY_TICK_MS = 250;

/** How long stop waits for the node to answer the close frame. */
const CLOSE_GRACE_MS = 2_000;

/** How often the Go Live follower retries OBS "Start Streaming" (the source may connect late). */
const GOLIVE_OBS_ATTEMPTS = 3;

interface Running {
  link: StageLink;
  registry: CommandRegistry | null;
  /** Unregisters `stage.scene` / `stage.stream`. */
  capabilities: (() => void)[];
  director: SceneDirector;
  unsubscribe: () => void;
}

/**
 * Module `stage.link`: serves the Stage Link WebSocket endpoint (`ws://<bind>/stage-link`),
 * forwards `agent.emotion`, `agent.turn.completed` and `voice.playback` to the Stage node, tells
 * it what she is doing (`activity`, see activity.ts) and provides `StageLinkKey`. Registers the
 * capabilities `stage.scene`, `stage.stream` and `stage.expression` in the actuator registry, and the `stream`
 * commands (which go through it) when `CommandRegistryKey` is available.
 */
export class StageLinkModule implements Module {
  static readonly ID = "stage.link";
  static readonly DEFAULT_BIND = DEFAULT_BIND;

  readonly manifest = defineManifest(StageLinkModule.ID, "Stage Link", {
    description: "WebSocket link to the Stage node (VTube Studio, OBS, overlay)",
    optional: ["commands"],
    configSchema: StageLinkConfigSchema,
  });

  #localAddr: BoundAddress | null = null;
  #running: Running | null = null;

  /** The address the server is bound to while running (useful with port 0). */
  localAddr(): BoundAddress | null {
    return this.#localAddr;
  }

  async start(ctx: ModuleContext): Promise<void> {
    const config = ctx.config(StageLinkConfigSchema);
    if (config.token.trim() === "") {
      throw new StageLinkError(
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the TOML interpolation syntax
        '`[modules."stage.link"] token` is empty: set the STAGE_LINK_TOKEN environment variable (with `token = "${STAGE_LINK_TOKEN}"`)',
      );
    }
    const link = new StageLink(ctx.id, ctx.bus, config, ctx.signal);
    const server = await HttpServer.listen(config.bind, "stage link", {
      ws: [{ path: "/stage-link", maxPayload: MAX_MESSAGE, onConnection: (ws) => link.serve(ws) }],
    });
    const addr = server.address;
    if (!isLoopback(addr.host)) {
      ctx.log.warn(
        { addr: formatAddress(addr) },
        "stage link is reachable from the network over plain WebSocket",
      );
    }
    this.#localAddr = addr;
    ctx.log.info({ addr: formatAddress(addr) }, "stage link listening");
    ctx.provide(StageLinkKey, link);

    // Scene roles and the director that switches between them (through the gate).
    const actuators = actuatorsFor(ctx);
    const roles = new SceneRoles(config.scenes, {
      settings: () => ctx.services.get(SettingsStoreKey),
      router: () => ctx.services.get(LlmRouterKey),
      signal: ctx.signal,
    });
    await roles.load();
    const switchTo = async (args: JsonObject, why: string): Promise<boolean> => {
      const outcome = await actuators.invoke({
        principal: Principals.director(null),
        capability: "stage.scene",
        args,
        why,
        turn: null,
      });
      if (outcome.status === "denied") {
        ctx.log.debug(
          { ...args, reason: outcome.decision.reason },
          "the gate refused a scene switch",
        );
      } else if (outcome.status === "failed") {
        ctx.log.warn({ ...args, err: outcome.error }, "scene switch failed");
      }
      return outcome.status === "done";
    };
    const director = new SceneDirector({
      config: config.scenes,
      roles,
      clock: ctx.clock,
      switchRole: (role, why) => switchTo({ role }, why),
      switchScene: (name, why) => switchTo({ name }, why),
    });
    const manager = ctx.services.get(ActivityManagerKey);
    if (manager) director.onSnapshot(manager.snapshot());
    // A song's video plays in the sing scene when the director goes there, else in the current one.
    const forwarder = new Forwarder(config.subtitle_text_turns, {
      singScene: () => (config.scenes.director ? roles.resolve("sing") : null),
      now: () => ctx.clock.now(),
    });
    const activity = new ActivityTracker({ textTurns: config.subtitle_text_turns });
    const sendActivity = (): void => {
      if (!link.isConnected()) return;
      const msg = activity.next(ctx.clock.now());
      if (msg) link.send(msg);
    };
    let nodeUp = false;
    const unsubscribe = link.subscribeStatus((status) => {
      if (status) roles.observe(status.scenes);
      // Her override may be newer than the last `activity.changed` the director saw.
      const current = ctx.services.get(ActivityManagerKey)?.snapshot();
      if (current) director.onSnapshot(current);
      director.onStatus(status);
      // A node that (re)connects mid-song picks the video up where the song is, and is told
      // what she is doing.
      if (status && !nodeUp) {
        const resume = forwarder.resumeSongVideo();
        if (resume) link.send(resume);
        const resting = forwarder.resumeResting();
        if (resting) link.send(resting);
        const current = activity.resume(ctx.clock.now());
        if (current) link.send(current);
      }
      nodeUp = status !== null;
    });
    ctx.provide(SceneRolesKey, roles);
    ctx.provide(StreamCurtainKey, director);
    // The ActivityManager's `snapshot().scene` is this rule's answer.
    ctx.provide(SceneRuleKey, director);

    const events = ctx.subscribe([
      EMOTION_TOPIC,
      AFFECT_CHANGED_TOPIC,
      SUBTITLE_TOPIC,
      GIFT_TOPIC,
      SCREEN_TOPIC,
      SONG_TOPIC,
      SPEECH_PAUSE_TOPIC,
      "agent.turn.started",
      "agent.turn.completed",
      "voice.playback",
      SPEECH_SYNTH_TOPIC,
      VOICE_UPCOMING_TOPIC,
      SONG_PREPARE_TOPIC,
      VOICE_GOLIVE_TOPIC,
      GAME_SESSION_TOPIC,
      ACTIVITY_CHANGED_TOPIC,
      "voice.joined",
      "voice.left",
      "voice.participants",
      "voice.utterance",
    ]);
    ctx.spawn("forward", async (signal) => {
      // Follow the voice node's Go Live with OBS (see golive.ts). Timers are cleared on stop.
      let goliveTimer: ReturnType<typeof setTimeout> | undefined;
      let wantStreaming = false;
      let attempts = 0;

      const clearTimer = (): void => {
        if (goliveTimer !== undefined) clearTimeout(goliveTimer);
        goliveTimer = undefined;
      };

      const stopObs = async (): Promise<void> => {
        if (!link.isConnected()) return;
        try {
          await link.stream("stop");
        } catch (error) {
          ctx.log.warn({ err: errorMessage(error) }, "could not stop OBS after Go Live ended");
        }
      };

      const startObs = async (): Promise<void> => {
        goliveTimer = undefined;
        if (!wantStreaming || signal.aborted || !link.isConnected()) return;
        attempts += 1;
        try {
          const status = await link.stream("start");
          if (status.streaming) {
            ctx.log.info("OBS is streaming for Go Live");
            return;
          }
          ctx.log.warn({ attempt: attempts }, "OBS did not start streaming for Go Live");
        } catch (error) {
          ctx.log.warn(
            { err: errorMessage(error), attempt: attempts },
            "could not start OBS for Go Live",
          );
        }
        if (wantStreaming && !signal.aborted && attempts < GOLIVE_OBS_ATTEMPTS) {
          goliveTimer = setTimeout(
            () => void startObs(),
            Math.max(config.golive_start_delay_ms, 1_000),
          );
          goliveTimer.unref?.();
        }
      };

      const followGoLive = (payload: unknown): void => {
        if (!config.golive_obs) return;
        // With the ActivityManager OBS is a sub-step of its broadcast (through the gate).
        if (ctx.services.get(ActivityManagerKey)) return;
        const action = goliveFollow(isJsonObject(payload) ? payload.state : undefined);
        if (action === null) return;
        clearTimer();
        if (action === "stop") {
          wantStreaming = false;
          void stopObs();
          return;
        }
        wantStreaming = true;
        attempts = 0;
        goliveTimer = setTimeout(() => void startObs(), config.golive_start_delay_ms);
        goliveTimer.unref?.();
      };

      try {
        for await (const env of events) {
          direct(director, env);
          activity.onEvent(env.event, ctx.clock.now());
          if (env.event.type === "custom" && env.event.data.topic === GAME_SESSION_TOPIC) continue;
          if (env.event.type === "custom" && env.event.data.topic === ACTIVITY_CHANGED_TOPIC) {
            continue;
          }
          if (env.event.type === "custom" && env.event.data.topic === VOICE_GOLIVE_TOPIC) {
            followGoLive(env.event.data.payload);
            continue;
          }
          for (const msg of forwarder.onEvent(env.event)) {
            if (!link.send(msg) && link.isConnected()) {
              ctx.log.debug("stage node queue full, dropping a message");
            }
          }
          sendActivity();
        }
      } finally {
        wantStreaming = false;
        clearTimer();
      }
    });

    ctx.spawn("activity", async (signal) => {
      for await (const _ of interval(ACTIVITY_TICK_MS, signal)) sendActivity();
    });

    const capabilities = stageCapabilities(link, {
      roles,
      curtain: director,
      overrideMs: config.scenes.manual_hold_ms,
    }).map((c) => actuators.register(c));
    const registry = ctx.services.get(CommandRegistryKey) ?? null;
    try {
      if (registry) registerStreamCommands(registry, link, actuators);
    } catch (error) {
      for (const unregister of capabilities) unregister();
      unsubscribe();
      director.stop();
      await server.close();
      throw error;
    }
    this.#running = { link, registry, capabilities, director, unsubscribe };

    ctx.spawn("server", async (signal) => {
      await new Promise<void>((resolve, reject) => {
        server.server.once("error", reject);
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      await server.close(CLOSE_GRACE_MS);
    });
  }

  async stop(): Promise<void> {
    this.#localAddr = null;
    const running = this.#running;
    this.#running = null;
    if (!running) return;
    if (running.registry) unregisterStreamCommands(running.registry);
    for (const unregister of running.capabilities) unregister();
    running.unsubscribe();
    running.director.stop();
    running.link.closeAll();
  }

  async health(): Promise<Health> {
    const link = this.#running?.link;
    if (link && !link.isConnected())
      return { status: "degraded", reason: "stage node not connected" };
    return HEALTHY;
  }
}
