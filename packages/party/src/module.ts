import { actuatorsFor } from "@miyoria/actions";
import {
  defineManifest,
  errorMessage,
  getLogger,
  type Module,
  type ModuleContext,
} from "@miyoria/kernel";
import { LlmRouterKey } from "@miyoria/llm";
import {
  ACTIVITY_CHANGED_TOPIC,
  type ActivitySnapshot,
  ARBITER_IMPULSE_TOPIC,
  type ContextKey,
  contextKeyString,
  type Event,
  EventLogKey,
  holdsBack,
  incomingText,
  inspectInput,
  isJsonObject,
  type JsonValue,
  newImpulse,
  PartyOverviewKey,
  PartyRewardsKey,
  PartyStatusKey,
  type PromptContributors,
  PromptContributorsKey,
  pipelineOf,
  type ServiceKey,
  SongClipsKey,
  serviceKey,
  v2Event,
} from "@miyoria/types";
import { partyCapabilities } from "./actions.js";
import { PartyConfigSchema } from "./config.js";
import { LlmSoupJudge } from "./judge.js";
import { PartyPrompt, PROMPT_KEY } from "./prompt.js";
import { type PartyNote, type PartyOutput, type Speaker, Table } from "./table.js";

const log = getLogger("party");

/** The party table, for the Admin API and tests. */
export const PartyTableKey: ServiceKey<Table> = serviceKey<Table>("PartyTable");

/** Her working-context bucket of game events (the prompt section shows the state). */
const WRITER = "party";
const MAX_ENTRIES = 6;
/** What she is busy with that takes her away from a game. */
const AWAY = new Set(["singing", "game", "browse"]);

interface Running {
  table: Table;
  prompts: PromptContributors | null;
  capabilities: (() => void)[];
}

/**
 * What the games tell her. Under V3 an Observation in the EventLog: silent ones are what she
 * knows, the others (source `game.party.*`) may ask the Floor for the mic, once per attention
 * key and revision. Under V2 those become impulses for the Arbiter, like the game director's.
 */
class Notes implements PartyOutput {
  constructor(private readonly ctx: ModuleContext) {}

  note(n: PartyNote): void {
    const services = this.ctx.services;
    try {
      services.get(EventLogKey)?.observe(
        {
          source: `game.party.${n.game}`,
          silent: !n.speak,
          salience: "notable",
          attention_key: n.key,
          revision: n.revision,
          summary: n.summary,
          addressed_to_her: false,
          from: null,
          context: n.context,
        },
        {
          buckets: [
            {
              op: "append-self",
              writer: WRITER,
              owner: PartyModule.ID,
              untrusted: n.untrusted,
              max_entries: MAX_ENTRIES,
            },
          ],
          person: null,
        },
      );
    } catch (error) {
      log.warn({ err: errorMessage(error) }, "cannot tell her about the game");
    }
    if (!n.speak || pipelineOf(services) !== "v2") return;
    const impulse = newImpulse(
      {
        source: "game",
        context: n.context,
        ttlMs: 60_000,
        why: "派對遊戲",
        hint: n.summary,
        reason: "game",
        coalesce_key: `party:${contextKeyString(n.context)}`,
        attention: { key: n.key, repeat_after_ms: 0, revision: n.revision },
      },
      this.ctx.clock.now(),
    );
    this.ctx.publish(v2Event(ARBITER_IMPULSE_TOPIC, impulse));
  }

  ended(): void {}
}

/**
 * Module `party`: party games in voice (docs/design/v4-plan.md §9.1) that she hosts and plays:
 * turtle soup, song guessing, word chains and quizzes. One game per voice channel; players answer
 * by speaking or by typing in the channel's text chat.
 *
 * Nothing here speaks or starts by itself: a game begins only with her `party_start`, she runs it
 * with `party_host` / `party_play` / `party_ask`, and what happens in it reaches her as
 * Observations (source `game.party.<game>`) and the prompt section `party`. Services used (all
 * optional): `ActuatorRegistry`, `PromptContributors`, `EventLog`, `LlmRouter` (the turtle-soup
 * referee), `SongClips` (song clips, from the singing module), `PartyRewards` (coins).
 */
export class PartyModule implements Module {
  static readonly ID = "party";
  readonly manifest = defineManifest(PartyModule.ID, "Party games", {
    description: "Voice party games she hosts and plays: turtle soup, song guessing, chains, quiz",
    optional: ["facts", "llm", "actions", "agent", "voice", "sing", "economy", "moderation"],
    configSchema: PartyConfigSchema,
  });
  readonly #random: () => number;
  #running: Running | null = null;

  /** `random`: replaces `Math.random` (tests). */
  constructor(options: { random?: () => number } = {}) {
    this.#random = options.random ?? Math.random;
  }

  async start(ctx: ModuleContext): Promise<void> {
    const cfg = ctx.config(PartyConfigSchema);
    const services = ctx.services;
    const judge = new LlmSoupJudge(
      () => services.get(LlmRouterKey) ?? null,
      cfg.judge_purpose,
      cfg.judge_timeout_ms,
    );
    const table = new Table({
      config: cfg,
      clock: ctx.clock,
      random: this.#random,
      output: new Notes(ctx),
      rewards: () => services.get(PartyRewardsKey) ?? null,
      clips: () => services.get(SongClipsKey) ?? null,
      judge: () => (services.has(LlmRouterKey) ? judge : null),
      warn: (message, detail) => log.warn({ err: errorMessage(detail) }, message),
    });
    const actuators = actuatorsFor(ctx);
    const capabilities = partyCapabilities(table, cfg.permissions).map((c) =>
      actuators.register(c),
    );
    const prompts = services.get(PromptContributorsKey) ?? null;
    prompts?.register(new PartyPrompt(table));
    ctx.provide(PartyTableKey, table);
    // The admin panel's read-only look: its absence means the module is off, not that no game runs.
    ctx.provide(PartyOverviewKey, { snapshot: () => table.snapshot() });
    // What the main line asks before it offers the game's tools and tells her the program judges.
    ctx.provide(PartyStatusKey, {
      running: (context) => {
        const session = table.session(context);
        return session === null || session.ended !== null
          ? null
          : { game: session.game.id, title: session.game.title };
      },
    });

    const events = ctx.subscribe([
      "platform.ready",
      "platform.message.created",
      "voice.joined",
      "voice.left",
      "voice.participants",
      "voice.utterance",
      ACTIVITY_CHANGED_TOPIC,
    ]);
    ctx.spawn("events", async () => {
      for await (const env of events) {
        try {
          this.#onEvent(ctx, table, env.event);
        } catch (error) {
          log.warn({ err: errorMessage(error) }, "party event failed");
        }
      }
    });
    this.#running = { table, prompts, capabilities };
  }

  #onEvent(ctx: ModuleContext, table: Table, event: Event): void {
    switch (event.type) {
      case "platform_ready":
        table.self(event.data.self_account);
        return;
      case "voice_joined":
      case "voice_participants":
        table.members(event.data.context, event.data.participants);
        return;
      case "voice_left":
        table.left(event.data.context);
        return;
      case "voice_utterance": {
        const u = event.data;
        if (u.speaker.is_bot) return;
        const speaker = { account: u.speaker.account, name: u.speaker.display_name };
        this.#heard(
          ctx,
          table,
          u.context,
          speaker,
          u.text,
          u.id,
          "voice",
          `voice:utterance:${u.id}`,
        );
        return;
      }
      case "platform_message_created": {
        const m = event.data;
        if (m.author.is_bot || table.session(m.id.context) === null) return;
        const speaker = { account: m.author.account, name: m.author.display_name };
        const origin = `msg:${m.id.context.platform}:${m.id.id}`;
        this.#heard(ctx, table, m.id.context, speaker, incomingText(m), m.id.id, "chat", origin);
        return;
      }
      case "custom":
        if (event.data.topic === ACTIVITY_CHANGED_TOPIC)
          this.#onActivity(table, event.data.payload);
        return;
      default:
        return;
    }
  }

  /**
   * A line of a player. What people say is hostile input like anywhere else: the input defence
   * judges it first, and what it holds back does not reach the game.
   */
  #heard(
    ctx: ModuleContext,
    table: Table,
    context: ContextKey,
    speaker: Speaker,
    text: string,
    id: string,
    source: "voice" | "chat",
    origin: string,
  ): void {
    if (table.session(context) === null || table.isSelf(speaker.account)) return;
    const verdict = inspectInput(ctx.services, {
      id,
      text,
      source,
      author: speaker.account,
      context,
    });
    if (holdsBack(verdict)) return;
    table.input(context, speaker, text, origin);
  }

  /** She went off to sing, play a game or browse: games end. */
  #onActivity(table: Table, payload: JsonValue): void {
    if (!isJsonObject(payload)) return;
    const snapshot = payload as unknown as ActivitySnapshot;
    const activity = snapshot.activity;
    if (activity === undefined || !AWAY.has(activity.type)) return;
    if ("phase" in activity && (activity.phase === "starting" || activity.phase === "running")) {
      table.away();
    }
  }

  async stop(): Promise<void> {
    const running = this.#running;
    this.#running = null;
    if (!running) return;
    running.table.close();
    running.prompts?.unregister(PROMPT_KEY);
    for (const unregister of running.capabilities) unregister();
  }
}
