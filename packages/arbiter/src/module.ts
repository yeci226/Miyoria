import { ActuatorRegistryKey } from "@miyoria/actions";
import {
  defineManifest,
  errorMessage,
  getLogger,
  interval,
  type Module,
  type ModuleContext,
  SerialQueue,
  withTimeout,
} from "@miyoria/kernel";
import { LlmRouterKey } from "@miyoria/llm";
import { type SettingsStore, SettingsStoreKey } from "@miyoria/store";
import {
  ACTIVITY_DONE_TOPIC,
  ACTIVITY_FAILED_TOPIC,
  ActivityManagerKey,
  AffectStateKey,
  ARBITER_IMPULSE_TOPIC,
  ArbiterKey,
  type Clock,
  type ContextKey,
  contextKeyEquals,
  contextKeyString,
  DeliveryLedgerKey,
  type Envelope,
  EventLogKey,
  FloorKey,
  FollowupSourceKey,
  type Impulse,
  ImpulseHostKey,
  type ImpulseRun,
  inVoice,
  isJsonObject,
  type JsonValue,
  type LogEvent,
  newId,
  newImpulse,
  type Observation,
  type ObservationBody,
  Principals,
  type ProfileId,
  ProposalBoardKey,
  pipelineOf,
  runningActivity,
  SelfStateKey,
  SocialSignalsKey,
  TURN_FOCUS_TOPIC,
  TURN_OUTCOME_TOPIC,
  toTimestamp,
  v2Payload,
} from "@miyoria/types";
import { z } from "zod";
import { ArbiterCore } from "./arbiter.js";
import { type ArbiterConfig, ArbiterConfigSchema, INITIATIVE_KEYS } from "./config.js";
import { FloorCore } from "./floor.js";
import { LedgerSnapshotSchema } from "./ledger.js";
import { ProducerSnapshotSchema, Producers } from "./producers.js";
import { humanResponse } from "./unanswered.js";

const log = getLogger("arbiter");

/** Settings key of the persisted state (counters, backoff, topics, greetings). */
export const STATE_KEY = "arbiter:state";
/** Profile under which the state is stored. */
export const STATE_PROFILE = "_global";

const STORE_TIMEOUT_MS = 5_000;
/** The queue is looked at least this often. */
const PUMP_MS = 1_000;
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
/** Her talkativeness that means the budget as configured. */
const USUAL_TALK = 0.5;
/** Writers of observations that may ask for the mic (§6). Everything else she only knows. */
const CLAIMING = /^(?:game\.|world\.greeting$|mainline\.commitment$)/;

const StateSchema = z.object({
  ledger: LedgerSnapshotSchema.prefault({}),
  producers: ProducerSnapshotSchema.prefault({}),
  holds: z
    .array(z.object({ capability: z.string(), reason: z.string(), until: z.number() }))
    .default([]),
});

export interface ArbiterModuleOptions {
  /** Replaces the time source (default: the module context's clock). */
  clock?: Clock;
  /**
   * The old `[modules.initiative]` section, if the config file still has one: its keys that
   * moved are used (unless `[modules.arbiter]` sets them) with a deprecation warning.
   */
  legacyInitiative?: JsonValue | null;
}

/**
 * Module `arbiter`: the one gate for everything that wants her to speak or act without being
 * asked (docs/design/v2-architecture.md §3.3). Provides `ArbiterKey`; publishes
 * `arbiter.decision`, `arbiter.ledger` and `affect.event` `topic_ignored`; takes impulses from
 * `ArbiterKey.submit` and the `arbiter.impulse` topic. Accepted speak impulses are opened by the
 * agent (`ImpulseHostKey`). Greets friends and brings up due followups (`FollowupSourceKey`).
 *
 * Under `pipeline = "v3"` it is the Floor (`FloorKey`, docs/design/v3-architecture.md §7): the
 * greetings become Observations and the due followups Proposals, nothing here runs an action, and
 * every non-silent observation of a game, a greeting or a commitment asks for the mic from the log.
 */
export class ArbiterModule implements Module {
  static readonly ID = "arbiter";
  readonly manifest = defineManifest(ArbiterModule.ID, "Arbiter", {
    description: "Decides whether she speaks or acts now; keeps her ledger",
    optional: ["facts", "agent", "actions", "llm", "social", "memory"],
    configSchema: ArbiterConfigSchema,
  });
  readonly #profile: ProfileId;
  readonly #clock: Clock | undefined;
  readonly #legacy: JsonValue | null;
  #stopFollowing: (() => void)[] = [];

  constructor(profile: ProfileId, options: ArbiterModuleOptions = {}) {
    this.#profile = profile;
    this.#clock = options.clock;
    this.#legacy = options.legacyInitiative ?? null;
  }

  #config(ctx: ModuleContext): ArbiterConfig {
    const own = isJsonObject(ctx.rawConfig) ? ctx.rawConfig : {};
    const legacy = isJsonObject(this.#legacy) ? this.#legacy : {};
    const carried: Record<string, JsonValue> = {};
    const moved: string[] = [];
    for (const [key, value] of Object.entries(legacy)) {
      if (key === "enabled" || value === undefined) continue;
      moved.push(key);
      const to = INITIATIVE_KEYS[key];
      if (to && !(to in own)) carried[to] = value;
    }
    if (moved.length > 0) {
      log.warn(
        { keys: moved },
        "[modules.initiative] is deprecated: the arbiter replaced it; move these keys to [modules.arbiter]",
      );
    }
    if (Object.keys(carried).length === 0) return ctx.config(ArbiterConfigSchema);
    return ArbiterConfigSchema.parse({ ...carried, ...own });
  }

  async start(ctx: ModuleContext): Promise<void> {
    const config = this.#config(ctx);
    const clock = this.#clock ?? ctx.clock;
    const services = ctx.services;
    const floor = pipelineOf(services) === "v3" ? floorOf(ctx, config, clock) : null;
    const core = new ArbiterCore(config, {
      now: () => clock.now(),
      publish: (event) => ctx.publish(event),
      paused: () => services.get(ActuatorRegistryKey)?.paused ?? false,
      budget: () => services.get(LlmRouterKey)?.budgetState() ?? "ok",
      blocked: (account) => services.get(SocialSignalsKey)?.attitude(account)?.blocked ?? false,
      host: () => services.get(ImpulseHostKey) ?? null,
      ...(floor === null
        ? { act: (impulse, signal) => actThroughGate(ctx, impulse, signal) }
        : { floor }),
    });
    const producers = new Producers(config);
    const store = services.get(SettingsStoreKey);
    if (store) await restore(store, core, producers, clock.now());
    ctx.provide(ArbiterKey, core);
    if (floor !== null) ctx.provide(FloorKey, floor);

    const runner = new Runner(ctx, core, producers, this.#profile, clock, store, floor);
    if (floor !== null) await this.#follow(ctx, config, clock, floor, runner);
    const events = ctx.subscribe([
      "platform.ready",
      "platform.message.created",
      "voice.joined",
      "voice.left",
      "voice.participants",
      "voice.utterance",
      "agent.turn.completed",
      TURN_OUTCOME_TOPIC,
      TURN_FOCUS_TOPIC,
      ARBITER_IMPULSE_TOPIC,
      ACTIVITY_DONE_TOPIC,
      ACTIVITY_FAILED_TOPIC,
    ]);
    ctx.spawn("arbiter.events", async () => {
      for await (const env of events) runner.onEvent(env);
      await runner.persist();
    });
    ctx.spawn("arbiter.tick", async (signal) => {
      for await (const _ of interval(config.tick_secs * 1000, signal)) await runner.onTick();
    });
    ctx.spawn("arbiter.queue", async (signal) => {
      for await (const _ of interval(Math.min(config.retry_ms, PUMP_MS), signal)) {
        floor?.expire();
        const next = core.nextRetry();
        if (next !== null && next <= clock.now()) await core.pump();
      }
    });
  }

  /** The Floor reads the log, and what the log says may ask for the mic. */
  async #follow(
    ctx: ModuleContext,
    config: ArbiterConfig,
    clock: Clock,
    floor: FloorCore,
    runner: Runner,
  ): Promise<void> {
    const log = ctx.services.get(EventLogKey);
    if (!log) {
      ctx.log.warn("no event log: her budget and what she said are not known to the Floor");
      return;
    }
    const { budget, text_presence_mins: presence } = config.floor;
    const since = toTimestamp(clock.now() - Math.max(budget.window_mins, presence) * MINUTE_MS);
    this.#stopFollowing.push(await log.project(floor, { since }));
    this.#stopFollowing.push(await log.project({ apply: (event) => runner.onLog(event) }));
  }

  async stop(): Promise<void> {
    for (const stop of this.#stopFollowing.splice(0)) stop();
  }
}

/** The Floor, reading her state from the services that have it. */
function floorOf(ctx: ModuleContext, config: ArbiterConfig, clock: Clock): FloorCore {
  const services = ctx.services;
  return new FloorCore(config.floor, config.max_unanswered, {
    now: () => clock.now(),
    ledger: () => services.get(DeliveryLedgerKey) ?? null,
    log: () => services.get(EventLogKey) ?? null,
    humans: (context) => services.get(ImpulseHostKey)?.facts(context).humans ?? null,
    performing: (context) => {
      const manager = services.get(ActivityManagerKey);
      if (!manager) return false;
      const snapshot = manager.snapshot();
      const running = runningActivity(snapshot);
      if (running?.type === "singing") return true;
      const here = inVoice(snapshot);
      const inPlace = here !== null && contextKeyEquals(here, context);
      return inPlace && running?.type === "game" && snapshot.broadcast.type === "live";
    },
    talk: (context) =>
      (services.get(SelfStateKey)?.talkativeness(context)?.level ?? USUAL_TALK) / USUAL_TALK,
    feeling: () => services.get(AffectStateKey)?.snapshot().biases.talkativeness ?? 0,
  });
}

async function restore(
  store: SettingsStore,
  core: ArbiterCore,
  producers: Producers,
  now: number,
): Promise<void> {
  try {
    const value = await withTimeout(store.get(STATE_PROFILE, STATE_KEY), STORE_TIMEOUT_MS);
    if (value === undefined) {
      log.warn("loading arbiter state timed out");
      return;
    }
    if (value === null) return;
    const state = StateSchema.parse(value);
    core.book.restore(state.ledger, now);
    producers.restore(state.producers);
    core.restoreHolds(state.holds, now);
    log.info("restored arbiter ledger");
  } catch (error) {
    log.warn({ error: errorMessage(error) }, "could not load arbiter state");
  }
}

/** An `act` impulse that is not one of hers: through the gate (the director for game ones). */
async function actThroughGate(
  ctx: ModuleContext,
  impulse: Impulse,
  signal: AbortSignal | undefined,
): Promise<ImpulseRun> {
  const registry = ctx.services.get(ActuatorRegistryKey);
  if (!registry || impulse.capability === null) {
    return { status: "refused", reason: "denied", detail: "沒有可以執行的能力" };
  }
  const context = impulse.target.context;
  const outcome = await registry.invoke(
    {
      principal:
        impulse.source === "game" ? Principals.director(context) : Principals.self(context, null),
      capability: impulse.capability,
      args: impulse.args,
      why: impulse.why === "" ? null : impulse.why,
      turn: null,
      about: impulse.target.account,
    },
    signal ? { signal, priority: impulse.priority } : { priority: impulse.priority },
  );
  switch (outcome.status) {
    case "done":
      return { status: "started", turn: null, task: null, detail: outcome.result.text };
    case "denied":
      return { status: "refused", reason: "denied", detail: outcome.decision.reason };
    case "failed":
      return { status: "refused", reason: "denied", detail: outcome.error };
  }
}

/** The local day of `now` as a key part; greetings are once a day. */
function dayStamp(now: number): number {
  return Math.floor(now / DAY_MS);
}

class Runner {
  readonly #queue = new SerialQueue();
  /** Followups submitted whose `markDone` failed; never brought up twice. */
  readonly #failedMarks = new Set<string>();
  /** V3: the claims behind observations written here, by event id. */
  readonly #observed = new Map<string, Impulse>();

  constructor(
    private readonly ctx: ModuleContext,
    private readonly core: ArbiterCore,
    private readonly producers: Producers,
    private readonly profile: ProfileId,
    private readonly clock: Clock,
    private readonly store: SettingsStore | undefined,
    private readonly floor: FloorCore | null = null,
  ) {}

  #submit(impulse: Impulse): void {
    void this.core.submit(impulse).catch((error: unknown) => {
      log.warn({ impulse: impulse.id, error: errorMessage(error) }, "impulse failed");
    });
  }

  /** V3: a greeting is something she notices. Whether she says it is the Floor's and hers. */
  #observe(impulse: Impulse): void {
    const log = this.ctx.services.get(EventLogKey);
    const context = impulse.target.context;
    if (!log || context === null) return;
    const id = newId();
    const key = `greeting:${impulse.coalesce_key ?? id}:${dayStamp(this.clock.now())}`;
    this.#observed.set(id, {
      ...impulse,
      claim: "notable",
      attention: { key, repeat_after_ms: DAY_MS, revision: 1 },
    });
    const observation: Observation = {
      source: "world.greeting",
      silent: false,
      salience: "notable",
      attention_key: key,
      revision: 1,
      summary: impulse.hint ?? impulse.why,
      addressed_to_her: false,
      from: impulse.target.person,
      context,
    };
    log.observe(observation, { id });
  }

  /** V3: an observation that may ask for the mic does. */
  onLog(event: LogEvent): void {
    if (event.kind !== "observation" || !isJsonObject(event.body)) return;
    const { observation: o } = event.body as unknown as ObservationBody;
    if (o === undefined || o.silent || o.addressed_to_her || !CLAIMING.test(o.source)) return;
    // Tasks of a game are the hands' business: what they say comes back as results.
    if (o.attention_key.startsWith("task:")) return;
    const ledger = this.ctx.services.get(DeliveryLedgerKey);
    if (ledger && !ledger.mayClaim(o)) return;
    const stashed = this.#observed.get(event.id);
    this.#observed.delete(event.id);
    const impulse = stashed ?? this.#claimOf(o);
    if (impulse === null) return;
    // Out of the log's append: a decision writes to the log itself.
    queueMicrotask(() => this.#submit(impulse));
  }

  /** Where a line about the game goes: voice. A text channel gets no running commentary. */
  #placeOfGame(): ContextKey | null {
    const manager = this.ctx.services.get(ActivityManagerKey);
    return manager ? inVoice(manager.snapshot()) : null;
  }

  #claimOf(o: Observation): Impulse | null {
    const context = o.context ?? this.#placeOfGame();
    if (context === null) return null;
    const now = this.clock.now();
    const urgent = o.salience === "urgent";
    return newImpulse(
      {
        source: "game",
        context,
        ttlMs: this.core.config.impulse_ttl_secs * 1000,
        why: o.source,
        hint: o.summary,
        reason: o.source === "mainline.commitment" ? "commitment" : "game",
        attention: { key: o.attention_key, repeat_after_ms: 0, revision: o.revision },
        claim: urgent ? "urgent" : "notable",
        coalesce_key: urgent ? null : `floor:${contextKeyString(context)}`,
      },
      now,
    );
  }

  onEvent(env: Envelope): void {
    const event = env.event;
    const now = this.clock.now();
    const social = this.ctx.services.get(SocialSignalsKey) ?? null;
    for (const impulse of this.producers.observe(now, event, social)) {
      if (this.floor === null) this.#submit(impulse);
      else this.#observe(impulse);
    }
    const response = humanResponse(event, (account) => this.producers.isSelf(account));
    if (response) this.core.heard(response.context, response.account);
    switch (event.type) {
      case "platform_message_created": {
        const m = event.data;
        if (m.author.is_bot || this.producers.isSelf(m.author.account)) break;
        const dm = m.id.context.kind === "dm";
        if (dm || m.mentions_self || m.reply_to_self) {
          this.core.engaged(m.id.context, dm ? m.author.account : null, now);
        }
        break;
      }
      case "agent_turn_completed":
        this.core.turnCompleted(event.data.turn, event.data.context, event.data.text);
        break;
      case "voice_joined":
      case "voice_left":
        // Not a response: a new stay in voice is a new audience, nobody there ignored her yet.
        this.core.heard(event.data.context, null);
        this.floor?.newAudience(event.data.context);
        break;
      case "custom": {
        const outcome = v2Payload(event, TURN_OUTCOME_TOPIC);
        if (outcome) {
          this.core.turnOutcome(outcome);
          break;
        }
        const ended =
          v2Payload(event, ACTIVITY_DONE_TOPIC) ?? v2Payload(event, ACTIVITY_FAILED_TOPIC);
        if (ended) {
          const r = ended.request;
          const crashed = ended.type === "failed" && ended.code === "crashed";
          if (r.type === "stop" && r.activity === "game" && !crashed) this.core.gameClosed();
          break;
        }
        const focus = v2Payload(event, TURN_FOCUS_TOPIC);
        if (focus) {
          this.core.turnFocus(focus);
          break;
        }
        const impulse = v2Payload(event, ARBITER_IMPULSE_TOPIC);
        if (impulse && typeof impulse.id === "string" && impulse.target) this.#submit(impulse);
        break;
      }
      default:
        break;
    }
  }

  onTick(): Promise<void> {
    return this.#queue.run(async () => {
      const now = this.clock.now();
      this.producers.prune(now);
      await this.core.tick();
      await this.#followups(now);
      await this.#persist();
    });
  }

  persist(): Promise<void> {
    return this.#queue.run(() => this.#persist());
  }

  async #followups(now: number): Promise<void> {
    const source = this.ctx.services.get(FollowupSourceKey);
    if (!source) return;
    let due: Awaited<ReturnType<typeof source.due>> | undefined;
    try {
      due = await withTimeout(source.due(this.profile, toTimestamp(now)), STORE_TIMEOUT_MS);
    } catch (error) {
      log.warn({ error: errorMessage(error) }, "could not fetch due followups");
      return;
    }
    if (due === undefined) {
      log.warn("fetching due followups timed out");
      return;
    }
    const social = this.ctx.services.get(SocialSignalsKey) ?? null;
    for (const followup of due) {
      if (this.#failedMarks.has(followup.id)) continue;
      const impulse = this.producers.followup(now, followup, social);
      if (!impulse) continue;
      if (this.floor !== null) {
        await this.#propose(impulse, followup.id);
        continue;
      }
      const decision = await this.core.submit(impulse);
      // Rejected or expired: it stays due and comes back on a later tick.
      if (decision.verdict !== "accepted" && decision.verdict !== "deferred") continue;
      try {
        await source.markDone(followup.id);
        log.debug({ id: followup.id }, "followup brought up");
      } catch (error) {
        log.warn({ id: followup.id, error: errorMessage(error) }, "could not mark followup done");
        this.#failedMarks.add(followup.id);
      }
    }
  }

  /** V3: memory work only proposes. She is told of it next time she has the floor. */
  async #propose(impulse: Impulse, followup: string): Promise<void> {
    const board = this.ctx.services.get(ProposalBoardKey);
    const source = this.ctx.services.get(FollowupSourceKey);
    if (!board || !source) return;
    await board.propose({
      what: impulse.hint ?? impulse.why,
      why: impulse.why,
      expires: impulse.expires_at,
      source: "memory",
      context: impulse.target.context,
      about: impulse.target.account,
      person: impulse.target.person,
      goal: null,
    });
    try {
      await source.markDone(followup);
    } catch (error) {
      log.warn({ id: followup, error: errorMessage(error) }, "could not mark followup done");
      this.#failedMarks.add(followup);
    }
  }

  async #persist(): Promise<void> {
    if (!this.store) return;
    if (!this.core.book.dirty && !this.producers.dirty && !this.core.holdsDirty) return;
    const value = {
      ledger: this.core.book.snapshot(this.clock.now()),
      producers: this.producers.snapshot(),
      holds: this.core.holds(),
    };
    try {
      const write = this.store.set(STATE_PROFILE, STATE_KEY, value as unknown as JsonValue);
      if (
        (await withTimeout(
          write.then(() => true),
          STORE_TIMEOUT_MS,
        )) === undefined
      ) {
        log.warn("saving arbiter state timed out");
      }
    } catch (error) {
      log.warn({ error: errorMessage(error) }, "could not save arbiter state");
    }
  }
}
