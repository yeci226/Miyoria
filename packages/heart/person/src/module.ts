// Module `heart`: the owner of `heart_person` (docs/design/v5-heart.md §2.9, §2.10). It puts the
// rules of its config section (`[modules.heart]`, `HeartPersonConfigSchema` and the module's own
// keys) in force, moves the old records over once (owner decision H8), runs the daily pass, counts
// the lines people say, writes the evidence it hears on the bus, and provides `HeartKey` for
// everyone else: the host applies her `feel` through it, the prompt, her initiative and the
// nightly reflection read and write it.
//
// Since phase 4 step 5 it is also who people are (`directory.ts`, the old `social` module's
// account map and `/me link`), which it provides as `SocialSignalsKey` (an `Attitude` from the
// row) and `PeopleDirectoryKey`, with `/me profile | call | link`, `/admin person ...` and the
// tool `set_call_name`.
//
// Config changes reach it the way they reach every module: the supervisor restarts it, and `start`
// puts the section's rules in force again (`setRules`).

import { CommandMount } from "@miyoria/commands";
import { actuatorsFor } from "@miyoria/gate/actions";
import {
  defineManifest,
  errorMessage,
  interval,
  type Logger,
  type Module,
  type ModuleCard,
  type ModuleContext,
  sleep,
} from "@miyoria/runtime/kernel";
import type { Profile } from "@miyoria/runtime/profile";
import {
  IdentityStoreKey,
  PeopleStoreKey,
  type Relationship,
  type RelationshipDelta,
  type SettingsStore,
  StoreKey,
} from "@miyoria/store";
import {
  type AccountRef,
  AuthorizerKey,
  type BusEvent,
  CharacterKey,
  type Clock,
  CurrencyKey,
  contextKeyString,
  DEFAULT_CHARACTER,
  DEFAULT_CURRENCY,
  Events,
  type FeelProposal,
  type HeartActivity,
  type HeartDay,
  type HeartEvidenceInput,
  HeartKey,
  type HeartLine,
  type HeartPeople,
  type HeartReflected,
  type HeartReflection,
  type HeartView,
  is,
  isJsonObject,
  type JsonValue,
  ModerationKey,
  type PersonId,
  PicturesKey,
  type ProfileId,
  parseSongCue,
  RelationshipEffectsKey,
  SocialSignalsKey,
  toTimestamp,
} from "@miyoria/types";
import { z } from "zod";
import { callNameCapability } from "./call-name-tool.js";
import {
  registerCommands,
  type ScreenCallName,
  UNFIT_CALL_NAME,
  unregisterCommands,
} from "./commands.js";
import { HeartPersonConfigSchema } from "./config.js";
import { PeopleDirectory, PeopleDirectoryKey } from "./directory.js";
import { HeartEffects } from "./effects.js";
import type { LegacyResult } from "./legacy.js";
import { BLOCKED_TAG, type HeartPerson, hasTag, isProposalField } from "./model.js";
import { readOldCards } from "./old-cards.js";
import { BondRingImagesKey } from "./ring-image.js";
import { CARES_THRESHOLD, cares, dayStart, type HeartChangeRequest, localDay } from "./rules.js";
import { type HeartStore, heartTables } from "./store.js";
import { Together } from "./together.js";
import { viewOf } from "./view.js";

/** `[modules.heart]`: the rules of `heart_person`, and how often the daily pass looks. */
export const HeartConfigSchema = HeartPersonConfigSchema.extend({
  /**
   * How often (minutes) the daily pass looks for people whose local day it has not run for yet.
   * It runs once per person and local day however often it looks.
   */
  decay_check_mins: z.number().int().positive().default(10),
  /** Accounts the authorizer treats as owners get the `owner` tag. */
  auto_owner_tag: z.boolean().default(true),
});

export type HeartConfig = z.output<typeof HeartConfigSchema>;

/** Settings key that records the migration ran (owner decision H8): it never runs twice. */
export const MIGRATED_KEY = "heart:migrated";
/**
 * Settings key with her own accounts as `PlatformReady` told them: after a restart of this module
 * they are known before the platform says them again, so her own lines are never counted as a
 * person's.
 */
export const SELF_ACCOUNTS_KEY = "heart:self_accounts";
/** Where `self` keeps its state (`SelfModule`'s `STATE_KEY`), with the old `hearts`. */
const SELF_STATE_KEY = "self:state";
/** At most this many people are looked through for the one she cares about most. */
const MOST_CARED_POOL = 200;

export { viewOf } from "./view.js";

/** `HeartKey`: the store's rows, read and moved by the rules. */
export class HeartService implements HeartPeople {
  readonly #people: HeartStore;
  readonly #clock: Clock;
  readonly #isBot: (person: PersonId) => boolean;

  /** `isBot`: whether a person is a bot, as far as the platform said (no evidence, no row). */
  constructor(
    people: HeartStore,
    clock: Clock,
    options: { isBot?: (person: PersonId) => boolean } = {},
  ) {
    this.#people = people;
    this.#clock = clock;
    this.#isBot = options.isBot ?? (() => false);
  }

  feel(
    person: PersonId,
    proposals: readonly FeelProposal[],
    options: { turn: string | null; now?: number },
  ): number {
    const row = this.#people.get(person);
    if (row !== null && hasTag(row, BLOCKED_TAG)) return 0;
    const requests: HeartChangeRequest[] = [];
    for (const p of proposals) {
      if (!isProposalField(p.field)) continue;
      requests.push({ type: "propose", field: p.field, direction: p.direction, quote: p.quote });
    }
    if (requests.length === 0) return 0;
    return this.#people.applyAll(person, requests, {
      now: options.now ?? this.#clock.now(),
      turn: options.turn,
    }).length;
  }

  seen(person: PersonId, line: HeartLine): void {
    this.#people.seen(person, line);
  }

  view(person: PersonId): HeartView | null {
    const row = this.#people.get(person);
    return row === null ? null : viewOf(row);
  }

  cares(person: PersonId): number {
    const row = this.#people.get(person);
    return row === null || hasTag(row, BLOCKED_TAG) ? 0 : cares(row);
  }

  mostCared(among?: readonly PersonId[]): { person: PersonId; cares: number } | null {
    if (among === undefined) return this.#cared()[0] ?? null;
    return rank(among.flatMap((p) => this.#people.get(p) ?? []))[0] ?? null;
  }

  caredAbout(max: number): { person: PersonId; cares: number }[] {
    return this.#cared().slice(0, Math.max(0, max));
  }

  /**
   * Writes a piece of evidence. Someone without a row gets one (a listener who never said a word
   * still has a day the nightly reflection should see), unless they are a bot; nothing about
   * someone blocked.
   */
  evidence(input: HeartEvidenceInput): void {
    const row = this.#people.get(input.person);
    if (row !== null && hasTag(row, BLOCKED_TAG)) return;
    const ms = input.at ?? this.#clock.now();
    const at = toTimestamp(ms);
    if (row === null) {
      if (this.#isBot(input.person)) return;
      this.#people.edit(input.person, {}, { now: ms });
    }
    this.#people.appendEvidence(
      {
        person: input.person,
        kind: input.kind,
        detail: input.detail,
        weight: input.weight,
        at,
      },
      input.session ?? null,
    );
  }

  active(since: number, until: number, max: number): HeartActivity[] {
    return this.#people.active(since, until, max);
  }

  day(person: PersonId, since: number, until: number): HeartDay | null {
    return this.#people.day(person, since, until);
  }

  reflect(
    person: PersonId,
    reflection: HeartReflection,
    options: { now?: number; capsAt?: number } = {},
  ): HeartReflected {
    return this.#people.reflect(person, reflection, {
      now: options.now ?? this.#clock.now(),
      ...(options.capsAt === undefined ? {} : { capsAt: options.capsAt }),
    });
  }

  callNames(): { person: PersonId; call_name: string }[] {
    return this.#people.callNames();
  }

  /**
   * Everyone she cares about, most first, read again at most every `CARED_TTL_MS`: her emotions
   * ask on every event, and who she cares about moves by the day.
   */
  #cared(): { person: PersonId; cares: number }[] {
    const now = this.#clock.now();
    if (this.#caredCache !== null && now - this.#caredCache.at < CARED_TTL_MS) {
      return this.#caredCache.list;
    }
    const list = rank(this.#people.list({ limit: MOST_CARED_POOL }).entries.map((e) => e.person));
    this.#caredCache = { at: now, list };
    return list;
  }

  #caredCache: { at: number; list: { person: PersonId; cares: number }[] } | null = null;
}

/** How long the list of people she cares about is kept before it is read again. */
const CARED_TTL_MS = 60_000;

/** The rows at or above the threshold, as `{person, cares}`, most first (blocked never). */
function rank(rows: readonly HeartPerson[]): { person: PersonId; cares: number }[] {
  const out: { person: PersonId; cares: number }[] = [];
  for (const row of rows) {
    if (hasTag(row, BLOCKED_TAG)) continue;
    const c = cares(row);
    if (c >= CARES_THRESHOLD) out.push({ person: row.person_id, cares: c });
  }
  return out.sort((a, b) => b.cares - a.cares || (a.person < b.person ? -1 : 1));
}

/** What the migration on start reads and writes through. */
export interface MigrationDeps {
  people: HeartStore;
  settings: SettingsStore;
  relationships: {
    list(profile: ProfileId): Promise<Relationship[]>;
    deltasSince(profile: ProfileId, person: PersonId, since: string): Promise<RelationshipDelta[]>;
  };
  profile: ProfileId;
  now: number;
  log: Pick<Logger, "info">;
}

/**
 * The migration from the old records (H8), once: while it never finished (`MIGRATED_KEY`). People
 * who already have a row are skipped (`migrateLegacy`), so rows written by a start whose migration
 * failed are no reason to skip the others. The key is set only once it went through, so a table
 * emptied later is not filled from the old records again, and a failed start tries again on the
 * next one (the error is thrown to the caller). One log line with the counts. The result; `null`
 * when it ran before.
 */
export async function migrateOnStart(d: MigrationDeps): Promise<LegacyResult | null> {
  if ((await d.settings.get(d.profile, MIGRATED_KEY)) !== null) return null;
  const at = toTimestamp(d.now);
  const relationships = await d.relationships.list(d.profile);
  const deltas = new Map<PersonId, RelationshipDelta[]>();
  for (const r of relationships) {
    deltas.set(r.person, await d.relationships.deltasSince(d.profile, r.person, toTimestamp(0)));
  }
  const cards = await readOldCards(d.settings, d.profile);
  const selfState: JsonValue | null = await d.settings.get(d.profile, SELF_STATE_KEY);
  const result = d.people.migrateLegacy(
    { relationships, deltas, cards, selfState },
    { now: d.now },
  );
  await d.settings.set(d.profile, MIGRATED_KEY, {
    at,
    rows: result.rows.length,
    skipped: result.skipped.length,
  });
  d.log.info(
    {
      rows: result.rows.length,
      skipped: result.skipped.length,
      relationships: relationships.length,
      cards: cards.length,
      self_state: selfState !== null,
    },
    "heart: the old records moved to heart_person",
  );
  return result;
}

/** People the daily pass takes before it lets the rest of the process run. */
export const DECAY_BATCH = 50;

/**
 * The daily pass (H9) for everyone it has not run for on the local day of `now` (her day, the
 * rules' `utc_offset_minutes`; `now` from the module's clock, so tests set the day). Every
 * `batch` people it waits for `pause` (a turn of the event loop), so a pass over many people
 * never holds up what else the process does.
 */
export async function runDecay(
  people: HeartStore,
  now: number,
  options: { batch?: number; pause?: () => Promise<void> } = {},
): Promise<{ people: number; changes: number }> {
  const batch = Math.max(1, options.batch ?? DECAY_BATCH);
  const pause = options.pause ?? (() => sleep(0));
  let done = 0;
  let changes = 0;
  let inBatch = 0;
  for (const person of people.decayDue(now)) {
    if (inBatch >= batch) {
      await pause();
      inBatch = 0;
    }
    inBatch += 1;
    const pass = people.applyDecay(person, { now });
    if (pass === null) continue;
    done += 1;
    changes += pass.changes.length;
  }
  return { people: done, changes };
}

/**
 * Time together in her voice channel and the songs people heard her sing (`together.ts`), written
 * as evidence for whoever the bus's accounts are (`personOf`; someone it does not know is left
 * out).
 */
export function togetherOf(
  personOf: (account: AccountRef) => PersonId | null,
  heart: Pick<HeartService, "evidence">,
): { on(env: BusEvent, now: number): void } {
  const together = new Together((stay) => {
    const person = personOf(stay.account);
    if (person === null) return;
    heart.evidence({
      person,
      kind: "voice_together",
      detail: `在你的語音頻道一起待了 ${stay.minutes} 分鐘`,
      weight: stay.minutes,
      at: stay.at,
      session: contextKeyString(stay.context),
    });
  });
  return {
    on(env, now) {
      if (is(Events.VoiceJoined, env)) {
        together.joined(env.data.context, env.data.participants, now);
      } else if (is(Events.VoiceParticipants, env)) {
        together.participants(env.data.context, env.data.participants, now);
      } else if (is(Events.VoiceLeft, env)) {
        together.left(env.data.context, now);
      } else if (env.type === Events.SingCue.type) {
        const cue = parseSongCue(env.data as JsonValue);
        if (cue?.state === "started") together.songStarted(cue.title);
        if (cue?.state !== "ended") return;
        for (const heard of together.songEnded(cue.outcome === "finished", "", now)) {
          const person = personOf(heard.account);
          if (person === null) continue;
          const title =
            heard.title === "" ? "一首歌" : `〈${[...heard.title].slice(0, 60).join("")}〉`;
          heart.evidence({
            person,
            kind: "heard_song",
            detail: `聽你唱完了${title}`,
            weight: null,
            at: heard.at,
            session: contextKeyString(heard.context),
          });
        }
      }
    },
  };
}

export interface HeartModuleOptions {
  /** Replaces the module context's clock (tests). */
  clock?: Clock;
  /** Her display name and the names people call her by (a line naming her is said to her). */
  name?: string;
  names?: readonly string[];
}

/** The accounts of a stored list (`SELF_ACCOUNTS_KEY`); anything else in it is skipped. */
function parseAccounts(value: JsonValue | null): AccountRef[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((v) =>
    isJsonObject(v) && typeof v.platform === "string" && typeof v.id === "string"
      ? [{ platform: v.platform, id: v.id }]
      : [],
  );
}

/** What a line someone said is, as the heart counts it. */
interface Line {
  account: AccountRef;
  display_name: string;
  text: string;
  /** Said to her: a mention, a reply, a DM. */
  directed: boolean;
  /** Said in the voice channel she is in (she hears only that one). */
  voice: boolean;
}

/** The line of a chat or voice event from someone other than her; `null` for anything else. */
export function lineOf(env: BusEvent, people: PeopleDirectory): Line | null {
  if (is(Events.PlatformMessageCreated, env)) {
    const m = env.data;
    if (m.author.is_bot || people.isSelf(m.author.account)) return null;
    return {
      account: m.author.account,
      display_name: m.author.display_name,
      text: m.text,
      directed: m.mentions_self || m.reply_to_self || m.id.context.kind === "dm",
      voice: false,
    };
  }
  if (is(Events.VoiceUtteranceEvent, env)) {
    const u = env.data;
    if (u.speaker.is_bot || people.isSelf(u.speaker.account)) return null;
    return {
      account: u.speaker.account,
      display_name: u.speaker.display_name,
      text: u.text,
      directed: false,
      voice: true,
    };
  }
  return null;
}

/** A call name moderation would refuse, through `ModerationKey` when it runs. */
function screenWith(ctx: ModuleContext): ScreenCallName {
  return async (call) => {
    const moderation = ctx.services.get(ModerationKey);
    if (!moderation) return null;
    try {
      const verdict = await moderation.screenAsync({ path: "other", visible: call });
      return verdict.ok ? null : UNFIT_CALL_NAME;
    } catch {
      return null;
    }
  };
}

export class HeartModule implements Module {
  static readonly ID = "heart";
  readonly manifest = defineManifest(HeartModule.ID, "Heart", {
    icon: "heart",
    category: "her",
    description:
      "Her numbers and words for each person (heart_person) and who people are: her feel proposals, the lines people say, evidence, the daily pass, /me and /admin person",
    optional: ["commands", "actions", "auth", "moderation"],
    configSchema: HeartConfigSchema,
  });
  readonly #profile: ProfileId;
  readonly #options: HeartModuleOptions;
  #stop: (() => void) | null = null;
  /** The rows and the clock, for the card on the panel, while it runs with a store. */
  #running: { people: HeartStore; clock: Clock } | null = null;

  constructor(profile: ProfileId, options: HeartModuleOptions = {}) {
    this.#profile = profile;
    this.#options = options;
  }

  /** Uses the profile's id, display name and nicknames. */
  static fromProfile(profile: Profile, options: HeartModuleOptions = {}): HeartModule {
    return new HeartModule(profile.id, {
      name: profile.displayName,
      names: profile.names(),
      ...options,
    });
  }

  async start(ctx: ModuleContext): Promise<void> {
    const config = ctx.config(HeartConfigSchema);
    const clock = this.#options.clock ?? ctx.clock;
    const store = ctx.services.get(StoreKey);
    if (store === undefined) {
      ctx.log.warn("no store: the heart is not kept");
      return;
    }
    const people = store.plugin(heartTables).people;
    people.setRules(config);
    this.#running = { people, clock };
    try {
      await migrateOnStart({
        people,
        settings: store.settings,
        relationships: store.relationships,
        profile: this.#profile,
        now: clock.now(),
        log: ctx.log,
      });
    } catch (error) {
      // The old records stay where they are and the key is not set: the next start tries again.
      ctx.log.error(
        { err: errorMessage(error) },
        "heart: the old records could not be moved; the next start tries again",
      );
    }
    const directory = new PeopleDirectory(
      this.#profile,
      this.#options.name ?? "",
      this.#options.names ?? [],
      {
        people: ctx.services.get(PeopleStoreKey) ?? store.people,
        identity: ctx.services.get(IdentityStoreKey) ?? store.identity ?? null,
        heart: people,
      },
      clock,
      { autoOwnerTag: config.auto_owner_tag },
    );
    directory.setAuthorizer(ctx.services.get(AuthorizerKey) ?? null);
    try {
      for (const account of parseAccounts(
        await store.settings.get(this.#profile, SELF_ACCOUNTS_KEY),
      )) {
        directory.addSelfAccount(account);
      }
    } catch (error) {
      ctx.log.warn({ err: errorMessage(error) }, "heart: cannot read her own accounts");
    }
    try {
      await directory.load();
    } catch (error) {
      ctx.log.warn({ err: errorMessage(error) }, "heart: cannot load who people are");
    }
    const service = new HeartService(people, clock, {
      isBot: (person) => directory.isBotPerson(person),
    });
    ctx.provide(HeartKey, service);
    ctx.provide(SocialSignalsKey, directory);
    ctx.provide(PeopleDirectoryKey, directory);
    // The economy's small gift and deal effects, on `heart_person` with cause `evidence`.
    ctx.provide(RelationshipEffectsKey, new HeartEffects(people));

    const screen = screenWith(ctx);
    const commands = new CommandMount(
      "heart",
      (registry) =>
        registerCommands(
          registry,
          directory,
          screen,
          () => ctx.services.get(BondRingImagesKey),
          () => ctx.services.get(PicturesKey),
          {
            coin: ctx.services.get(CurrencyKey) ?? DEFAULT_CURRENCY,
            her: (ctx.services.get(CharacterKey) ?? DEFAULT_CHARACTER).pronoun,
          },
        ),
      unregisterCommands,
    );
    commands.attach(ctx);
    // Her tool `set_call_name`: the speaker's own 稱呼, said in chat.
    const off = actuatorsFor(ctx).register(callNameCapability(directory, screen));
    this.#stop = () => {
      commands.detach();
      off();
    };

    const together = togetherOf(
      (account) =>
        directory.isSelf(account) || directory.isBot(account) ? null : directory.personOf(account),
      service,
    );
    // Subscribe before returning so no event published after start is missed.
    const sub = ctx.subscribe([
      Events.PlatformReady.type,
      Events.PlatformVoiceState.type,
      Events.PlatformMember.type,
      Events.PlatformMessageCreated.type,
      Events.VoiceUtteranceEvent.type,
      Events.VoiceJoined.type,
      Events.VoiceParticipants.type,
      Events.VoiceLeft.type,
      Events.SingCue.type,
    ]);
    ctx.spawn("events", async () => {
      for await (const env of sub) {
        const now = clock.now();
        try {
          if (is(Events.PlatformReady, env)) {
            if (directory.addSelfAccount(env.data.self_account)) {
              await store.settings.set(
                this.#profile,
                SELF_ACCOUNTS_KEY,
                directory.selfAccounts().map((a) => ({ platform: a.platform, id: a.id })),
              );
            }
            continue;
          }
          // Which accounts are bots: they get no row and no evidence.
          if (is(Events.PlatformVoiceState, env) || is(Events.PlatformMember, env)) {
            directory.noteBot(env.data.account, env.data.is_bot);
            continue;
          }
          if (is(Events.PlatformMessageCreated, env) && env.data.author.is_bot) {
            directory.noteBot(env.data.author.account, true);
          }
          const line = lineOf(env, directory);
          if (line !== null) {
            await countLine(ctx, directory, service, line, now);
            continue;
          }
          // Who is in her voice channel is known by person before their time is counted.
          if (is(Events.VoiceJoined, env) || is(Events.VoiceParticipants, env)) {
            for (const p of env.data.participants) {
              if (p.is_self || directory.isSelf(p.account) || directory.isBot(p.account)) continue;
              await directory.resolve(p.account, p.display_name, now);
            }
          }
          together.on(env, now);
        } catch (error) {
          ctx.log.warn(
            { err: errorMessage(error), event: env.type },
            "heart: cannot take an event",
          );
        }
      }
    });
    const decay = async (signal: AbortSignal) => {
      try {
        const done = await runDecay(people, clock.now(), { pause: () => sleep(0, signal) });
        if (done.changes > 0) ctx.log.debug(done, "heart: the daily pass ran");
      } catch (error) {
        if (signal.aborted) return;
        ctx.log.warn({ err: errorMessage(error) }, "heart: the daily pass failed");
      }
    };
    ctx.spawn("decay", async (signal) => {
      await decay(signal);
      for await (const _ of interval(config.decay_check_mins * 60_000, signal)) await decay(signal);
    });
  }

  /**
   * The people she has a row for, and the ones whose numbers changed today (her local day, the
   * daily pass left out). Her nightly reflection is the `reflect` module's: when it runs and whom
   * it took are not the heart's to tell, so there is no next.
   */
  async card(): Promise<ModuleCard> {
    const running = this.#running;
    if (running === null) return { facts: [] };
    const { people, clock } = running;
    const today = dayStart(localDay(clock.now(), people.rules), people.rules);
    const summary = people.summary(today);
    return {
      facts: [
        { label: "認識的人", value: summary.people, unit: "人" },
        { label: "今天有變動", value: summary.changed, unit: "人" },
      ],
    };
  }

  async stop(): Promise<void> {
    this.#running = null;
    this.#stop?.();
    this.#stop = null;
  }
}

/**
 * One line someone said (`HeartPeople.seen`): who they are (a person is made on first sight),
 * then when she last saw them, talked and was with them, and familiarity. A line in a voice
 * channel is said with her (she hears only the one she is in); one naming her is said to her.
 */
async function countLine(
  ctx: Pick<ModuleContext, "services">,
  directory: PeopleDirectory,
  heart: HeartService,
  line: Line,
  now: number,
): Promise<void> {
  // The authorizer may be replaced at runtime (e.g. by `auth`).
  directory.setAuthorizer(ctx.services.get(AuthorizerKey) ?? null);
  const person = await directory.resolve(line.account, line.display_name, now);
  if (person === null) return;
  const directed = line.directed || directory.mentionsHer(line.text);
  heart.seen(person, { text: line.text, directed, together: line.voice, at: now });
}
