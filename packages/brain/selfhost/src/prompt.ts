// The blocks around the transcript (`PromptSource`), read from the services today's turn reads
// (agent/turn.ts `#extras`, `#mainSlow`, `#mainPrompt`, `#styleNote`); no new memory:
//
//   1 fixed     the persona core (`PersonaHandle.corePrompt`); the runner adds its rules
//   3 pinned    the owner's rules (`MainLine.ownerRules`: directives, capabilities on hold)
//   4 place     her skills (`SkillIndex`), the server's emoji and her notebook's index (the
//               contributors' slow sections), 「今天的你」 (`LifeLog`), the recap of this place
//               (`ConversationStates`), the people here as person cards (`PersonProfiles.render`,
//               else today's `<person/>` lines, `peopleBody`) and the persona's example
//               dialogues, rotated per session. Rendered again only when the people here change,
//               the transcript was compacted or one of the slow parts reads differently
//   6 recalled  what memory retrieval finds for this run (`MemoryRetrieval`), the contributors'
//               sections (just now, elsewhere, her working notes, a game's chat, ...: everything
//               but the memory contributor, the recap and the slow ones), the cause of her mood,
//               the commitments memory pins, what people wrote in her working context, the
//               viewers' wishes, the notices that came back, and the flagged messages the
//               transcript points to
//   7 now       time and place, her state (`selfBlocks`), how she feels toward the people here
//               now (the heart's warmth, grudge, longing: `heartNowBody`), what the outside told her, the party
//               game running here, the tasks in flight, what she promised and by when, the lines
//               around a replied-to message she cannot see (`parent.ts`); then the
//               `<style_note>` (`styleNote`: lorebook entries, a few kaomoji)
//
// Each source keeps today's budget and limit (`contributor_timeout_ms`); a source that fails or is
// slow is left out, the run goes on. The contributors are asked once per run, for blocks 4 and 6.
// A spoken run (`slowReads`) waits on none of the slow ones: what does not depend on the line is
// read as last made for the people here, the rest is waited for `live_context_ms`.

import type { ContentPart } from "@miyoria/llm/llm";
import {
  FLAGGED_TITLE,
  flaggedBody,
  type TranscriptEntry,
  type TranscriptStore,
} from "@miyoria/memory/transcript";
import { errorMessage } from "@miyoria/runtime/kernel";
import {
  type AccountRef,
  ActivityManagerKey,
  AffectStateKey,
  ArbiterKey,
  accountRefString,
  type ContextKey,
  ConversationStatesKey,
  contextKeyString,
  DATA_OPEN,
  DirectivesKey,
  dataBlock,
  GoalAgendaKey,
  HeartKey,
  type LedgerView,
  LifeLogKey,
  MemoryRetrievalKey,
  type Participant,
  PartyStatusKey,
  PersonProfilesKey,
  type PromptContributors,
  PromptContributorsKey,
  type PromptRequest,
  type PromptSection,
  SelfDocumentKey,
  SelfStateKey,
  SkillIndexKey,
  safeName,
  sameAccount,
  type TurnRetrievalQuery,
  toTimestamp,
  WorkingContextKey,
  WorldStateKey,
} from "@miyoria/types";
import {
  type Agent,
  budgetBlocks,
  budgetSelf,
  contextData,
  contextState,
  contributedData,
  exampleDialogues,
  examplesBlock,
  FEELING_TITLE,
  feelingCauseBody,
  type Gathered,
  gather,
  heartNowBody,
  LIFE_TITLE,
  levelHint,
  MOOD_MIN,
  mergeGathered,
  moodStyleLines,
  noticesBlock,
  PRESENT_TITLE,
  type PresentPerson,
  partyLine,
  peopleBody,
  pickKaomoji,
  pinnedSection,
  RECENT_OWN_LINES,
  rotatedExamples,
  SCAN_LINES,
  selfBlocks,
  stableHash,
  styleNote,
  timeout,
  triggeredEntries,
  truncate,
  whenAndWhere,
} from "../../agent/src/index.js";
import { type PromptInput, type PromptSource, wakeAuthor } from "../../self/src/index.js";
import { NOTICES_TITLE, TASKS_HEAD, VIEWERS_TITLE } from "./texts.js";

/** People shown in block 4 at most (today's `MAX_PEOPLE`). */
const MAX_PEOPLE = 10;
/** Lines before the run the contributors see (today's `CONTRIBUTOR_HISTORY`). */
const CONTRIBUTOR_HISTORY = 6;
/** Newest lines the flagged block looks through (today's `FLAGGED_HISTORY`). */
const FLAGGED_LINES = 12;
/** The waking author's newest lines that make the query. */
const QUERY_LINES = 3;
/** Contributors whose words come from elsewhere here: memory (retrieval), the recap (block 4). */
const MEMORY_CONTRIBUTOR = "memory";
const RECAP_CONTRIBUTOR = "conversation";
/** Contributor sections of block 4 (today's `SLOW_ORDER`), the most stable first. */
const SLOW_ORDER: readonly string[] = ["server_emoji", "notebook"];
const SLOW_SECTIONS: ReadonlySet<string> = new Set(SLOW_ORDER);
/** No budget but the blocks' own. */
const UNLIMITED = Number.MAX_SAFE_INTEGER;
const DAY_MS = 86_400_000;
/** The recap's title (the conversation contributor's). */
export const RECAP_TITLE = "這段對話的前情提要";

/**
 * `<style_note>`'s sentences from her feelings now (`moodStyleLines`: her talkativeness, her
 * mood's valence), when `[modules.agent.prompt] mood_style` is on; none without her feelings.
 */
export function moodStyle(agent: Agent, voice: boolean): string[] {
  if (!agent.config.prompt.mood_style) return [];
  try {
    const snap = agent.ctx.services.get(AffectStateKey)?.snapshot() ?? null;
    if (snap === null) return [];
    return moodStyleLines(
      { talkativeness: snap.biases.talkativeness, valence: snap.mood.valence },
      voice,
    );
  } catch (error) {
    agent.log.debug({ err: errorMessage(error) }, "no feelings for the style note");
    return [];
  }
}

/** Someone who spoke in a place, newest first. */
export interface Speaker {
  account: AccountRef;
  name: string;
}

/** The people who spoke in `entries`, newest first, bots and tombstones left out. */
export function speakersOf(entries: readonly TranscriptEntry[], max = MAX_PEOPLE): Speaker[] {
  const out: Speaker[] = [];
  for (let i = entries.length - 1; i >= 0 && out.length < max; i--) {
    const e = entries[i] as TranscriptEntry;
    if (e.kind !== "other" || e.bot || e.account === null || e.redacted_at !== null) continue;
    if (out.some((s) => sameAccount(s.account, e.account as AccountRef))) continue;
    out.push({ account: e.account, name: e.author ?? e.account.id });
  }
  return out;
}

/** `name: text` of the other people's lines (hers as `name`), the way contributors read lines. */
function lineText(e: TranscriptEntry, her: string): string | null {
  if (e.redacted_at !== null || e.content.trim() === "") return null;
  if (e.kind === "other") return `${safeName(e.author ?? "")}: ${e.content}`;
  if (e.kind === "self" || (e.kind === "tool_calls" && e.content !== "")) {
    return `${her}: ${e.content}`;
  }
  return null;
}

/**
 * The contributors of a run that reads warm (the old turn's `#gatherVoice`): those kept warm as
 * they were last read for the people here (and read again in the background), the others asked
 * now and waited for `liveMs`.
 */
async function warmGather(
  registry: PromptContributors,
  request: PromptRequest,
  skip: readonly string[],
  reads: SlowReads,
  signal: AbortSignal,
): Promise<Gathered> {
  const keys = registry
    .all()
    .map((c) => c.key)
    .filter((k) => !skip.includes(k));
  const kept = keys.filter((k) => reads.warmContributors.includes(k));
  const live = keys.filter((k) => !kept.includes(k));
  const [warmed, asked] = await Promise.all([
    kept.length === 0
      ? undefined
      : reads.warm("contributors", accountsKey(request.participants), () =>
          gather(registry, request, WARM_LOAD_MS, signal, [...skip, ...live]),
        ),
    live.length === 0
      ? undefined
      : gather(registry, request, reads.liveMs, signal, [...skip, ...kept]),
  ]);
  return mergeGathered(warmed, asked);
}

/** The accounts of `people`, as one key. */
function accountsKey(people: readonly { account: AccountRef }[]): string {
  return people
    .map((p) => accountRefString(p.account))
    .sort()
    .join(",");
}

/** The entries after her last line: what a run is about. */
function sinceHerLast(entries: readonly TranscriptEntry[]): TranscriptEntry[] {
  let since = entries.length;
  while (since > 0) {
    const e = entries[since - 1] as TranscriptEntry;
    if (e.kind === "self" || e.kind === "tool_calls") break;
    since -= 1;
  }
  return entries.slice(since).filter((e) => e.kind === "other" && e.redacted_at === null);
}

interface PlaceCache {
  key: string;
  text: string | null;
}

/** What one run reads once for several blocks. */
interface RunRead {
  request: PromptRequest;
  /** The lines the run answers (the waking author's newest, since her last line). */
  asked: TranscriptEntry[];
  gathered: Promise<Gathered | null>;
  reads: SlowReads | null;
}

/** A value kept warm per place (`SlowReads.warm`). */
export type WarmSlot = "contributors" | "skills" | "pinned" | "people";

/**
 * How a run reads what is slow to read when nobody may wait for it (voice, the old turn's
 * `warm_context`): what does not depend on the line is read as it was last made for the people
 * here and made again in the background; what does is waited for `liveMs`, then left out.
 */
export interface SlowReads {
  /** The run is spoken (contributors are told so). */
  voice: boolean;
  /** Contributors read warm (`[modules.agent.voice] warm_contributors`). */
  warmContributors: readonly string[];
  /** How long what depends on the line is waited for (`live_context_ms`). */
  liveMs: number;
  /**
   * `load`'s value kept in `slot`, made for `key` (what it depends on) and the people listening,
   * refreshed for the next run; `undefined`: not there in time.
   */
  warm<T>(slot: WarmSlot, key: string, load: () => Promise<T>): Promise<T | undefined>;
}

/** What is made in the background for a later run may take this long (the old `WARM_LOAD_MS`). */
const WARM_LOAD_MS = 10_000;

/** Heading of her own document in the pinned block (she writes it herself, each night). */
const SELF_TITLE = "# 你自己(你每晚寫給自己的,最近的你)";

export interface HostPromptOptions {
  transcript: TranscriptStore;
  /** The session a place's transcript is under. */
  sessionOf(context: ContextKey): string;
  /** The files and images of the run's lines (block 6); unset: none. */
  attachments?(input: PromptInput): Promise<ContentPart[]>;
  /** How the run of `input` reads its slow sources; unset or `null`: each within its limit. */
  slowReads?(input: PromptInput): SlowReads | null;
  /** Her inbox for the run of `input` (block 6, last); unset or `null`: none. */
  inbox?(input: PromptInput): string | null;
  /** Her starts today that the Arbiter's ledger does not count (her initiative's); unset: none. */
  startsToday?(now: number): number;
  /** The lines around a replied-to message she cannot see (block 7); unset or `null`: none. */
  replyContext?(input: PromptInput): Promise<string | null>;
  /**
   * Who else is in the place of `input` besides the people who spoke there (the members of the
   * voice channel she is in); unset: nobody.
   */
  present?(input: PromptInput): readonly Speaker[];
}

export class HostPrompt implements PromptSource {
  readonly #agent: Agent;
  readonly #o: HostPromptOptions;
  /** Block 4 of each session as last rendered. */
  readonly #places = new Map<string, PlaceCache>();
  /** What each run in flight read, by turn. */
  readonly #runs = new Map<string, RunRead>();
  /** The people the blocks of each run in flight name, by turn (whom an `@name` may tag). */
  readonly #named = new Map<string, Speaker[]>();
  /** 「今天的你」 as last written, with what it was written from. */
  #life: PlaceCache | null = null;

  constructor(agent: Agent, options: HostPromptOptions) {
    this.#agent = agent;
    this.#o = options;
  }

  get #services() {
    return this.#agent.ctx.services;
  }

  /** Minutes east of UTC, as today's prompt takes them (the machine's zone). */
  #offset(now: number): number {
    return -new Date(now).getTimezoneOffset();
  }

  #limit(): number {
    return this.#agent.config.contributor_timeout_ms;
  }

  #present(speakers: readonly Speaker[]): PresentPerson[] {
    return speakers.map((s) => ({
      account: s.account,
      handle: this.#agent.handleOf(s.account, s.name),
      person: this.#agent.attitude(s.account)?.person ?? null,
      speaker: false,
    }));
  }

  /** What the run of `input` reads once: the contributors' request and their sections. */
  #run(input: PromptInput): RunRead {
    const known = this.#runs.get(input.turn);
    if (known !== undefined) return known;
    const entries = this.#o.transcript.tail(input.session.id).entries;
    const reads = this.#o.slowReads?.(input) ?? null;
    const { request, asked } = this.#request(input, entries, reads?.voice ?? false);
    const registry = this.#services.get(PromptContributorsKey);
    const skip = [
      RECAP_CONTRIBUTOR,
      ...(this.#services.has(MemoryRetrievalKey) ? [MEMORY_CONTRIBUTOR] : []),
    ];
    const signal = this.#agent.ctx.signal;
    const gathered =
      registry && registry.all().length > 0
        ? (reads === null
            ? gather(registry, request, this.#limit(), signal, skip)
            : warmGather(registry, request, skip, reads, signal)
          ).catch(() => null)
        : Promise.resolve(null);
    const read: RunRead = { request, asked, gathered, reads };
    this.#runs.set(input.turn, read);
    return read;
  }

  /** The run of `turn` ended; what it read is forgotten. */
  ended(turn: string): void {
    this.#runs.delete(turn);
    this.#named.delete(turn);
  }

  /** The people the blocks of the run of `turn` name (block 4's people, block 7's). */
  named(turn: string): readonly Speaker[] {
    return this.#named.get(turn) ?? [];
  }

  #name(turn: string, people: readonly Speaker[]): void {
    const known = this.#named.get(turn) ?? [];
    for (const p of people) {
      if (!known.some((k) => sameAccount(k.account, p.account))) known.push(p);
    }
    this.#named.set(turn, known);
  }

  /** The people of the place of `input`: who spoke there, whoever woke her, who else is there. */
  #here(input: PromptInput): Speaker[] {
    const out = speakersOf(this.#o.transcript.tail(input.session.id).entries);
    const author = wakeAuthor(input.wake);
    const more = [...(author === null ? [] : [author]), ...(this.#o.present?.(input) ?? [])];
    for (const p of more) {
      if (!out.some((o) => sameAccount(o.account, p.account))) {
        out.push({ account: p.account, name: p.name });
      }
    }
    return out;
  }

  // ---- block 1 ---------------------------------------------------------------------------------

  async fixed(): Promise<string | null> {
    return this.#agent.persona.corePrompt();
  }

  // ---- block 3 ---------------------------------------------------------------------------------

  async pinned(input: PromptInput): Promise<string | null> {
    const context = input.session.context;
    const rules = this.#agent.mainline.ownerRules(context);
    const pinned = pinnedSection(rules, [], input.now, this.#offset(input.now));
    const self = this.#services
      .get(SelfDocumentKey)
      ?.read(this.#agent.config.prompt.self_chars)
      .trim();
    if (self === undefined || self === "") return pinned;
    const own = `${SELF_TITLE}\n${self}`;
    return pinned === null ? own : `${pinned}\n\n${own}`;
  }

  // ---- block 4 ---------------------------------------------------------------------------------

  async place(input: PromptInput): Promise<string | null> {
    const session = input.session.id;
    const tail = this.#o.transcript.tail(session);
    const speakers = speakersOf(tail.entries);
    this.#name(input.turn, speakers);
    const roster = speakers
      .map((s) => `${s.account.platform}:${s.account.id}`)
      .sort()
      .join(",");
    const slow = await this.#slow(input);
    // What block 4 shows of the people from the heart (tier, the slow words, call name,
    // impression, stance): a change there is a new block. A line someone says changes none of it.
    const hearts = this.#heartKey(this.#present(speakers));
    const key = `${roster}|${tail.summary?.id ?? 0}|${stableHash(slow.join("\n"))}|${hearts}`;
    const cached = this.#places.get(session);
    if (cached !== undefined && cached.key === key) return cached.text;
    const { text, settled } = await this.#renderPlace(input, speakers, slow);
    // Read warm and not ready yet (the people's cards): made again next run, not kept as is.
    if (settled) this.#places.set(session, { key, text });
    return text;
  }

  /** Forgets block 4 of `session` (its people or its transcript changed under it). */
  forget(session: string): void {
    this.#places.delete(session);
  }

  /** A hash of what block 4 shows of `present` from the heart (the fallback body's text). */
  #heartKey(present: readonly PresentPerson[]): string {
    const heart = this.#services.get(HeartKey) ?? null;
    if (heart === null || present.length === 0) return "";
    const body = peopleBody(present, { attitude: (a) => this.#agent.attitude(a), heart });
    return String(stableHash(body));
  }

  async #renderPlace(
    input: PromptInput,
    speakers: readonly Speaker[],
    slow: readonly string[],
  ): Promise<{ text: string | null; settled: boolean }> {
    const agent = this.#agent;
    const context = input.session.context;
    const parts: string[] = [...slow];
    const recap = this.#services.get(ConversationStatesKey)?.get(context)?.recap?.trim() ?? "";
    if (recap !== "") parts.push(dataBlock(RECAP_CONTRIBUTOR, RECAP_TITLE, recap));
    const { body: people, settled } = await this.#people(input, speakers);
    if (people !== null) parts.push(dataBlock("people", PRESENT_TITLE, people));
    const chars = agent.config.mainline.examples_chars;
    if (chars > 0) {
      const dialogues = exampleDialogues(agent.persona.examples());
      const picked = rotatedExamples(dialogues, stableHash(input.session.id), chars);
      const examples = examplesBlock(picked, agent.persona.names());
      if (examples !== null) parts.push(examples);
    }
    return { text: parts.length === 0 ? null : parts.join("\n\n"), settled };
  }

  /**
   * The slow parts of block 4 (the old turn's `#mainSlow`), each within its own budget: her
   * skills, the server's emoji, her notebook's index, 「今天的你」.
   */
  async #slow(input: PromptInput): Promise<string[]> {
    const m = this.#agent.config.mainline;
    const read = this.#run(input);
    const [skills, gathered] = await Promise.all([this.#skills(read.reads), read.gathered]);
    const out: string[] = [];
    if (skills !== null) {
      // The skill index comes as a data block; anything else is made one.
      out.push(skills.includes(DATA_OPEN) ? skills : dataBlock("skills", "你的技能", skills));
    }
    const sections: PromptSection[] = (gathered?.sections ?? [])
      .filter((s) => SLOW_SECTIONS.has(s.key))
      .sort((a, b) => SLOW_ORDER.indexOf(a.key) - SLOW_ORDER.indexOf(b.key))
      .map((s, i) => ({ ...s, order: i }));
    const life = this.#lifeText(input.now);
    if (life !== null) {
      sections.push({ key: "life", title: LIFE_TITLE, body: life, order: sections.length });
    }
    const { data } = contributedData(sections);
    const budgeted = budgetBlocks(data, {
      total: UNLIMITED,
      budgets: { server_emoji: m.emoji_chars, notebook: m.notebook_chars, life: m.life_chars },
      defaultBudget: m.notebook_chars,
    });
    out.push(...budgeted.blocks);
    return out;
  }

  /** Her skills, a name and a line each (`SkillIndex`); `null` when none or too slow. */
  async #skills(reads: SlowReads | null): Promise<string | null> {
    const agent = this.#agent;
    const index = this.#services.get(SkillIndexKey);
    const chars = agent.config.mainline.skills_chars;
    if (index === undefined || chars <= 0) return null;
    if (reads !== null) {
      // The index as it was last read: it changes when she learns a skill.
      const text = await reads.warm("skills", `skills:${chars}`, async () => {
        const read = await timeout(WARM_LOAD_MS, agent.ctx.signal, () => index.index(chars));
        return read.trim() === "" ? null : read;
      });
      return text ?? null;
    }
    try {
      const text = await timeout(this.#limit(), agent.ctx.signal, () => index.index(chars));
      return text.trim() === "" ? null : text;
    } catch (error) {
      agent.log.debug({ err: errorMessage(error) }, "no skill index for the runner");
      return null;
    }
  }

  /**
   * 「今天的你」 (the old turn's `#mainLife`): what she did today, or the last days when nothing yet
   * today. Written again only when what she did changes.
   */
  #lifeText(now: number): string | null {
    const agent = this.#agent;
    const life = this.#services.get(LifeLogKey);
    if (life === undefined || agent.config.mainline.life_chars <= 0) return null;
    try {
      const today = life.today();
      const scope = today.length > 0 ? "today" : "lately";
      const entries = today.length > 0 ? today : life.entries(now - 3 * DAY_MS);
      const key = `${scope}|${entries.map((e) => e.id).join(",")}`;
      if (this.#life !== null && this.#life.key === key) return this.#life.text;
      const text = life.summary(scope);
      const body = text === null || text.trim() === "" ? null : text;
      this.#life = { key, text: body };
      return body;
    } catch (error) {
      agent.log.debug({ err: errorMessage(error) }, "no life log for the runner");
      return null;
    }
  }

  /**
   * The people here as cards, else as `<person/>` lines. `settled`: false when the cards were read
   * warm and are still being written (this run has the lines).
   */
  async #people(
    input: PromptInput,
    speakers: readonly Speaker[],
  ): Promise<{ body: string | null; settled: boolean }> {
    const agent = this.#agent;
    const present = this.#present(speakers);
    if (present.length === 0) return { body: null, settled: true };
    const chars = agent.config.mainline.people_chars;
    const profiles = this.#services.get(PersonProfilesKey);
    let settled = true;
    if (profiles !== undefined && chars > 0) {
      const where = {
        context: input.session.context,
        present: present.flatMap((p) => (p.person === null ? [] : [p.person])),
        talking_with: [],
        accounts: present.map((p) => p.account),
        now: toTimestamp(input.now),
      };
      const render = async (limit: number): Promise<string | null> => {
        const body = await timeout(limit, agent.ctx.signal, (s) =>
          profiles.render(where, chars, {}, s),
        );
        return body.trim() === "" ? null : body.trim();
      };
      const reads = this.#run(input).reads;
      try {
        if (reads === null) return { body: await render(this.#limit()), settled: true };
        const key = `${accountsKey(present)}|${this.#heartKey(present)}`;
        const read = await reads.warm("people", key, () => render(WARM_LOAD_MS));
        if (read !== undefined) return { body: read, settled: true };
        settled = false;
      } catch (error) {
        agent.log.debug({ err: errorMessage(error) }, "no person profiles for the runner");
      }
    }
    const services = this.#services;
    const body = peopleBody(present, {
      attitude: (a) => agent.attitude(a),
      heart: services.get(HeartKey) ?? null,
    });
    return { body: body === "" ? null : body, settled };
  }

  // ---- block 6 ---------------------------------------------------------------------------------

  async recalled(input: PromptInput): Promise<string | null> {
    const agent = this.#agent;
    const cfg = agent.config;
    const m = cfg.mainline;
    const services = this.#services;
    const context = input.session.context;
    const tail = this.#o.transcript.tail(input.session.id);
    const read = this.#run(input);
    const { request } = read;
    const blocks: string[] = [];
    const [memory, pinned] = await Promise.all([
      this.#memory(input, request, read.reads),
      this.#pinnedMemory(input, request, read.reads),
    ]);
    if (memory !== null) blocks.push(memory);
    const gathered = await read.gathered;
    const sections = (gathered?.sections ?? []).filter((s) => !SLOW_SECTIONS.has(s.key));
    const { data } = contributedData(sections);
    const contributed = budgetBlocks(data, {
      total: m.data_chars,
      budgets: { ...cfg.prompt.budgets, just_now: m.just_now_chars, elsewhere: m.elsewhere_chars },
      defaultBudget: cfg.prompt.default_budget,
    });
    blocks.push(...contributed.blocks);
    const present = this.#present(speakersOf(tail.entries));
    const feeling = feelingCauseBody({
      context,
      now: input.now,
      affect: services.get(AffectStateKey) ?? null,
      self: services.get(SelfStateKey) ?? null,
      presentPeople: present.flatMap((p) => (p.person === null ? [] : [p.person])),
    });
    if (feeling !== "") blocks.push(dataBlock("feeling", FEELING_TITLE, feeling));
    blocks.push(...pinned);
    const buckets = services.get(WorkingContextKey)?.buckets(context) ?? [];
    const working = contextData(buckets, m.context_entries);
    if (working !== null) blocks.push(working);
    const wishes = services.get(DirectivesKey)?.wishes(context) ?? [];
    if (wishes.length > 0) blocks.push(dataBlock("viewers", VIEWERS_TITLE, wishes.join("\n")));
    const notices = noticesBlock({ context, now: input.now, notices: agent.takeNotices(context) });
    const noticed = notices.split("\n").slice(1).join("\n");
    if (noticed !== "") blocks.push(dataBlock("notices", NOTICES_TITLE, noticed));
    const flagged = flaggedBody(tail.entries.slice(-FLAGGED_LINES));
    if (flagged !== "") blocks.push(dataBlock("flagged", FLAGGED_TITLE, flagged));
    const inbox = this.#o.inbox?.(input) ?? null;
    if (inbox !== null) blocks.push(inbox);
    return blocks.length === 0 ? null : blocks.join("\n\n");
  }

  /** The commitments memory pins for the people here (`PinnedMemory`, the old `#mainMemory`). */
  async #pinnedMemory(
    input: PromptInput,
    request: PromptRequest,
    reads: SlowReads | null,
  ): Promise<string[]> {
    const agent = this.#agent;
    const pinned = agent.mainline.pinned();
    if (pinned === null) return [];
    try {
      const load = (limit: number) =>
        timeout(limit, agent.ctx.signal, () =>
          pinned.pinned({
            context: input.session.context,
            present: request.participants.flatMap((p) => (p.person === null ? [] : [p.person])),
            accounts: request.participants.map((p) => p.account),
            now: toTimestamp(input.now),
          }),
        );
      // Spoken, they come warm: they depend on who is here, not on the line.
      const read =
        reads === null
          ? await load(this.#limit())
          : await reads.warm("pinned", accountsKey(request.participants), () => load(WARM_LOAD_MS));
      if (read === undefined) return [];
      return read.sections
        .filter((s) => s.key === "commitments" && s.lines.length > 0)
        .map((s) => dataBlock(`pinned.${s.key}`, s.title, s.lines.join("\n")));
    } catch (error) {
      agent.log.debug({ err: errorMessage(error) }, "no pinned memory for the runner");
      return [];
    }
  }

  async #memory(
    input: PromptInput,
    request: PromptRequest,
    reads: SlowReads | null,
  ): Promise<string | null> {
    const agent = this.#agent;
    const retrieval = this.#services.get(MemoryRetrievalKey);
    if (!retrieval || request.query.trim() === "") return null;
    const m = agent.config.mainline;
    const now = toTimestamp(input.now);
    try {
      const query: TurnRetrievalQuery = {
        context: input.session.context,
        present: request.participants.flatMap((p) => (p.person === null ? [] : [p.person])),
        accounts: request.participants.map((p) => p.account),
        now,
        text: request.query,
        recent: request.recent.slice(-m.memory_recent_lines),
        talking_with: request.participants.flatMap((p) =>
          p.person !== null && request.speakers.some((s) => sameAccount(s, p.account))
            ? [p.person]
            : [],
        ),
        ...(m.memory_lines > 0 ? { limit: m.memory_lines } : {}),
        ...(reads !== null ? { voice: true } : {}),
      };
      // What depends on the line: spoken, it is waited for only `liveMs`.
      const memories = await timeout(reads?.liveMs ?? this.#limit(), agent.ctx.signal, (signal) =>
        retrieval.retrieve(query, signal),
      );
      const body = retrieval.format(memories, now);
      if (body.trim() === "") return null;
      return dataBlock("memory", "你記得的事", truncate(body, Math.floor(m.data_chars / 2)));
    } catch (error) {
      agent.log.debug({ err: errorMessage(error) }, "no memories for the runner");
      return null;
    }
  }

  /** What the contributors are told of this run (today's `#promptRequest`), and what it answers. */
  #request(
    input: PromptInput,
    entries: readonly TranscriptEntry[],
    voice: boolean,
  ): { request: PromptRequest; asked: TranscriptEntry[] } {
    const agent = this.#agent;
    const her = agent.persona.displayName();
    const speakers = speakersOf(entries);
    const participants: Participant[] = speakers.map((s) => ({
      account: s.account,
      display_name: s.name,
      person: agent.attitude(s.account)?.person ?? null,
    }));
    const author = wakeAuthor(input.wake);
    if (author !== null && !participants.some((p) => sameAccount(p.account, author.account))) {
      participants.push({
        account: author.account,
        display_name: author.name,
        person: agent.attitude(author.account)?.person ?? null,
      });
    }
    const fresh = sinceHerLast(entries);
    const wake = input.wake;
    let query: string;
    let asked: TranscriptEntry[];
    if (wake.kind === "result") {
      query = wake.text;
      asked = [];
    } else if (wake.kind === "timer") {
      query = wake.note;
      asked = [];
    } else if (wake.kind === "world") {
      query = wake.what;
      asked = [];
    } else {
      const theirs =
        author === null
          ? fresh
          : fresh.filter((e) => e.account !== null && sameAccount(e.account, author.account));
      asked = theirs.slice(-QUERY_LINES);
      query = asked.map((e) => lineText(e, her) ?? "").join("\n");
    }
    const first = asked[0];
    const before = (first === undefined ? entries : entries.slice(0, entries.indexOf(first)))
      .map((e) => lineText(e, her))
      .filter((l): l is string => l !== null);
    const request: PromptRequest = {
      profile: agent.persona.read((p) => p.id),
      turn: input.turn,
      context: input.session.context,
      participants,
      speakers: author === null ? [] : [author.account],
      query,
      recent: before.slice(-CONTRIBUTOR_HISTORY),
      voice,
      now: toTimestamp(input.now),
    };
    return { request, asked };
  }

  async attachments(input: PromptInput): Promise<ContentPart[]> {
    return (await this.#o.attachments?.(input)) ?? [];
  }

  // ---- block 7 ---------------------------------------------------------------------------------

  /** The Arbiter's ledger with her initiative's starts of today added to its count. */
  #ledger(context: ContextKey, now: number): LedgerView | null {
    const view = this.#services.get(ArbiterKey)?.ledger(context) ?? null;
    const own = this.#o.startsToday?.(now) ?? 0;
    if (view === null || own === 0) return view;
    return {
      ...view,
      limits: { ...view.limits, initiatives_today: view.limits.initiatives_today + own },
    };
  }

  async now(input: PromptInput): Promise<string | null> {
    const agent = this.#agent;
    const services = this.#services;
    const context = input.session.context;
    const offset = this.#offset(input.now);
    const tail = this.#o.transcript.tail(input.session.id);
    const present = this.#present(speakersOf(tail.entries));
    const own = selfBlocks({
      context,
      now: input.now,
      affect: services.get(AffectStateKey) ?? null,
      activity: services.get(ActivityManagerKey)?.snapshot() ?? null,
      ledger: this.#ledger(context, input.now),
      goals: services.get(GoalAgendaKey)?.goals() ?? null,
      present: present.map((p) => p.handle),
      mood: agent.mood(),
      self: services.get(SelfStateKey) ?? null,
      her: services.get(WorldStateKey)?.snapshot().her ?? null,
      level: levelHint(agent.handle.channelMode(context), context),
      notices: [],
    });
    const lines = [whenAndWhere(context, new Date(input.now), offset)];
    // What the outside told her and she trusts (the working context's state), then her own.
    const buckets = services.get(WorkingContextKey)?.buckets(context) ?? [];
    const notes = [
      ...contextState(buckets),
      ...budgetSelf(own, agent.config.mainline.self_chars).notes,
    ];
    for (const note of notes) {
      const block = note.trim();
      if (block !== "") lines.push(block);
    }
    // How she feels toward the people here now: the heart's values that move by the day.
    const here = this.#here(input);
    this.#name(input.turn, here);
    const feeling = heartNowBody(this.#present(here), services.get(HeartKey) ?? null);
    if (feeling !== "") lines.push(feeling);
    // A party game's verdicts are the program's: her state, not data.
    const party = services.get(PartyStatusKey)?.running(context) ?? null;
    if (party !== null) lines.push(partyLine(party));
    const tasks = agent.mainline.tasks();
    if (tasks.length > 0) {
      lines.push(
        `${TASKS_HEAD}\n${tasks.map((t) => `- ${t.task}(${t.owner}):${t.text}`).join("\n")}`,
      );
    }
    const promised = pinnedSection([], agent.mainline.commitments.open(context), input.now, offset);
    if (promised !== null) lines.push(promised);
    const replied = (await this.#o.replyContext?.(input)) ?? null;
    if (replied !== null) lines.push(replied);
    return lines.join("\n");
  }

  /**
   * `<style_note>` (the old turn's `#styleNote`): the lorebook entries what was just said or her
   * mood brings up, and a few kaomoji for her mood she has not used lately.
   */
  async style(input: PromptInput): Promise<string | null> {
    const agent = this.#agent;
    const book = agent.persona.lorebook();
    const moods = this.#moods();
    const entries = this.#o.transcript.tail(input.session.id).entries;
    const { asked } = this.#run(input);
    const others = entries
      .filter((e) => e.kind === "other" && e.redacted_at === null && !asked.includes(e))
      .slice(-SCAN_LINES);
    const scan = [...others, ...asked].map((e) => e.content).join("\n");
    const lore = triggeredEntries(book, scan, moods, false);
    const own = entries
      .filter((e) => (e.kind === "self" || e.kind === "tool_calls") && e.content !== "")
      .slice(-RECENT_OWN_LINES)
      .map((e) => e.content);
    const last = entries.at(-1)?.seq ?? 0;
    const seed = stableHash(`${contextKeyString(input.session.context)}:${input.now}:${last}`);
    return styleNote(false, pickKaomoji(book, moods, own, seed), lore, moodStyle(agent, false));
  }

  /** Her emotions now, by name: the tag she shows and the strongest ones she feels. */
  #moods(): Set<string> {
    const services = this.#services;
    const moods = new Set<string>();
    try {
      const snap = services.get(AffectStateKey)?.snapshot() ?? null;
      const self = services.get(SelfStateKey) ?? null;
      const shown = snap !== null ? snap.shown : (self?.shown() ?? null);
      if (shown !== null) moods.add(shown.tag);
      const felt = snap !== null ? snap.top : (self?.emotions() ?? []);
      for (const e of felt.slice(0, 2)) if (e.intensity >= MOOD_MIN) moods.add(e.name);
    } catch (error) {
      this.#agent.log.debug({ err: errorMessage(error) }, "no mood for the lorebook");
    }
    if (moods.size === 0) moods.add("neutral");
    return moods;
  }
}
