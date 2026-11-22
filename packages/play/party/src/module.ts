import { CommandMount } from "@miyoria/commands";
import { actuatorsFor } from "@miyoria/gate/actions";
import { LlmRouterKey } from "@miyoria/llm/llm";
import {
  defineManifest,
  errorMessage,
  getLogger,
  type Module,
  type ModuleCard,
  type ModuleCardFact,
  type ModuleContext,
} from "@miyoria/runtime/kernel";
import {
  type ActivitySnapshot,
  type BusEvent,
  type ContextKey,
  CurrencyKey,
  contextKeyString,
  DEFAULT_CURRENCY,
  EventLogKey,
  Events,
  GameSecretsKey,
  HeartKey,
  holdsBack,
  incomingText,
  inspectInput,
  is,
  isJsonObject,
  type JsonValue,
  PartyOutcomesKey,
  PartyOverviewKey,
  PartyRewardsKey,
  PartyStatusKey,
  type PromptContributors,
  PromptContributorsKey,
  type ServiceKey,
  SocialSignalsKey,
  SongClipsKey,
  serviceKey,
} from "@miyoria/types";
import { partyCapabilities } from "./actions.js";
import { registerCommands } from "./commands.js";
import { PartyConfigSchema } from "./config.js";
import { LlmSoupJudge } from "./judge.js";
import { PartyPrompt, PROMPT_KEY } from "./prompt.js";
import { type PartyEnded, type PartyNote, type PartyOutput, type Speaker, Table } from "./table.js";

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
  commands: CommandMount;
  prompts: PromptContributors | null;
  capabilities: (() => void)[];
}

/**
 * What the games tell her. Under V3 an Observation in the EventLog: silent ones are what she
 * knows, the others (source `game.party.*`) may ask the Floor for the mic, once per attention
 * key and revision.
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
  }

  /**
   * How it came out goes to whoever settles on it (`PartyOutcomes`: the economy's predictions),
   * and everyone who played it is evidence for her nightly reflection on them (`played_together`).
   */
  ended(info: PartyEnded): void {
    const services = this.ctx.services;
    try {
      services.get(PartyOutcomesKey)?.ended({
        session: info.session,
        game: info.game,
        context: info.context,
        reason: info.reason,
        solved: info.solved,
      });
    } catch (error) {
      log.warn({ err: errorMessage(error) }, "cannot tell how the game came out");
    }
    const heart = services.get(HeartKey);
    const people = services.get(SocialSignalsKey);
    if (heart?.evidence === undefined || people === undefined) return;
    const at = this.ctx.clock.now();
    for (const p of info.players) {
      try {
        const person = people.attitude(p.account)?.person;
        if (person === undefined) continue;
        heart.evidence({
          person,
          kind: "played_together",
          detail: `一起玩了${info.title}`,
          weight: null,
          at,
          session: contextKeyString(info.context),
        });
      } catch (error) {
        log.warn({ err: errorMessage(error) }, "cannot record a game played together");
      }
    }
  }
}

/**
 * Module `party`: party games (docs/design/v4-plan.md §9.1, v5-play.md §5) that she hosts:
 * turtle soup and song guessing. One game per channel; players answer by speaking or by typing in
 * the voice channel's text chat, and a turtle soup can be played in a text channel altogether.
 *
 * Nothing here speaks or starts by itself: a game begins only with her `party_start` (anyone can
 * ask her for one), she runs it
 * with `party_host` / `party_play` / `party_ask`, and what happens in it reaches her as
 * Observations (source `game.party.<game>`) and the prompt section `party`. Services used (all
 * optional): `ActuatorRegistry`, `PromptContributors`, `EventLog`, `LlmRouter` (the turtle-soup
 * referee), `SongClips` (song clips, from the singing module), `PartyRewards` (coins).
 */
export class PartyModule implements Module {
  static readonly ID = "party";
  readonly manifest = defineManifest(PartyModule.ID, "Party games", {
    icon: "party-popper",
    category: "play",
    description:
      "Party games she hosts: turtle soup (voice or text channel) and song guessing (voice)",
    optional: [
      "facts",
      "llm",
      "actions",
      "agent",
      "voice",
      "sing",
      "economy",
      "moderation",
      "commands",
    ],
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
      currency: () => services.get(CurrencyKey) ?? DEFAULT_CURRENCY,
      clips: () => services.get(SongClipsKey) ?? null,
      judge: () => (services.has(LlmRouterKey) ? judge : null),
      warn: (message, detail) => log.warn({ err: errorMessage(detail) }, message),
    });
    const actuators = actuatorsFor(ctx);
    const capabilities = partyCapabilities(table, cfg.permissions).map((c) =>
      actuators.register(c),
    );
    // `/game party`: the same start, asked for with a command (and from the `/miyo` panel).
    let paths: string[] = [];
    const commands = new CommandMount(
      "party",
      (registry) => {
        paths = registerCommands(registry, cfg.permissions, actuators);
      },
      (registry) => {
        for (const path of paths) registry.unregister(path);
      },
    );
    commands.attach(ctx);
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
    // What the line guard asks before every line of hers: does it give away the game's secret?
    ctx.provide(GameSecretsKey, {
      leak: (context, text) => {
        const session = table.session(context);
        if (session === null || session.ended !== null) return null;
        return session.game.leak?.(text) ?? null;
      },
    });

    const events = ctx.subscribe([
      Events.PlatformReady.type,
      Events.PlatformMessageCreated.type,
      Events.VoiceJoined.type,
      Events.VoiceLeft.type,
      Events.VoiceParticipants.type,
      Events.VoiceUtteranceEvent.type,
      Events.ActivityChanged.type,
    ]);
    ctx.spawn("events", async () => {
      for await (const env of events) {
        try {
          this.#onEvent(ctx, table, env);
        } catch (error) {
          log.warn({ err: errorMessage(error) }, "party event failed");
        }
      }
    });
    this.#running = { table, commands, prompts, capabilities };
  }

  #onEvent(ctx: ModuleContext, table: Table, event: BusEvent): void {
    if (is(Events.PlatformReady, event)) {
      table.self(event.data.self_account);
      return;
    } else if (is(Events.VoiceJoined, event) || is(Events.VoiceParticipants, event)) {
      table.members(event.data.context, event.data.participants);
      return;
    } else if (is(Events.VoiceLeft, event)) {
      table.left(event.data.context);
      return;
    } else if (is(Events.VoiceUtteranceEvent, event)) {
      const u = event.data;
      if (u.speaker.is_bot) return;
      const speaker = { account: u.speaker.account, name: u.speaker.display_name };
      this.#heard(ctx, table, u.context, speaker, u.text, u.id, "voice", `voice:utterance:${u.id}`);
      return;
    } else if (is(Events.PlatformMessageCreated, event)) {
      const m = event.data;
      if (m.author.is_bot || table.session(m.id.context) === null) return;
      const speaker = { account: m.author.account, name: m.author.display_name };
      const origin = `msg:${m.id.context.platform}:${m.id.id}`;
      this.#heard(ctx, table, m.id.context, speaker, incomingText(m), m.id.id, "chat", origin);
      return;
    } else {
      if (event.type === Events.ActivityChanged.type)
        this.#onActivity(table, event.data as JsonValue);
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

  /**
   * The games going on now and what they are, and the last game that ended. The results are kept
   * in memory, a few and only since the start, so there is no count of the day's games.
   */
  async card(): Promise<ModuleCard> {
    const running = this.#running;
    if (!running) return { facts: [] };
    const { sessions, recent } = running.table.snapshot();
    const facts: ModuleCardFact[] = [{ label: "進行中", value: sessions.length, unit: "場" }];
    if (sessions.length > 0) {
      facts.push({ label: "正在玩", value: [...new Set(sessions.map((s) => s.title))].join("、") });
    }
    const last = recent[0];
    if (last !== undefined) facts.push({ label: "上一場", value: last.title });
    return { facts };
  }

  async stop(): Promise<void> {
    const running = this.#running;
    this.#running = null;
    if (!running) return;
    running.table.close();
    running.commands.detach();
    running.prompts?.unregister(PROMPT_KEY);
    for (const unregister of running.capabilities) unregister();
  }
}
