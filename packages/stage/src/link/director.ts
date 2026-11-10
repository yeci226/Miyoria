// The scene director: switches OBS to the scene of her current situation.
//
//   going live           → starting (for `starting_ms`), then chat
//   a game starts        → game;  the game stops → chat
//   live, nobody talking for `brb_after_ms`, or she left voice → brb (back when it ends)
//   she sings a song     → sing (its video plays there); the song ends → back to the scene
//                          before it, unless her situation changed meanwhile (then what fits)
//   her `stage.scene`    → that scene for as long as she asked (a timed override, not a fight)
//   the stream is ending → ending (held `ending_ms` before the stream stops, see `close`)
//
// Which scene fits is a pure function (`scene-rule.ts`): f(presence, broadcast, activity, her
// override) plus the few windows only the stage knows. With the ActivityManager the director
// reads her situation from its snapshot (`onSnapshot`), the one copy everyone else reads too;
// without it, from the bus events as before (`onGoLive`, `onGame`, `onVoice`, `onSong`).
//
// A role without a scene is skipped for the next one that fits (going live without a starting
// scene goes to chat, or stays on the game scene while she plays).
//
// It only reacts to changes (it never "corrects" the scene at boot), coalesces changes within
// `debounce_ms`, keeps `min_switch_ms` between switches and stays out of the way for
// `manual_hold_ms` after someone else switched in OBS. Starting, ending, songs and her override
// are urgent: they skip the waits. Every switch is a `stage.scene` request through the gate
// (principal `director`), so pausing her autonomy also pauses the director. Its switches (and
// the curtain's) run one at a time under one mutex, and the scene it expects is only written
// inside it, so its own switch is never mistaken for a manual one.

import { getLogger, SerialQueue, sleep } from "@miyoria/kernel";
import {
  type ActivitySnapshot,
  type Clock,
  type SceneRule,
  type SceneRuleInput,
  type StreamCurtain,
  systemClock,
} from "@miyoria/types";
import {
  away,
  factsOf,
  NO_FACTS,
  pickScene,
  type SceneFacts,
  type SceneMemory,
  sceneWants,
  type Want,
} from "./scene-rule.js";
import type { SceneRoles, ScenesConfig } from "./scenes.js";

const log = getLogger("stage.director");

/** `voice.golive` states. */
export type GoLiveState = "starting" | "live" | "stopped" | "failed";

/** Asks the gate to switch to `role`'s scene; resolves whether it switched. */
export type RoleSwitcher = (role: string, why: string) => Promise<boolean>;

/** Asks the gate to switch to scene `name`; resolves whether it switched. */
export type SceneSwitcher = (name: string, why: string) => Promise<boolean>;

export interface SceneDirectorDeps {
  config: ScenesConfig;
  roles: SceneRoles;
  switchRole: RoleSwitcher;
  /** Going back to the scene before a song, her override (without it: that scene's role). */
  switchScene?: SceneSwitcher;
  clock?: Clock;
}

export class SceneDirector implements StreamCurtain, SceneRule {
  readonly #config: ScenesConfig;
  readonly #roles: SceneRoles;
  readonly #switchRole: RoleSwitcher;
  readonly #switchScene: SceneSwitcher | null;
  readonly #clock: Clock;

  /** Her situation (from the snapshot, or rebuilt from the bus without the manager). */
  #facts: SceneFacts = { ...NO_FACTS };
  /** Fed from the ActivityManager's snapshots: the bus inputs below are ignored. */
  #managed = false;

  // Bus inputs (without the ActivityManager).
  readonly #golive = new Map<string, GoLiveState>();
  #obsStreaming = false;
  readonly #voices = new Set<string>();

  /** Bumped when her situation changes (a game, going live or off); see `onSong`. */
  #situation = 0;
  /** When the song started: the scene shown and the situation. */
  #beforeSong: { scene: string | null; situation: number } | null = null;
  /** The sing scene the director switched to for the current song. */
  #singScene: string | null = null;
  #memory: SceneMemory;

  #scene: string | null = null;
  /** The scene of the director's switch in flight (only written under `#mutex`). */
  #expect: string | null = null;
  #lastSwitch = Number.NEGATIVE_INFINITY;
  #manualUntil = 0;

  /** Every switch of the director and the curtain, one at a time. */
  readonly #mutex = new SerialQueue();
  #timer: ReturnType<typeof setTimeout> | null = null;
  #due: number | null = null;
  #urgent = false;
  #busy = false;
  #again = false;
  #closed = false;

  constructor(deps: SceneDirectorDeps) {
    this.#config = deps.config;
    this.#roles = deps.roles;
    this.#switchRole = deps.switchRole;
    this.#switchScene = deps.switchScene ?? null;
    this.#clock = deps.clock ?? systemClock;
    this.#memory = {
      ended: false,
      endingUntil: 0,
      returnTo: null,
      lastActivity: this.#now(),
      voiceThisLive: false,
    };
  }

  #now(): number {
    return this.#clock.now();
  }

  /** Streaming in OBS or live on Discord (or about to be). */
  live(): boolean {
    return this.#facts.live;
  }

  /** The role she should be in now and its scene, `null` = leave the scene alone. */
  desired(): (Want & { scene: string }) | null {
    const wants = sceneWants(
      this.#facts,
      this.#memory,
      this.#config,
      (scene) => this.#roles.roleOf(scene),
      this.#now(),
    );
    return pickScene(wants, (role) => this.#roles.resolve(role));
  }

  /**
   * `SceneRule` (`SceneRuleKey`): the scene for an ActivitySnapshot, with the director's own
   * windows (ending, brb, back after a song). What `ActivitySnapshot.scene` shows.
   */
  scene(input: SceneRuleInput, now: number): string | null {
    const wants = sceneWants(
      factsOf(input, now),
      this.#memory,
      this.#config,
      (scene) => this.#roles.roleOf(scene),
      now,
    );
    return pickScene(wants, (role) => this.#roles.resolve(role))?.scene ?? null;
  }

  // ----- inputs -----

  /**
   * The ActivityManager's snapshot (`activity.changed`): her presence, broadcast, activity and
   * override in one. From the first one on the bus inputs are ignored.
   */
  onSnapshot(snapshot: ActivitySnapshot): void {
    this.#managed = true;
    this.#apply(factsOf(snapshot, this.#now()));
  }

  /** `voice.golive` for `guild` (without the ActivityManager). */
  onGoLive(guild: string, state: GoLiveState): void {
    if (this.#managed) return;
    if (state === "stopped" || state === "failed") this.#golive.delete(guild);
    else this.#golive.set(guild, state);
    this.#applyBus();
  }

  /**
   * A stage status (`null`: the node is gone). Without OBS the streaming state is unknown, so it
   * is left as it was (a lost connection is not the end of the stream).
   */
  onStatus(status: { obs: boolean; streaming: boolean; scene: string | null } | null): void {
    if (status === null || !status.obs) {
      // The next scene seen after a reconnect is not a manual switch.
      this.#scene = null;
      return;
    }
    if (!this.#managed) {
      this.#obsStreaming = status.streaming;
      this.#applyBus();
    }
    const scene = status.scene;
    if (scene === null || scene === this.#scene) {
      if (scene !== null && scene === this.#expect) this.#expect = null;
      return;
    }
    const first = this.#scene === null;
    this.#scene = scene;
    if (scene === this.#expect) {
      this.#expect = null;
    } else if (scene === this.#facts.override?.scene) {
      // Her override: wanted, not someone else's switch.
    } else if (!first) {
      // Someone else switched: stay out of the way for a while.
      this.#manualUntil = this.#now() + this.#config.manual_hold_ms;
      log.debug({ scene }, "scene switched by someone else; holding");
    }
    // A node that connects late (a song started before it was there, 2026-11-08) gets the scene
    // that cannot wait now, not at the next change.
    if (first && this.desired()?.urgent === true) this.#schedule(true);
  }

  /** A game session started or stopped (`game`: its id, for a scene of its own). */
  onGame(playing: boolean, game: string | null = null): void {
    if (this.#managed) return;
    this.#apply({ ...this.#facts, playing, game: playing ? game : null });
  }

  /** Her voice node joined (`true`) or left (`false`) voice channel `id`. */
  onVoice(id: string, joined: boolean): void {
    if (this.#managed) return;
    if (joined) this.#voices.add(id);
    else this.#voices.delete(id);
    this.#apply({ ...this.#facts, inVoice: this.#voices.size > 0 });
  }

  /**
   * She started (`true`) or finished (`false`) singing a song. With a `sing` scene she goes
   * there at once; afterwards back to the scene she was on, when the director put her on the
   * sing scene, she is still there and her situation did not change during the song (else to
   * whatever fits now). Without a `sing` scene nothing switches.
   */
  onSong(singing: boolean): void {
    if (this.#managed) return;
    this.#apply({ ...this.#facts, singing });
  }

  /** Someone talked (her speech, an utterance, a finished turn). */
  onActivity(): void {
    const wasAway = away(this.#facts, this.#memory, this.#config, this.#now());
    this.#memory.lastActivity = this.#now();
    if (wasAway) this.#schedule(false);
  }

  /** The facts from the bus inputs (without the ActivityManager). */
  #applyBus(): void {
    let live = this.#obsStreaming;
    for (const state of this.#golive.values())
      if (state === "starting" || state === "live") live = true;
    this.#apply({
      ...this.#facts,
      live,
      liveSince: live ? (this.#facts.liveSince ?? this.#now()) : null,
    });
  }

  /** Moves to `next` and reacts to what changed. */
  #apply(next: SceneFacts): void {
    const prev = this.#facts;
    this.#facts = next;
    if (prev.live !== next.live) this.#liveChanged(next.live);
    if (
      prev.playing !== next.playing ||
      prev.game !== next.game ||
      prev.browsing !== next.browsing
    ) {
      this.#situation += 1;
      this.#memory.returnTo = null;
      this.#memory.ended = false;
      this.#memory.lastActivity = this.#now();
      this.#schedule(false);
    }
    if (prev.inVoice !== next.inVoice) {
      if (next.inVoice && next.live) this.#memory.voiceThisLive = true;
      this.#memory.lastActivity = this.#now();
      this.#schedule(false);
    }
    if (prev.singing !== next.singing) this.#songChanged(next.singing);
    if (
      prev.override?.scene !== next.override?.scene ||
      prev.override?.until !== next.override?.until
    ) {
      // Her switch showed up before the snapshot that explains it: it was not a manual one.
      if (next.override !== null && next.override.scene === this.#scene) this.#manualUntil = 0;
      this.#schedule(next.override !== null);
      if (next.override !== null) this.#wake(Math.max(next.override.until - this.#now(), 0));
    }
  }

  #songChanged(singing: boolean): void {
    this.#memory.lastActivity = this.#now();
    if (singing) {
      this.#beforeSong = { scene: this.#scene, situation: this.#situation };
      this.#singScene = null;
      this.#memory.returnTo = null;
      if (this.#roles.resolve("sing") !== null) this.#schedule(true);
      return;
    }
    const sang = this.#singScene;
    const before = this.#beforeSong;
    this.#singScene = null;
    this.#beforeSong = null;
    if (sang === null || this.#scene !== sang) return;
    if (before?.scene && before.scene !== sang && before.situation === this.#situation) {
      this.#memory.returnTo = before.scene;
    }
    this.#schedule(true);
  }

  #liveChanged(live: boolean): void {
    this.#situation += 1;
    this.#memory.returnTo = null;
    const now = this.#now();
    if (live) {
      log.info("stream went live");
      this.#memory.ended = false;
      this.#manualUntil = 0;
      this.#memory.voiceThisLive = this.#facts.inVoice;
      this.#memory.lastActivity = now;
      this.#schedule(true);
    } else {
      log.info("stream ended");
      if (!this.#memory.ended) this.#memory.endingUntil = now + this.#config.ending_ms;
      this.#memory.ended = true;
      this.#schedule(true);
    }
  }

  // ----- the curtain -----

  /**
   * `StreamCurtain`: before the stream stops, switch to the ending scene and hold it for
   * `ending_ms`. Resolves at once when not live, without an ending scene or when the switch was
   * refused. Never throws.
   */
  async close(signal?: AbortSignal): Promise<void> {
    if (this.#closed || !this.live() || this.#memory.ended) return;
    this.#memory.ended = true;
    this.#memory.endingUntil = this.#now() + this.#config.ending_ms;
    const scene = this.#roles.resolve("ending");
    if (scene === null || this.#config.ending_ms <= 0) return;
    const switched = await this.#mutex.run(async () => {
      if (scene === this.#scene) return true;
      return this.#switch("ending", scene, "直播要結束了", false);
    });
    if (!switched) return;
    try {
      await sleep(this.#config.ending_ms, signal);
    } catch {
      // Aborted: stop now.
    }
  }

  // ----- evaluation -----

  /** Evaluates after the debounce (at once when `urgent`). */
  #schedule(urgent: boolean): void {
    if (this.#closed || !this.#config.director) return;
    this.#urgent ||= urgent;
    this.#wake(urgent ? 0 : this.#config.debounce_ms);
  }

  #wake(delayMs: number): void {
    if (this.#closed || !this.#config.director) return;
    const at = this.#now() + Math.max(delayMs, 0);
    if (this.#timer !== null && this.#due !== null && this.#due <= at) return;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#due = at;
    this.#timer = setTimeout(
      () => {
        this.#timer = null;
        this.#due = null;
        void this.#evaluate();
      },
      Math.max(delayMs, 0),
    );
    this.#timer.unref?.();
  }

  async #evaluate(): Promise<void> {
    if (this.#closed) return;
    if (this.#busy) {
      this.#again = true;
      return;
    }
    this.#busy = true;
    try {
      do {
        this.#again = false;
        // Under the same mutex as the curtain: what is wanted is decided right before switching.
        await this.#mutex.run(() => this.#step());
      } while (this.#again && !this.#closed);
    } finally {
      this.#busy = false;
      this.#planNext();
    }
  }

  async #step(): Promise<void> {
    const urgentRequest = this.#urgent;
    this.#urgent = false;
    const want = this.desired();
    // Going back after a song is tried once.
    const back = want !== null && want.scene === this.#memory.returnTo;
    if (back) this.#memory.returnTo = null;
    if (want === null || want.scene === this.#scene) return;
    const { role, scene } = want;
    const now = this.#now();
    const urgent = want.urgent && urgentRequest;
    if (!urgent && now < this.#manualUntil) {
      this.#wake(this.#manualUntil - now);
      return;
    }
    const gap = this.#lastSwitch + this.#config.min_switch_ms - now;
    if (!urgent && gap > 0) {
      this.#wake(gap);
      return;
    }
    // Going back after a song and her override name a scene, not a role.
    const byName = back || scene === this.#facts.override?.scene;
    if (await this.#switch(role, scene, want.why, byName)) {
      log.info({ role, scene, why: want.why }, "switched the scene");
      if (role === "sing" && this.#facts.singing) this.#singScene = scene;
    }
  }

  /** One switch (call under `#mutex`): by scene name when `byName`, else by role. */
  async #switch(
    role: string | null,
    scene: string,
    why: string,
    byName: boolean,
  ): Promise<boolean> {
    this.#expect = scene;
    this.#lastSwitch = this.#now();
    let switched = false;
    try {
      if (byName && this.#switchScene) switched = await this.#switchScene(scene, why);
      else if (role !== null) switched = await this.#switchRole(role, why);
      else if (this.#switchScene) switched = await this.#switchScene(scene, why);
    } catch (error) {
      log.warn({ err: String(error), role, scene }, "scene switch failed");
    }
    if (switched) this.#scene = scene;
    else if (this.#expect === scene) this.#expect = null;
    return switched;
  }

  /** Wakes up for the next time-based change (end of starting, silence → brb, override end). */
  #planNext(): void {
    if (this.#closed || !this.#config.director) return;
    const now = this.#now();
    const times: number[] = [];
    const override = this.#facts.override;
    if (override !== null && override.until > now) times.push(override.until);
    if (this.live()) {
      const startingUntil = (this.#facts.liveSince ?? 0) + this.#config.starting_ms;
      if (startingUntil > now) times.push(startingUntil);
      if (this.#memory.ended && this.#memory.endingUntil > now)
        times.push(this.#memory.endingUntil);
      const after = this.#config.brb_after_ms;
      if (
        after > 0 &&
        !this.#facts.playing &&
        !away(this.#facts, this.#memory, this.#config, now)
      ) {
        times.push(this.#memory.lastActivity + after);
      }
    }
    if (times.length === 0) return;
    this.#wake(Math.min(...times) - now);
  }

  /** Stops all timers (module stop). */
  stop(): void {
    this.#closed = true;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#due = null;
  }
}
