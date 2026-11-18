// Module `stage.link`.

import { type CommandRegistry, CommandRegistryKey } from "@miyoria/commands";
import { actuatorsFor } from "@miyoria/gate/actions";
import { LlmRouterKey } from "@miyoria/llm/llm";
import {
  defineManifest,
  errorMessage,
  HEALTHY,
  type Health,
  interval,
  type Module,
  type ModuleContext,
} from "@miyoria/runtime/kernel";
import { SettingsStoreKey } from "@miyoria/store";
import {
  ActivityManagerKey,
  contextKeyString,
  type Envelope,
  Events,
  is,
  isJsonObject,
  type JsonObject,
  type JsonValue,
  Principals,
  parseSongCue,
  SceneRuleKey,
  StreamCurtainKey,
} from "@miyoria/types";
import { type BoundAddress, formatAddress, HttpServer, isLoopback } from "../net.js";
import { TOUCH_TOPIC } from "../touch.js";
import { stageCapabilities } from "./actions.js";
import { ActivityTracker } from "./activity.js";
import { registerStreamCommands, unregisterStreamCommands } from "./commands.js";
import { MAX_MESSAGE } from "./conn.js";
import { type GoLiveState, SceneDirector } from "./director.js";
import {
  DANMAKU_CLEAR_TOPIC,
  DANMAKU_TOPIC,
  danmakuMessage,
  EMOTION_TOPIC,
  Forwarder,
  GIFT_TOPIC,
  SCREEN_TOPIC,
} from "./forward.js";
import { goliveFollow, VOICE_GOLIVE_TOPIC } from "./golive.js";
import { Highlights } from "./highlights.js";
import {
  DEFAULT_BIND,
  StageLink,
  StageLinkConfigSchema,
  StageLinkError,
  StageLinkKey,
} from "./link.js";
import { SceneRoles, SceneRolesKey } from "./scenes.js";

/** Topic of the game director's session events (`{state: "started" | "stopped", game}`). */
export const GAME_SESSION_TOPIC = Events.GameDirectorSession.type;

/** WebSocket path of the endpoint. */
export const STAGE_LINK_PATH = "/stage-link";

const GOLIVE_STATES: readonly GoLiveState[] = ["starting", "live", "stopped", "failed"];

/**
 * Feeds one bus event to the scene director. With the ActivityManager her situation comes from
 * its snapshots (`activity.changed`) and the director ignores the raw voice / Go Live / game /
 * song events below.
 */
function direct(director: SceneDirector, env: Envelope): void {
  if (is(Events.ActivityChanged, env)) {
    // Read only with an object payload, as before.
    if (isJsonObject(env.data as JsonValue)) director.onSnapshot(env.data);
    return;
  }
  if (is(Events.VoiceJoined, env) || is(Events.VoiceParticipants, env)) {
    director.onVoice(contextKeyString(env.data.context), true);
    return;
  } else if (is(Events.VoiceLeft, env)) {
    director.onVoice(contextKeyString(env.data.context), false);
    return;
  } else if (is(Events.VoiceUtteranceEvent, env) || is(Events.AgentTurnCompleted, env)) {
    director.onActivity();
    return;
  } else if (is(Events.VoicePlaybackEvent, env)) {
    if (env.data.state === "started") director.onActivity();
    return;
  } else {
    const topic = env.type;
    const payload = env.data as JsonValue;
    const data = isJsonObject(payload) ? payload : {};
    if (topic === VOICE_GOLIVE_TOPIC) {
      const state = GOLIVE_STATES.find((s) => s === data.state);
      if (state) director.onGoLive(typeof data.guild === "string" ? data.guild : "", state);
    } else if (topic === GAME_SESSION_TOPIC) {
      director.onGame(data.state === "started", typeof data.game === "string" ? data.game : null);
    } else if (topic === Events.SingCue.type) {
      const cue = parseSongCue(payload);
      if (cue?.state === "started") director.onSong(true);
      else if (cue?.state === "ended") director.onSong(false);
    }
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
 * it what she is doing (`activity`, see activity.ts) and provides `StageLinkKey`. Danmaku lines
 * (`economy.danmaku`) go to the node, and how each ended comes back as `stage.danmaku`. Registers the
 * capabilities `stage.scene`, `stage.stream` and `stage.expression` in the actuator registry, and the `stream`
 * commands (which go through it) when `CommandRegistryKey` is available.
 */
export class StageLinkModule implements Module {
  static readonly ID = "stage.link";
  static readonly DEFAULT_BIND = DEFAULT_BIND;

  readonly manifest = defineManifest(StageLinkModule.ID, "Stage Link", {
    icon: "clapperboard",
    category: "platform",
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
      ws: [
        { path: STAGE_LINK_PATH, maxPayload: MAX_MESSAGE, onConnection: (ws) => link.serve(ws) },
      ],
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
    // Moments worth keeping, saved from OBS's replay buffer while she streams (highlights.ts).
    const highlights = new Highlights(config.highlights);
    const clip = (reason: string | null): void => {
      if (reason === null || link.status()?.streaming !== true) return;
      const timer = setTimeout(() => {
        link.clip(reason).catch((error: unknown) => {
          ctx.log.info({ err: errorMessage(error), reason }, "no highlight saved");
        });
      }, config.highlights.delay_ms);
      timer.unref?.();
    };
    const sendActivity = (): void => {
      if (!link.isConnected()) return;
      const msg = activity.next(ctx.clock.now());
      // A frame that could not go out is given again on the next tick, not taken as shown.
      if (msg && !link.send(msg)) activity.unsent();
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
        const beat = forwarder.resumeBeat();
        if (beat) link.send(beat);
        const resting = forwarder.resumeResting();
        if (resting) link.send(resting);
        for (const msg of forwarder.resumeKaraoke()) link.send(msg);
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
      Events.AffectChanged.type,
      GIFT_TOPIC,
      TOUCH_TOPIC,
      SCREEN_TOPIC,
      DANMAKU_TOPIC,
      DANMAKU_CLEAR_TOPIC,
      Events.SingCue.type,
      Events.KaraokeStage.type,
      Events.KaraokeStageLyrics.type,
      Events.KaraokeStageVoice.type,
      Events.SpeechPause.type,
      Events.AgentTurnStarted.type,
      Events.AgentTurnCompleted.type,
      Events.AgentToolRunning.type,
      Events.VoicePlaybackEvent.type,
      Events.VoiceSynthesis.type,
      Events.VoiceUpcoming.type,
      Events.SingPrepare.type,
      VOICE_GOLIVE_TOPIC,
      GAME_SESSION_TOPIC,
      Events.ActivityChanged.type,
      Events.VoiceJoined.type,
      Events.VoiceLeft.type,
      Events.VoiceParticipants.type,
      Events.VoiceUtteranceEvent.type,
      Events.PlatformMessageCreated.type,
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
          // The relayed karaoke voice (about four a second) only passes through: nothing else
          // looks at it, and nothing of it is logged.
          if (is(Events.KaraokeStageVoice, env)) {
            for (const msg of forwarder.onEvent(env)) link.send(msg);
            continue;
          }
          // Chat lines only count towards highlights (nothing of their text is used).
          if (is(Events.PlatformMessageCreated, env)) {
            if (!env.data.author.is_bot) clip(highlights.message(ctx.clock.now()));
            continue;
          }
          clip(highlights.onEvent(env, ctx.clock.now()));
          direct(director, env);
          activity.onEvent(env, ctx.clock.now());
          if (env.type === GAME_SESSION_TOPIC) continue;
          if (env.type === Events.ActivityChanged.type) continue;
          if (env.type === VOICE_GOLIVE_TOPIC) {
            followGoLive(env.data as JsonValue);
            continue;
          }
          if (env.type === DANMAKU_TOPIC) {
            // Every line is answered once: by the node, or here when it cannot go out.
            const line = danmakuMessage(env.data as JsonValue);
            if (line !== null) link.sendDanmaku(line.id, line.msg);
            continue;
          }
          for (const msg of forwarder.onEvent(env)) {
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
