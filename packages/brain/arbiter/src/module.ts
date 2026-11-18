import { ActuatorRegistryKey } from "@miyoria/gate/actions";
import { LlmRouterKey } from "@miyoria/llm/llm";
import {
  defineManifest,
  errorMessage,
  getLogger,
  interval,
  type Module,
  type ModuleContext,
  SerialQueue,
  withTimeout,
} from "@miyoria/runtime/kernel";
import { type SettingsStore, SettingsStoreKey } from "@miyoria/store";
import {
  type AccountRef,
  ActivityManagerKey,
  AffectStateKey,
  ArbiterKey,
  type Clock,
  type ContextKey,
  contextKeyEquals,
  contextKeyString,
  DeliveryLedgerKey,
  type Envelope,
  EventLogKey,
  Events,
  FloorKey,
  HandleDirectoryKey,
  type Impulse,
  ImpulseHostKey,
  inVoice,
  is,
  isJsonObject,
  type JsonValue,
  type LogEvent,
  newImpulse,
  type Observation,
  type ObservationBody,
  PartyStatusKey,
  PersonThreadsKey,
  type ProfileId,
  runningActivity,
  SelfStateKey,
  SocialSignalsKey,
  toTimestamp,
  WishesKey,
} from "@miyoria/types";
import { z } from "zod";
import { ArbiterCore } from "./arbiter.js";
import { type ArbiterConfig, ArbiterConfigSchema } from "./config.js";
import { FloorCore } from "./floor.js";
import { LedgerSnapshotSchema } from "./ledger.js";
import { humanResponse } from "./unanswered.js";
import { WishBook } from "./wishes.js";

const log = getLogger("arbiter");

/** Settings key of the persisted state (the ledger and the holds). */
export const STATE_KEY = "arbiter:state";
/** Profile under which the state is stored. */
export const STATE_PROFILE = "_global";

const STORE_TIMEOUT_MS = 5_000;
/** The queue is looked at least this often. */
const PUMP_MS = 1_000;
const MINUTE_MS = 60_000;
/** Her talkativeness that means the budget as configured. */
const USUAL_TALK = 0.5;
/**
 * Writers of observations that may ask for the mic (§6). Everything else she only knows (a
 * greeting or an overdue promise is her own start: the new runner's). Pats from the live page
 * only claim when `[modules.live] pat_salience = "notable"`: an ambient batch is written silent
 * and never gets here.
 */
const CLAIMING = /^(?:game\.|live\.pat$)/;

/** The stored state; a `producers` key written before is no longer read. */
const StateSchema = z.object({
  ledger: LedgerSnapshotSchema.prefault({}),
  holds: z
    .array(z.object({ capability: z.string(), reason: z.string(), until: z.number() }))
    .default([]),
});

export interface ArbiterModuleOptions {
  /** Replaces the time source (default: the module context's clock). */
  clock?: Clock;
}

/**
 * Module `arbiter`: the one gate for what wants her to speak without being asked that is not her
 * own start (docs/design/v2-architecture.md §3.3): a game's narration, a song, a notice. Provides
 * `ArbiterKey`; publishes `arbiter.decision`, `arbiter.ledger` and `affect.event`
 * `topic_ignored`; takes impulses from `ArbiterKey.submit` and the `arbiter.impulse` topic.
 * Accepted speak impulses are opened by the agent (`ImpulseHostKey`). Her own starts (greetings,
 * followups, overdue promises, her plans) are the new runner's initiative
 * (`@miyoria/brain/selfhost`): their impulses are refused here.
 *
 * It is the Floor (`FloorKey`, docs/design/v3-architecture.md §7): nothing here runs an action,
 * and every non-silent observation of a game asks for the mic from the log.
 */
export class ArbiterModule implements Module {
  static readonly ID = "arbiter";
  readonly manifest = defineManifest(ArbiterModule.ID, "Arbiter", {
    icon: "scale",
    category: "her",
    description: "Decides whether she speaks or acts now; keeps her ledger",
    optional: ["facts", "agent", "actions", "llm", "heart", "memory"],
    configSchema: ArbiterConfigSchema,
  });
  readonly #clock: Clock | undefined;
  #stopFollowing: (() => void)[] = [];

  /** `_profile`: kept for the callers; her state is stored under `STATE_PROFILE`. */
  constructor(_profile: ProfileId, options: ArbiterModuleOptions = {}) {
    this.#clock = options.clock;
  }

  async start(ctx: ModuleContext): Promise<void> {
    const config = ctx.config(ArbiterConfigSchema);
    const clock = this.#clock ?? ctx.clock;
    const services = ctx.services;
    const floor = floorOf(ctx, config, clock);
    const wishes = new WishBook(config.wishes, {
      now: () => clock.now(),
      log: () => services.get(EventLogKey) ?? null,
      threads: () => services.get(PersonThreadsKey) ?? null,
      handles: () => services.get(HandleDirectoryKey) ?? null,
    });
    const core = new ArbiterCore(config, {
      wishes,
      now: () => clock.now(),
      publish: ctx.publisher,
      paused: () => services.get(ActuatorRegistryKey)?.paused ?? false,
      budget: () => services.get(LlmRouterKey)?.budgetState() ?? "ok",
      blocked: (account) => services.get(SocialSignalsKey)?.attitude(account)?.blocked ?? false,
      host: () => services.get(ImpulseHostKey) ?? null,
      floor,
    });
    const store = services.get(SettingsStoreKey);
    if (store) await restore(store, core, clock.now());
    ctx.provide(ArbiterKey, core);
    ctx.provide(WishesKey, wishes);
    ctx.provide(FloorKey, floor);
    await this.#followWishes(ctx, config, clock, wishes);

    const runner = new Runner(ctx, core, clock, store, floor);
    await this.#follow(ctx, config, clock, floor, runner);
    const events = ctx.subscribe([
      Events.PlatformReady.type,
      Events.PlatformMessageCreated.type,
      Events.VoiceJoined.type,
      Events.VoiceLeft.type,
      Events.VoiceParticipants.type,
      Events.VoiceUtteranceEvent.type,
      Events.AgentTurnCompleted.type,
      Events.AgentTurnOutcome.type,
      Events.AgentTurnFocus.type,
      Events.ArbiterImpulse.type,
      Events.ActivityDone.type,
      Events.ActivityFailed.type,
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
        floor.expire();
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

  /** What she wanted to ask whom is rebuilt from the log, and follows it. */
  async #followWishes(
    ctx: ModuleContext,
    config: ArbiterConfig,
    clock: Clock,
    wishes: WishBook,
  ): Promise<void> {
    const log = ctx.services.get(EventLogKey);
    if (!log) return;
    const since = toTimestamp(clock.now() - config.wishes.keep_hours * 60 * MINUTE_MS);
    this.#stopFollowing.push(await log.project(wishes, { since }));
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
      // Hosting a party game is a show too: it must not run out of lines halfway through a round.
      if ((services.get(PartyStatusKey)?.running(context) ?? null) !== null) return true;
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

async function restore(store: SettingsStore, core: ArbiterCore, now: number): Promise<void> {
  try {
    const value = await withTimeout(store.get(STATE_PROFILE, STATE_KEY), STORE_TIMEOUT_MS);
    if (value === undefined) {
      log.warn("loading arbiter state timed out");
      return;
    }
    if (value === null) return;
    const state = StateSchema.parse(value);
    core.book.restore(state.ledger, now);
    core.restoreHolds(state.holds, now);
    log.info("restored arbiter ledger");
  } catch (error) {
    log.warn({ error: errorMessage(error) }, "could not load arbiter state");
  }
}

class Runner {
  readonly #queue = new SerialQueue();
  /** Her own accounts (`platform.ready`): her lines are no response to her. */
  readonly #selfAccounts = new Set<string>();

  constructor(
    private readonly ctx: ModuleContext,
    private readonly core: ArbiterCore,
    private readonly clock: Clock,
    private readonly store: SettingsStore | undefined,
    private readonly floor: FloorCore,
  ) {}

  #submit(impulse: Impulse): void {
    void this.core.submit(impulse).catch((error: unknown) => {
      log.warn({ impulse: impulse.id, error: errorMessage(error) }, "impulse failed");
    });
  }

  #isSelf(account: AccountRef): boolean {
    return this.#selfAccounts.has(`${account.platform}:${account.id}`);
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
    const impulse = this.#claimOf(o);
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
        reason: "game",
        attention: { key: o.attention_key, repeat_after_ms: 0, revision: o.revision },
        claim: urgent ? "urgent" : "notable",
        coalesce_key: urgent ? null : `floor:${contextKeyString(context)}`,
      },
      now,
    );
  }

  onEvent(env: Envelope): void {
    const now = this.clock.now();
    if (is(Events.PlatformReady, env)) {
      const account = env.data.self_account;
      this.#selfAccounts.add(`${account.platform}:${account.id}`);
    }
    const response = humanResponse(env, (account) => this.#isSelf(account));
    if (response) this.core.heard(response.context, response.account);
    if (is(Events.PlatformMessageCreated, env)) {
      const m = env.data;
      if (m.author.is_bot || this.#isSelf(m.author.account)) return;
      const dm = m.id.context.kind === "dm";
      if (dm || m.mentions_self || m.reply_to_self) {
        this.core.engaged(m.id.context, dm ? m.author.account : null, now);
      }
    } else if (is(Events.AgentTurnCompleted, env)) {
      this.core.turnCompleted(env.data.turn, env.data.context, env.data.text);
    } else if (is(Events.VoiceJoined, env) || is(Events.VoiceLeft, env)) {
      // Not a response: a new stay in voice is a new audience, nobody there ignored her yet.
      this.core.heard(env.data.context, null);
      this.floor.newAudience(env.data.context);
    }
    // These are read only with an object payload, as before.
    if (!isJsonObject(env.data as JsonValue)) return;
    if (is(Events.AgentTurnOutcome, env)) {
      this.core.turnOutcome(env.data);
    } else if (is(Events.ActivityDone, env) || is(Events.ActivityFailed, env)) {
      const ended = env.data;
      const r = ended.request;
      const crashed = ended.type === "failed" && ended.code === "crashed";
      if (r.type === "stop" && r.activity === "game" && !crashed) this.core.gameClosed();
    } else if (is(Events.AgentTurnFocus, env)) {
      this.core.turnFocus(env.data);
    } else if (is(Events.ArbiterImpulse, env)) {
      const impulse = env.data;
      if (typeof impulse.id === "string" && impulse.target) this.#submit(impulse);
    }
  }

  onTick(): Promise<void> {
    return this.#queue.run(async () => {
      await this.core.tick();
      await this.#persist();
    });
  }

  persist(): Promise<void> {
    return this.#queue.run(() => this.#persist());
  }

  async #persist(): Promise<void> {
    if (!this.store) return;
    if (!this.core.book.dirty && !this.core.holdsDirty) return;
    const value = {
      ledger: this.core.book.snapshot(this.clock.now()),
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
