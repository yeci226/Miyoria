// Her own initiative on the new runner (docs/design/v5-architecture.md §7.6, docs/design/
// v5-brain.md B6): opportunity → code gates → her run → what came of it. It replaces the chain
// of the mind's Plan call, the proposal board, the Arbiter's rules and the main line deciding
// again.
//
// Her inbox. What is for her but is not a line of a conversation is an item of the `initiative`
// table: a due schedule of hers, a salient world event, a due followup of memory, an overdue
// promise, a long action's result. It is shown in block 6 of her next run in its place and seen
// once a run that showed it finished. An item of no place (her home) keeps the Space it came from
// (phase 6, docs/design/v5-places.md): it is shown only in the runs of that Space, and an item of
// no Space at all (her own timers, her morning) in every run. A voice event of one server never
// reaches a run in another one. A run at her home place sees the other Spaces merged: one line
// each, its name and how many items of which kind, never their words (`#elsewhere`, at most
// `ELSEWHERE_MAX` places, the rest as "and N more"); `look(place)` (`look-tool.ts`) reads one of
// them as far as memory's place rule allows from there. Transcripts are never merged.
//
// Opportunities, looked at every `tick_secs` and when something arrives:
//
//   timer       an inbox item of a due schedule;
//   commitment  an inbox item of a promise past its time;
//   followup    an inbox item of a due followup;
//   world       an inbox item of a salient world event (score at least mind's threshold);
//   quiet       a place nobody spoke in for `quiet_mins` where her inbox or her promises have
//               something, once per lull;
//   longing     someone she cares about she misses enough, in her DM with them, once a day;
//   morning     her first tick of the day after `[modules.mind] daily_hour`, at her home place.
//
// Each passes the gates (`gates.ts`); the first that stops it is recorded (`arbiter.decision`,
// verdict `rejected`, its reason, `<gate>: <why>` as detail), once per opportunity and gate. One
// that passes wakes her in its place on the text profile (`self`, `timer` or `world`; block 7 says
// why and that she may stay quiet) and is recorded `accepted`; her run is an `arbiter.ledger`
// entry, settled as `ok` (she stayed quiet, or someone answered), `ignored` (nobody answered
// within the reply window) or `failed`. An opportunity wakes her once: whatever came of the run (a
// line whose delivery is unknown included), it is never tried again.

import { ActuatorRegistryKey } from "@miyoria/gate/actions";
import { LlmRouterKey } from "@miyoria/llm/llm";
import type { Viewer } from "@miyoria/memory/memory";
import type { TranscriptStore } from "@miyoria/memory/transcript";
import { errorMessage, interval } from "@miyoria/runtime/kernel";
import { SettingsStoreKey, StoreKey } from "@miyoria/store";
import {
  type AccountRef,
  type AffectBiases,
  AffectStateKey,
  type ArbiterDecision,
  ArbiterKey,
  type ArbiterReason,
  type ContextKey,
  contextKeyEquals,
  contextKeyString,
  dataBlock,
  type Envelope,
  Events,
  FollowupSourceKey,
  HandleDirectoryKey,
  HeartKey,
  type ImpulseSource,
  is,
  isJsonObject,
  type JsonValue,
  type LedgerEntry,
  newId,
  type PersonId,
  PlaceAccessKey,
  PlacesKey,
  type Reminder,
  SocialSignalsKey,
  serviceKey,
  toTimestamp,
} from "@miyoria/types";
import type { Agent } from "../../agent/src/index.js";
import { dayIndex, type LocalTime, localHour } from "../../arbiter/src/index.js";
import type { PromptInput, Wake } from "../../self/src/index.js";
import {
  GateBook,
  type GateFacts,
  type GateName,
  type GateSnapshot,
  keyOf,
  type Opportunity,
  type OpportunityKind,
} from "./gates.js";
import { gateConfig, type InitiativeSettings, initiativeSettings } from "./initiative-config.js";
import { INBOX_KINDS, type InboxKind } from "./initiative-schema.js";
import {
  type InboxRow,
  type InitiativeStore,
  initiativeTables,
  type NewInboxItem,
} from "./initiative-store.js";
import {
  ELSEWHERE,
  ELSEWHERE_TITLE,
  INBOX_HOME,
  INBOX_LABELS,
  INBOX_TITLE,
  WAKE_NOTES,
} from "./initiative-texts.js";
import { lookTool } from "./look-tool.js";
import { localWhen, type ParseAt, type ReminderBackend, ScheduleBook } from "./schedule.js";
import { scheduleTools } from "./schedule-tools.js";

/** Settings key of the gates' books and what already woke her. */
export const INITIATIVE_STATE_KEY = "selfhost:initiative";
/** Ids of opportunities that woke her, kept (inbox items keep their own). */
const MAX_WOKEN = 500;
/** Opportunities whose last stop is remembered, so a stop is recorded once. */
const MAX_STOPS = 500;
/** Runs whose shown inbox items are remembered until they end. */
const MAX_SHOWN = 200;
/** Sessions looked through for a DM with someone she misses. */
const MAX_DM_SESSIONS = 500;
const MINUTE_MS = 60_000;

/** Where each kind of opportunity is recorded (`arbiter.decision` `source`). */
const SOURCE: Readonly<Record<OpportunityKind, ImpulseSource>> = {
  timer: "agenda",
  commitment: "agenda",
  followup: "followup",
  world: "world",
  quiet: "plan",
  longing: "plan",
  morning: "plan",
};

/** A gate as the Arbiter's reason (`arbiter.decision` `reason`). */
const REASON: Readonly<Record<GateName, ArbiterReason>> = {
  no_place: "nobody",
  switch: "paused",
  quiet_hours: "quiet_hours",
  budget: "budget",
  consent: "consent",
  level: "ceiling",
  daily_cap: "rate",
  place_cap: "rate",
  person_cap: "rate",
  min_gap: "cooldown",
  backoff: "cooldown",
  unanswered: "unanswered",
  cooldown: "cooldown",
  same_kind: "repeat",
};

/** Inbox kinds that wake her themselves (a result has a wake of its own already). */
const WAKING: ReadonlySet<string> = new Set(["timer", "commitment", "followup", "world"]);
/** Other places a run at home lists at most; the rest are one "and N more". */
export const ELSEWHERE_MAX = 4;

export interface InitiativeHost {
  agent: Agent;
  transcript: TranscriptStore;
  store: InitiativeStore;
  settings: InitiativeSettings;
  /** Her clock and quiet hours (`[modules.arbiter]`); `null`: none, days in UTC. */
  quiet: LocalTime | null;
  parseAt: ParseAt | null;
  sessionOf(context: ContextKey): string;
  /** Puts `wake` in the lane of `context`; `false` when it could not. */
  wake(context: ContextKey, wake: Wake): boolean;
  /** The places the host has lanes for. */
  places(): ContextKey[];
  /** Whether she is in the voice channel `context` now; unset: never. */
  inVoice?(context: ContextKey): boolean;
}

/** An opportunity that woke her, until its run ends. */
interface Waking {
  o: Opportunity;
  entry: LedgerEntry | null;
}

interface State {
  v: 1;
  gates: GateSnapshot | null;
  woken: string[];
  morning: number | null;
  /** The day her morning was last recorded as having no place to wake her in. */
  morningNoPlace?: number | null;
  /** The entry of her last start at each place, while it waits for an answer. */
  waiting: Record<string, LedgerEntry>;
}

export class Initiative {
  readonly #h: InitiativeHost;
  readonly book: ScheduleBook;
  readonly gates: GateBook;
  readonly #woken: string[] = [];
  readonly #runs = new WeakMap<Wake, Waking>();
  /** Inbox items each run in flight was shown, by turn. */
  readonly #shown = new Map<string, number[]>();
  readonly #stops = new Map<string, GateName>();
  #waiting: Record<string, LedgerEntry> = {};
  #morning: number | null = null;
  #morningNoPlace: number | null = null;
  #ticking: Promise<void> | null = null;
  #loaded: Promise<void> = Promise.resolve();
  #dirty = false;
  #saving: Promise<void> = Promise.resolve();

  constructor(host: InitiativeHost) {
    this.#h = host;
    const agent = host.agent;
    const own = host.settings.own;
    this.book = new ScheduleBook({
      store: host.store,
      now: () => this.#now,
      offsetMinutes: host.quiet?.utc_offset_minutes ?? host.settings.arbiter.utc_offset_minutes,
      limits: {
        max: own.schedules_max,
        perPerson: own.schedules_per_person,
        maxDays: own.schedule_max_days,
      },
      parseAt: host.parseAt,
      publish: (reminder, state) =>
        agent.ctx.publish(Events.MindReminder, {
          state,
          reminder: JSON.parse(JSON.stringify(reminder)) as Reminder,
        }),
    });
    this.gates = new GateBook(gateConfig(host.settings, host.quiet));
  }

  get #now(): number {
    return this.#h.agent.ctx.clock.now();
  }

  get #services() {
    return this.#h.agent.ctx.services;
  }

  /** Loads what was kept and looks every `tick_secs` until `signal` aborts. */
  start(signal: AbortSignal): void {
    this.#loaded = this.#load();
    const agent = this.#h.agent;
    agent.ctx.spawn("selfhost.initiative", async (stop) => {
      const both = AbortSignal.any([stop, signal]);
      await this.#loaded;
      for await (const _ of interval(this.#h.settings.own.tick_secs * 1000, both)) {
        await this.tick();
      }
      await this.#save();
    });
  }

  /** Waits until what was kept is loaded (tests). */
  loaded(): Promise<void> {
    return this.#loaded;
  }

  /** The panel's switch for what she starts herself (the actions gate's pause). */
  paused(): boolean {
    return this.#services.get(ActuatorRegistryKey)?.paused === true;
  }

  // ---- what arrives ---------------------------------------------------------------------------

  /** A line of a person at `context` (`answered`: said to her). */
  line(context: ContextKey, answered: boolean): void {
    const place = keyOf(context);
    this.gates.heard(place, answered);
    if (answered) {
      const entry = this.#waiting[place];
      if (entry !== undefined) {
        delete this.#waiting[place];
        this.#ledger(entry, "ok", "有人回了");
      }
    }
    this.#dirty = true;
  }

  /** Bus events that become inbox items. */
  event(env: Envelope): void {
    if (is(Events.WorldSalient, env)) {
      const s = env.data;
      if (s.score < this.#h.settings.salientMin || s.detail.trim() === "") return;
      // Someone joined the voice channel she is in: greeted there. The other events of a voice
      // place (and a join of a channel she is not in) are for her home, as before.
      const here =
        s.kind === "joined_voice" && s.context !== null && this.#h.inVoice?.(s.context) === true;
      const context = s.context !== null && (s.context.kind !== "voice" || here) ? s.context : null;
      this.#add({
        key: `world:${s.key}:${s.first_at}`,
        kind: "world",
        context,
        // The server it happened in, also when it goes to her home.
        space_id: this.#spaceOf(s.context),
        text: s.detail,
        person: s.display_name,
      });
      this.#soon();
      return;
    }
    if (is(Events.MindReminder, env)) {
      // A timer of mind's own book (when it still runs); the schedule book's own come due in
      // `tick` and their event finds the item there already.
      const { state, reminder } = env.data;
      if (state !== "fired") return;
      this.#add({
        key: `timer:${reminder.id}:${reminder.fired}`,
        kind: "timer",
        context: reminder.context,
        text: reminder.what,
        person: reminder.person,
      });
      this.#soon();
    }
  }

  /** A long action she started came back in `context`: it is in her inbox there too. */
  result(context: ContextKey, job: string, ok: boolean, text: string): void {
    this.#add({
      key: `result:${job}`,
      kind: "result",
      context,
      text: ok ? text : `沒有成功:${text}`,
      person: null,
    });
  }

  /** The Space of a place (identity's id); `null`: none (a DM, her home, a server unknown). */
  #spaceOf(context: ContextKey | null): string | null {
    try {
      return this.#h.store.spaceOf(context);
    } catch (error) {
      this.#h.agent.log.debug({ err: errorMessage(error) }, "no space for an inbox item");
      return null;
    }
  }

  #add(item: Omit<NewInboxItem, "session" | "at">): InboxRow | null {
    const voice = item.context?.kind === "voice";
    const kept = item.kind === "world" && item.context !== null && this.#h.inVoice?.(item.context);
    const context = item.context !== null && (!voice || kept === true) ? item.context : null;
    try {
      return this.#h.store.addItem({
        ...item,
        context,
        // Where it came from, also when it goes to her home: a voice event stays its server's.
        space_id: item.space_id !== undefined ? item.space_id : this.#spaceOf(item.context),
        session: context === null ? null : this.#h.sessionOf(context),
        text: item.text.trim(),
        at: this.#now,
      });
    } catch (error) {
      this.#h.agent.log.warn({ err: errorMessage(error) }, "could not keep an inbox item");
      return null;
    }
  }

  #soon(): void {
    queueMicrotask(() => {
      void this.tick().catch((error: unknown) =>
        this.#h.agent.log.warn({ err: errorMessage(error) }, "an initiative tick failed"),
      );
    });
  }

  // ---- a run ----------------------------------------------------------------------------------

  /** Block 6's inbox for a run: its place's unseen items, and home's of its Space or of none. */
  inboxBlock(input: PromptInput): string | null {
    const rows = this.#h.store.unseenFor(
      input.session.id,
      this.#h.settings.own.inbox_items,
      this.#spaceOf(input.session.context),
    );
    const waking = this.#runs.get(input.wake)?.o.item ?? null;
    const job = input.wake.kind === "result" ? input.wake.job : null;
    const offset = this.book.offsetMinutes;
    const shown: number[] = [];
    const lines: string[] = [];
    for (const row of rows) {
      shown.push(row.id);
      // What woke the run is said in block 7, a result in its own data block.
      if (row.id === waking || (job !== null && row.key === `result:${job}`)) continue;
      const home = row.session === null ? INBOX_HOME : "";
      const at = localWhen(Date.parse(row.created_at), offset);
      lines.push(`- ${at} ${INBOX_LABELS[row.kind]}${home}:${row.text.replace(/\s+/g, " ")}`);
    }
    this.#shown.set(input.turn, shown);
    // A run of another host (voice) never reports its end here.
    while (this.#shown.size > MAX_SHOWN) {
      const oldest = this.#shown.keys().next().value;
      if (oldest === undefined) break;
      this.#shown.delete(oldest);
    }
    const blocks = [
      lines.length === 0 ? null : dataBlock("inbox", INBOX_TITLE, lines.join("\n")),
      this.#elsewhere(input.session.context),
    ].filter((b): b is string => b !== null);
    return blocks.length === 0 ? null : blocks.join("\n\n");
  }

  /** Whether `place` is her home place (`[modules.agent.initiative] home`). */
  atHome(place: ContextKey): boolean {
    const home = this.#home();
    return home !== null && contextKeyEquals(home, place);
  }

  /**
   * In a run at her home: one line for each other Space with something waiting (its name, how
   * many of which kind), the ones with more that would wake her and the latest first, at most
   * `ELSEWHERE_MAX`, the rest as one "and N more". Never an item's words. `null` elsewhere, or
   * when nothing waits.
   */
  #elsewhere(place: ContextKey): string | null {
    if (!this.atHome(place)) return null;
    const places = this.#services.get(PlacesKey);
    if (places === undefined) return null;
    let rows: ReturnType<InitiativeStore["waitingElsewhere"]>;
    try {
      rows = this.#h.store.waitingElsewhere(this.#spaceOf(place));
    } catch (error) {
      this.#h.agent.log.debug({ err: errorMessage(error) }, "no other places for her home");
      return null;
    }
    const bySpace = new Map<
      string,
      { name: string; total: number; waking: number; latest: string; kinds: Map<InboxKind, number> }
    >();
    for (const r of rows) {
      // A Space she left (or never knew) is no place to tell her about.
      const ref = places.space(r.space_id);
      if (ref === null) continue;
      let p = bySpace.get(r.space_id);
      if (p === undefined) {
        p = { name: ref.name, total: 0, waking: 0, latest: "", kinds: new Map() };
        bySpace.set(r.space_id, p);
      }
      p.total += r.n;
      if (WAKING.has(r.kind)) p.waking += r.n;
      if (r.latest > p.latest) p.latest = r.latest;
      p.kinds.set(r.kind, (p.kinds.get(r.kind) ?? 0) + r.n);
    }
    if (bySpace.size === 0) return null;
    const ordered = [...bySpace.values()].sort(
      (a, b) =>
        b.waking - a.waking ||
        (b.latest > a.latest ? 1 : b.latest < a.latest ? -1 : 0) ||
        b.total - a.total,
    );
    const lines = ordered.slice(0, ELSEWHERE_MAX).map((p) =>
      ELSEWHERE.line(
        p.name,
        p.total,
        INBOX_KINDS.filter((k) => p.kinds.has(k)).map((k) => ({ kind: k, n: p.kinds.get(k) ?? 0 })),
      ),
    );
    const more = ordered.length - ELSEWHERE_MAX;
    if (more > 0) lines.push(ELSEWHERE.more(more));
    lines.push(ELSEWHERE.hint);
    return dataBlock("elsewhere", ELSEWHERE_TITLE, lines.join("\n"));
  }

  /**
   * The viewer of memory's place rule for a run at `ctx.context` (the `look` tool): the people
   * the run speaks for, and in a DM the person in it; the platform's access when it has one. The
   * owner's hidden channels are memory's setting and not known here: `PlaceAccess` stands for them.
   */
  viewer(ctx: {
    context: ContextKey;
    account: AccountRef;
    askers?: readonly AccountRef[];
  }): Viewer {
    const accounts = [...(ctx.askers ?? [ctx.account])];
    const social = this.#services.get(SocialSignalsKey);
    const handles = this.#services.get(HandleDirectoryKey);
    const talkingWith = new Set<string>();
    const add = (person: PersonId | null, name: string | null) => {
      const handle = person === null ? null : (handles?.ofPerson(person) ?? null);
      if (handle !== null) talkingWith.add(handle);
      // Inbox items name people as they were shown (a handle, or a display name).
      if (name !== null && name.trim() !== "") talkingWith.add(name);
    };
    for (const a of accounts) {
      const attitude = social?.attitude(a) ?? null;
      add(attitude?.person ?? null, attitude?.display_name ?? null);
    }
    if (ctx.context.kind === "dm") {
      const line = this.#h.transcript
        .tail(this.#h.sessionOf(ctx.context))
        .entries.findLast((e) => e.kind === "other" && (e.person_id !== null || e.author !== null));
      if (line !== undefined) add(line.person_id, line.author);
    }
    return {
      context: ctx.context,
      talkingWith,
      accounts,
      hidden: new Set(),
      access: this.#services.get(PlaceAccessKey) ?? null,
      partners: new Map(),
    };
  }

  /** A run starts: what it is about, for its decision record. */
  runStarted(wake: Wake, turn: string, context: ContextKey): string[] {
    const waking = this.#runs.get(wake);
    if (waking === undefined) return [];
    const o = waking.o;
    if (o.item !== null) this.#h.store.wokeTurn(o.item, turn);
    const now = this.#now;
    const entry: LedgerEntry = {
      id: newId(),
      at: toTimestamp(now),
      kind: "turn",
      source: SOURCE[o.kind],
      self_initiated: true,
      context,
      person: o.person,
      summary: `${o.kind}:${o.note}`,
      outcome: "pending",
      detail: null,
      impulse: o.id,
      turn,
      task: null,
      updated_at: toTimestamp(now),
    };
    waking.entry = entry;
    // The Arbiter's own ledger holds it (the panel's Ledger and block 7 read that one); without an
    // Arbiter the event is all there is.
    const arbiter = this.#services.get(ArbiterKey);
    if (arbiter === undefined) {
      this.#h.agent.ctx.publish(Events.ArbiterLedger, { ...entry });
    } else {
      entry.id = arbiter.record({
        kind: entry.kind,
        source: entry.source,
        context: entry.context,
        person: entry.person,
        summary: entry.summary,
        outcome: entry.outcome,
        detail: entry.detail,
        impulse: entry.impulse,
        turn: entry.turn,
        task: entry.task,
      });
    }
    return [`initiative: ${o.kind}`];
  }

  /**
   * A run ended. `outcome`: the runner's (`said`, `silent`, `failed`, `cancelled`, ...), `null`
   * when it never ran; `spoke`: a line of hers reached its place.
   */
  runEnded(
    wake: Wake,
    turn: string,
    context: ContextKey,
    outcome: string | null,
    spoke: boolean,
  ): void {
    const now = this.#now;
    const shown = this.#shown.get(turn) ?? [];
    this.#shown.delete(turn);
    if (outcome !== null && outcome !== "cancelled") this.#h.store.seen(shown, turn, now);
    const waking = this.#runs.get(wake);
    if (waking === undefined) return;
    this.#runs.delete(wake);
    const entry = waking.entry;
    if (spoke) {
      const place = keyOf(context);
      this.gates.spoke(place, now);
      if (entry !== null) {
        this.#waiting[place] = entry;
        this.#ledger(entry, "pending", "說了,等回應");
      }
    } else if (entry !== null) {
      if (outcome === "silent") this.#ledger(entry, "ok", "她看過了,決定不說");
      else if (outcome === "cancelled") this.#ledger(entry, "failed", "被打斷了");
      else this.#ledger(entry, "failed", outcome ?? "沒有開始");
    }
    this.#dirty = true;
    void this.#save();
  }

  #ledger(entry: LedgerEntry, outcome: LedgerEntry["outcome"], detail: string): void {
    entry.outcome = outcome;
    entry.detail = detail;
    entry.updated_at = toTimestamp(this.#now);
    // An entry the Arbiter no longer has (one kept from before a restart) is only announced.
    if (this.#services.get(ArbiterKey)?.resolve(entry.id, outcome, detail) !== true) {
      this.#h.agent.ctx.publish(Events.ArbiterLedger, { ...entry });
    }
  }

  // ---- looking ----------------------------------------------------------------------------------

  /** One look: what came due becomes inbox items, then every opportunity meets the gates. */
  tick(): Promise<void> {
    if (this.#ticking !== null) return this.#ticking;
    this.#ticking = this.#tick().finally(() => {
      this.#ticking = null;
    });
    return this.#ticking;
  }

  async #tick(): Promise<void> {
    await this.#loaded;
    const now = this.#now;
    this.#dueSchedules(now);
    await this.#dueFollowups(now);
    this.#overduePromises();
    for (const place of this.gates.settle(now)) {
      const entry = this.#waiting[place];
      if (entry === undefined) continue;
      delete this.#waiting[place];
      this.#ledger(entry, "ignored", "沒人回");
    }
    const candidates = await this.#opportunities(now);
    const facts = await this.#facts(now, candidates);
    for (const o of candidates) {
      const verdict = this.gates.check(o, facts);
      if (!verdict.pass) {
        this.#stopped(o, verdict.gate, verdict.detail, verdict.retryAt);
        continue;
      }
      this.#wake(o, now);
    }
    this.#dirty = true;
    await this.#save();
  }

  #dueSchedules(now: number): void {
    for (const row of this.book.takeDue(now)) {
      const whose = row.for_account === null ? "" : "(有人請你設的提醒)";
      this.#add({
        key: `timer:${row.id}:${row.fired}`,
        kind: "timer",
        context: row.context,
        text: `${row.note}${whose}`,
        person: row.person,
      });
    }
  }

  async #dueFollowups(now: number): Promise<void> {
    const source = this.#services.get(FollowupSourceKey);
    if (!source) return;
    const profile = this.#h.agent.persona.read((p) => p.id);
    let due: Awaited<ReturnType<typeof source.due>>;
    try {
      due = await source.due(profile, toTimestamp(now));
    } catch (error) {
      this.#h.agent.log.debug({ err: errorMessage(error) }, "no due followups");
      return;
    }
    const handles = this.#services.get(HandleDirectoryKey);
    for (const f of due) {
      const key = `followup:${f.id}`;
      if (!this.#h.store.hasItem(key)) {
        const person = f.person === null ? null : (handles?.ofPerson(f.person) ?? f.person);
        this.#add({ key, kind: "followup", context: f.context, text: f.about, person });
      }
      try {
        await source.markDone(f.id);
      } catch (error) {
        this.#h.agent.log.debug({ err: errorMessage(error) }, "could not mark a followup done");
      }
    }
  }

  #overduePromises(): void {
    for (const c of this.#h.agent.mainline.commitments.overdue()) {
      this.#add({
        key: `commitment:${c.id}`,
        kind: "commitment",
        context: c.context,
        text: c.what,
        person: null,
      });
    }
  }

  /** Every opportunity now, in the order they are offered to the gates. */
  async #opportunities(now: number): Promise<Opportunity[]> {
    const out: Opportunity[] = [];
    const home = this.#home();
    const homeSpace = this.#spaceOf(home);
    const open = this.#h.store.unseen();
    for (const row of open) {
      if (row.woke_at !== null || !WAKING.has(row.kind)) continue;
      // A home item of a server wakes her only where that server is; elsewhere it waits for a
      // run there (it is never told in another server).
      if (row.context === null && row.space_id !== null && row.space_id !== homeSpace) continue;
      out.push({
        id: row.key,
        kind: row.kind as OpportunityKind,
        place: row.context ?? home,
        person: row.person,
        account: null,
        dm: false,
        note:
          row.kind === "followup"
            ? WAKE_NOTES.followup(row.text)
            : row.kind === "commitment"
              ? WAKE_NOTES.commitment(row.text)
              : row.text,
        item: row.id,
      });
    }
    out.push(...this.#quiet(now, open));
    out.push(...(await this.#longing(now)));
    const morning = this.#morningOf(now, home);
    if (morning !== null) out.push(morning);
    return out.filter((o) => !this.#woken.includes(o.id));
  }

  /** Places that went quiet with something in her inbox or promises there, once per lull. */
  #quiet(now: number, open: readonly InboxRow[]): Opportunity[] {
    // Sooner when she feels like starting things, later when she does not (`#willing`).
    const quietMs = this.#h.settings.own.quiet_mins * MINUTE_MS * this.#willing().factor;
    const places = new Map<string, { place: ContextKey; items: number; promises: number }>();
    const of = (place: ContextKey) => {
      const key = keyOf(place);
      let p = places.get(key);
      if (p === undefined) {
        p = { place, items: 0, promises: 0 };
        places.set(key, p);
      }
      return p;
    };
    // What woke her already is being seen to.
    for (const row of open) {
      if (row.context !== null && row.woke_at === null) of(row.context).items += 1;
    }
    for (const c of this.#h.agent.mainline.commitments.open()) {
      if (c.context.kind !== "voice") of(c.context).promises += 1;
    }
    const out: Opportunity[] = [];
    for (const [key, p] of places) {
      const last = this.#h.transcript.tail(this.#h.sessionOf(p.place)).entries.at(-1);
      if (last === undefined || now - Date.parse(last.at) < quietMs) continue;
      out.push({
        id: `quiet:${key}:${last.seq}`,
        kind: "quiet",
        place: p.place,
        person: null,
        account: null,
        dm: false,
        note: WAKE_NOTES.quiet(p.items, p.promises),
        item: null,
      });
    }
    return out;
  }

  /**
   * How her feelings weigh on her own starts (`mood_weight`; 0: not at all): `factor` multiplies
   * the waits she starts after (less when she wants to start things, `biases.initiative` > 0, more
   * when she does not), and `wants` is how much she wants to talk with each person (`chat_with`,
   * `find_person`), by handle.
   */
  #willing(): { factor: number; wants: Map<string, number> } {
    const weight = this.#h.settings.own.mood_weight;
    const wants = new Map<string, number>();
    if (weight <= 0) return { factor: 1, wants };
    let biases: AffectBiases | null = null;
    try {
      biases = this.#services.get(AffectStateKey)?.snapshot().biases ?? null;
    } catch (error) {
      this.#h.agent.log.debug({ err: errorMessage(error) }, "no feelings for her initiative");
    }
    if (biases === null) return { factor: 1, wants };
    const initiative = Number.isFinite(biases.initiative) ? biases.initiative : 0;
    const factor = Math.min(Math.max(1 - weight * initiative, 0.5), 1.5);
    for (const w of biases.wants) {
      if ((w.want !== "chat_with" && w.want !== "find_person") || w.person === null) continue;
      wants.set(w.person, Math.max(wants.get(w.person) ?? 0, weight * w.weight));
    }
    return { factor, wants };
  }

  /**
   * The one she cares about most, when she misses them enough, in her DM with them, once a day
   * (owner decision H5: the old crush's DM hangs on that person, the heart's 在意). How much she
   * misses them is the heart's longing; how much is enough comes down when her feelings make her
   * want to start things or to talk with them. Nothing without the heart.
   */
  async #longing(now: number): Promise<Opportunity[]> {
    const heart = this.#services.get(HeartKey);
    if (heart === undefined) return [];
    const { factor, wants } = this.#willing();
    const cared = heart.mostCared();
    if (cared === null) return [];
    const view = heart.view(cared.person);
    if (view === null || view.blocked) return [];
    const handle =
      this.#services.get(HandleDirectoryKey)?.ofPerson(cared.person) ??
      this.#services.get(SocialSignalsKey)?.attitudeOf?.(cared.person)?.display_name ??
      view.call_name;
    if (handle === null) return [];
    const min = this.#h.settings.own.longing_min * factor - (wants.get(handle) ?? 0);
    if (view.longing < Math.max(min, 0.05)) return [];
    const id = `longing:${cared.person}:${this.#day(now)}`;
    if (this.#woken.includes(id)) return [];
    const dm = this.#dmWith(cared.person);
    return [
      {
        id,
        kind: "longing",
        place: dm?.place ?? null,
        person: cared.person,
        account: dm?.account ?? null,
        dm: true,
        note: WAKE_NOTES.longing(view.call_name ?? handle),
        item: null,
      },
    ];
  }

  /** Her DM with `person`, from the transcripts: the place and their account there. */
  #dmWith(person: PersonId): { place: ContextKey; account: AccountRef } | null {
    const transcript = this.#h.transcript;
    for (const session of transcript.sessions().slice(0, MAX_DM_SESSIONS)) {
      const place = transcript.contextOf(session);
      if (place?.kind !== "dm") continue;
      const line = transcript
        .tail(session)
        .entries.findLast(
          (e) => e.kind === "other" && e.person_id === person && e.account !== null,
        );
      if (line?.account) return { place, account: line.account };
    }
    return null;
  }

  #morningOf(now: number, home: ContextKey | null): Opportunity | null {
    const day = this.#day(now);
    if (this.#morning === day) return null;
    const clock = this.#h.quiet ?? this.#h.settings.arbiter;
    if (localHour(now, clock) < this.#h.settings.morningHour) return null;
    return {
      id: `morning:${day}`,
      kind: "morning",
      place: home,
      person: null,
      account: null,
      dm: home?.kind === "dm",
      note: WAKE_NOTES.morning,
      item: null,
    };
  }

  #day(now: number): number {
    return dayIndex(now, this.#h.quiet ?? this.#h.settings.arbiter);
  }

  /** `[modules.agent.initiative] home` as a place she knows; `null`: none. */
  #home(): ContextKey | null {
    const home = this.#h.settings.own.home?.trim() ?? "";
    if (home === "") return null;
    const known = [
      ...this.#h.places(),
      ...this.#h.transcript.sessions().flatMap((s) => {
        const c = this.#h.transcript.contextOf(s);
        return c === null ? [] : [c];
      }),
    ];
    return known.find((c) => contextKeyString(c) === home || c.channel === home) ?? null;
  }

  async #facts(now: number, candidates: readonly Opportunity[]): Promise<GateFacts> {
    const services = this.#services;
    const consent = new Map<string, string | null>();
    const registry = services.get(ActuatorRegistryKey);
    const social = services.get(SocialSignalsKey);
    for (const o of candidates) {
      if (!o.dm || o.account === null) continue;
      const key = `${o.account.platform}:${o.account.id}`;
      if (consent.has(key)) continue;
      let why: string | null = null;
      if (social?.attitude(o.account)?.blocked === true) why = "她封鎖了對方";
      else if (registry) {
        const choices = await registry.privacy.get(o.account);
        if (!choices.dm) why = "對方不收她的私訊";
        else if (!choices.approach) why = "對方不想被主動找";
      }
      consent.set(key, why);
    }
    return {
      now,
      paused: this.paused(),
      budget: services.get(LlmRouterKey)?.budgetState() ?? "ok",
      level: (place) => this.#h.agent.handle.channelMode(place),
      consent: (account) => consent.get(`${account.platform}:${account.id}`) ?? null,
    };
  }

  #stopped(o: Opportunity, gate: GateName, detail: string, retryAt: number | null): void {
    if (this.#stops.get(o.id) === gate) return;
    if (o.kind === "morning" && gate === "no_place") {
      // Without a home place this is so every day: said once a day, restarts included.
      const day = this.#day(this.#now);
      if (this.#morningNoPlace === day) return;
      this.#morningNoPlace = day;
      this.#dirty = true;
    }
    this.#stops.set(o.id, gate);
    while (this.#stops.size > MAX_STOPS) {
      const oldest = this.#stops.keys().next().value;
      if (oldest === undefined) break;
      this.#stops.delete(oldest);
    }
    this.#decide(o, "rejected", REASON[gate], `${gate}: ${detail}`, retryAt);
  }

  #wake(o: Opportunity, now: number): void {
    const place = o.place;
    if (place === null) return;
    const wake: Wake =
      o.kind === "timer"
        ? { kind: "timer", note: o.note }
        : o.kind === "world"
          ? { kind: "world", what: o.note }
          : { kind: "self", note: o.note };
    this.#runs.set(wake, { o, entry: null });
    if (!this.#h.wake(place, wake)) {
      this.#runs.delete(wake);
      this.#stopped(o, "no_place", "那個地方叫不醒她", null);
      return;
    }
    this.gates.started(o, now);
    if (o.item !== null) this.#h.store.woke(o.item, now);
    this.#woken.push(o.id);
    while (this.#woken.length > MAX_WOKEN) this.#woken.shift();
    if (o.kind === "morning") this.#morning = this.#day(now);
    this.#stops.delete(o.id);
    this.#decide(o, "accepted", null, `${o.kind}: ${o.note}`, null);
  }

  #decide(
    o: Opportunity,
    verdict: "accepted" | "rejected",
    reason: ArbiterReason | null,
    detail: string,
    retryAt: number | null,
  ): void {
    const decision: ArbiterDecision = {
      impulse: o.id,
      source: SOURCE[o.kind],
      verdict,
      reason,
      detail,
      retry_at: retryAt === null ? null : toTimestamp(retryAt),
      merged_into: null,
      turn: null,
      task: null,
      at: toTimestamp(this.#now),
    };
    this.#h.agent.ctx.publish(Events.ArbiterDecided, decision);
  }

  /** Glances a day over all places (owner decision Q5). */
  get glancesPerDay(): number {
    return this.#h.settings.own.glances_per_day;
  }

  // ---- what is kept ---------------------------------------------------------------------------

  async #load(): Promise<void> {
    const store = this.#services.get(SettingsStoreKey);
    if (!store) return;
    try {
      const value = await store.get(this.#profile(), INITIATIVE_STATE_KEY);
      if (!isJsonObject(value) || value.v !== 1) return;
      const state = value as unknown as State;
      if (state.gates !== null && isJsonObject(state.gates as unknown as JsonValue)) {
        this.gates.restore(state.gates);
      }
      this.#woken.push(...(Array.isArray(state.woken) ? state.woken.slice(-MAX_WOKEN) : []));
      this.#morning = typeof state.morning === "number" ? state.morning : null;
      this.#morningNoPlace = typeof state.morningNoPlace === "number" ? state.morningNoPlace : null;
      this.#waiting = isJsonObject(state.waiting as unknown as JsonValue) ? state.waiting : {};
    } catch (error) {
      this.#h.agent.log.warn({ err: errorMessage(error) }, "cannot load her initiative state");
    }
  }

  #profile(): string {
    return this.#h.agent.persona.read((p) => p.id);
  }

  #save(): Promise<void> {
    if (!this.#dirty) return this.#saving;
    this.#dirty = false;
    const store = this.#services.get(SettingsStoreKey);
    if (!store) return this.#saving;
    const state: State = {
      v: 1,
      gates: this.gates.snapshot(),
      woken: [...this.#woken],
      morning: this.#morning,
      morningNoPlace: this.#morningNoPlace,
      waiting: this.#waiting,
    };
    const value = JSON.parse(JSON.stringify(state)) as JsonValue;
    this.#saving = this.#saving
      .then(() => store.set(this.#profile(), INITIATIVE_STATE_KEY, value))
      .catch((error: unknown) =>
        this.#h.agent.log.warn({ err: errorMessage(error) }, "cannot keep her initiative state"),
      );
    return this.#saving;
  }
}

/** `remind_me`'s timers while the new runner runs (the mind module looks it up per call). */
export const ScheduleRemindersKey = serviceKey<ReminderBackend>("ScheduleReminders");

/** What the host gives `startInitiative`. */
export interface InitiativeWiring {
  transcript: TranscriptStore;
  quiet: LocalTime | null;
  sessionOf(context: ContextKey): string;
  wake(context: ContextKey, wake: Wake): boolean;
  places(): ContextKey[];
  resolve(name: string, from: ContextKey): Promise<ContextKey | null>;
  describe(place: ContextKey): Promise<string | null>;
  inVoice?(context: ContextKey): boolean;
  signal: AbortSignal;
}

export interface InitiativeOptions {
  /** The numbers (Core: `initiativeFromConfig`); default: every default. */
  settings?: InitiativeSettings;
  /** `remind_me`'s parser of absolute times (Core passes the mind's). */
  parseAt?: ParseAt | null;
  /** Her schedules and inbox; default: the store's (`StoreKey`, `initiativeTables`). */
  store?: InitiativeStore;
}

/**
 * Her initiative for the host: the tables, the book `remind_me` finds (`ScheduleRemindersKey`),
 * the `schedule` tools, and the look every `tick_secs`. `stop` takes the tools away.
 */
export function startInitiative(
  agent: Agent,
  wiring: InitiativeWiring,
  options: InitiativeOptions = {},
): { initiative: Initiative; stop(): void } {
  const store = options.store ?? agent.ctx.services.get(StoreKey)?.plugin(initiativeTables) ?? null;
  if (store === null) throw new Error("her initiative needs the store's tables");
  const initiative = new Initiative({
    agent,
    transcript: wiring.transcript,
    store,
    settings: options.settings ?? initiativeSettings(),
    quiet: wiring.quiet,
    parseAt: options.parseAt ?? null,
    sessionOf: wiring.sessionOf,
    wake: wiring.wake,
    places: wiring.places,
    ...(wiring.inVoice === undefined ? {} : { inVoice: wiring.inVoice }),
  });
  agent.ctx.provide(ScheduleRemindersKey, initiative.book.reminders);
  const tools = [
    ...scheduleTools({
      book: initiative.book,
      resolve: wiring.resolve,
      describe: wiring.describe,
      spaceOf: (place) => store.spaceOf(place),
    }),
    // What waits in another place, as far as memory's place rule allows from the run's place.
    lookTool({
      store,
      places: () => agent.ctx.services.get(PlacesKey) ?? null,
      viewer: (ctx) => initiative.viewer(ctx),
      offsetMinutes: initiative.book.offsetMinutes,
    }),
  ];
  for (const tool of tools) agent.tools.register(tool);
  initiative.start(wiring.signal);
  return {
    initiative,
    stop: () => {
      for (const tool of tools) agent.tools.unregister(tool.spec.name);
    },
  };
}
