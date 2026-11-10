// The main line (docs/design/v3-architecture.md §3, §10): the one foreground decider.
//
// `MainLine` is what lives as long as the module: the lines in flight, the hands, her commitments,
// the proposal board and the mouth the scheduler asks ("is this one of yours?"). `MainTurn` is one
// turn of it: the claim it holds, the gate its lines pass through and what it ends with.
//
// A turn itself is still `turn.ts`: attention, the prompt pieces, sentence streaming and the text
// and voice output are the V2 code. What changes is who may start one (the Floor), what one call
// may produce (`TurnOutput`) and what happens to it afterwards (this file).

import { errorMessage, interval } from "@miyoria/kernel";
import {
  ACTION_SETTLED_TOPIC,
  ACTIVITY_DONE_TOPIC,
  ACTIVITY_FAILED_TOPIC,
  type Action,
  type ActionSettled,
  type ActionSink,
  ActionSinkKey,
  ActivityManagerKey,
  type ActivitySnapshot,
  type ActivityTaskEvent,
  ArbiterKey,
  type Commitment,
  type CommitmentDraft,
  type ContextKey,
  contextKeyEquals,
  contextKeyString,
  type Delivery,
  DeliveryLedgerKey,
  DirectivesKey,
  EventLogKey,
  type FixedLine,
  type Floor,
  type FloorClaimKind,
  FloorKey,
  floorRank,
  type Handle,
  HandleDirectoryKey,
  type ImpulseAttention,
  isJsonObject,
  type JsonObject,
  type JsonValue,
  ModerationKey,
  type Mouth,
  newAction,
  newId,
  newImpulse,
  type PinnedMemory,
  PinnedMemoryKey,
  Principals,
  type SaySegment,
  safeOutgoing,
  spendsBudget,
  TaskSteerKey,
  type TurnDecision,
  type TurnId,
  type TurnOutput,
  textLane,
  topicKey,
  toTimestamp,
  VoiceFloorKey,
  voiceLane,
  type Wish,
  type Wishes,
  WishesKey,
  WorkingContextKey,
  wishHolder,
} from "@miyoria/types";
import type { Claim } from "../claims.js";
import type { MainLineConfig } from "../config.js";
import { voiceScope } from "../handle.js";
import { CorrectionTally } from "../metrics.js";
import { NOTE_TOOLS } from "../notes.js";
import type { Agent } from "../runtime.js";
import type { ToolScope } from "../tool-scope.js";
import { ReactTool } from "../tools.js";
import { contextId } from "../util.js";
import { CommitmentBook, isTalkPromise } from "./commitments.js";
import {
  type HeldLine,
  LineGate,
  type ParkedLine,
  promisedClaims,
  type Settled,
  STARTED_LINE,
} from "./gate.js";
import { Hands, type Job, type Run } from "./hands.js";
import { LineBook } from "./lines.js";
import { freshLines, withoutRepeats } from "./loop.js";
import { isPseudoTool, STEER_TOOL } from "./output.js";
import { isTalk, Proposals } from "./proposals.js";

/** What she says when something has to be said and the model cannot (§21). */
export const FALLBACK_LINES = [
  "欸?我剛剛恍神了,可以再說一次嗎?",
  "等等,腦袋卡了一下……再跟我說一次好不好?",
];
/** The same for a result she cannot put in words right now. */
export const FALLBACK_RESULT_LINE = "事情有結果了,等我一下再跟你說。";
/** The same when something cannot wait and she has no words for it. */
export const FALLBACK_URGENT_LINE = "哇,等一下!";
/**
 * Lines for an output that acts but says nothing, when someone waits for her: by what she does,
 * one picked at random so it is not the same words every time ("" for anything else).
 */
export const WAIT_LINES: Readonly<Record<string, readonly string[]>> = {
  web_search: ["我查一下。", "等等,我查查看。", "我找找看。"],
  web_read: ["我看一下那頁。", "等我讀一下。"],
  "": ["等我一下。", "稍等喔。", "好,等我一下。"],
};

/** A wait line for `tools` (the first slow one decides). */
export function waitLine(tools: readonly string[], random: () => number = Math.random): string {
  const lines = WAIT_LINES[tools.find((t) => WAIT_LINES[t] !== undefined) ?? ""] ?? [];
  const pick = lines[Math.min(lines.length - 1, Math.floor(random() * lines.length))];
  return pick ?? "等我一下。";
}

/** Tools that say something to one person: using one for a wish is asking it. */
const TALK_TOOLS: ReadonlySet<string> = new Set(["message_dm", "message.dm"]);
/** Tool calls of turns that raised a wish, remembered until they finish. */
const WISH_CALLS = 256;

/** What the Floor has beyond its service interface: the keys a turn is about (`FloorCore`). */
interface Reserving {
  repeated(attention: ImpulseAttention): boolean;
  reserve(attention: ImpulseAttention, turn: TurnId | null): void;
}

function reserving(floor: Floor): (Floor & Reserving) | null {
  const f = floor as Floor & Partial<Reserving>;
  return typeof f.repeated === "function" && typeof f.reserve === "function"
    ? (f as Floor & Reserving)
    : null;
}

/** The key of what a claim is about, revision included. */
function claimKey(attention: ImpulseAttention): string {
  return `${attention.key}#${attention.revision ?? 1}`;
}

/** Tools that are done the moment they are called: nothing to wait for. */
const INSTANT_TOOLS: ReadonlySet<string> = new Set([ReactTool.NAME, ...NOTE_TOOLS]);

const ACTIVITY_TOPICS = [ACTIVITY_DONE_TOPIC, ACTIVITY_FAILED_TOPIC];
const TURNS_REMEMBERED = 512;
const CAUSES_REMEMBERED = 512;
/** How long a result stays worth saying while the place is busy. */
const RESULT_TTL_MS = 10 * 60_000;
/** Log history the commitments and proposals are rebuilt from. */
const REBUILD_MS = 24 * 3_600_000;
/** What a commitment made of her own line keeps of it. */
const WHAT_CHARS = 80;

/** Where a turn of hers runs that acts and says nothing: no conversation of anyone's. */
export const ACTING_ALONE: ContextKey = {
  platform: "core",
  scope: null,
  channel: "mainline",
  kind: "channel",
};

/** A follow-up turn: what the turn it comes from was doing, so its tools act for the same person. */
export interface Chain {
  depth: number;
  requester: unknown;
}

/** Her state as the gate must read it: being on the way somewhere is not being there. */
export function strictScope(snapshot: ActivitySnapshot): ToolScope {
  const a = snapshot.activity;
  const running = a.type !== "idle" && (a.phase === "running" || a.phase === "stopping");
  const voice = snapshot.presence.type;
  const live = snapshot.broadcast.type;
  return {
    game: running && a.type === "game" ? (a.target ?? "") : null,
    singing: running && a.type === "singing",
    inVoice: voice === "in" || voice === "leaving",
    live: live === "live" || live === "stopping",
  };
}

/** Cuts a spoken sentence to what can have been heard in `ms`. */
export function heardPart(text: string, ms: number, msPerChar: number): string {
  const chars = [...text];
  const heard = Math.max(Math.floor(ms / msPerChar), 0);
  return heard >= chars.length ? text : chars.slice(0, heard).join("");
}

/**
 * Cuts a spoken sentence to the share of its audio that was heard: the audio is what took the
 * time, so this holds for any speed, and for a line she said in another language.
 */
export function heardShare(text: string, heardMs: number, totalMs: number): string {
  const chars = [...text];
  const heard = Math.floor((chars.length * Math.max(heardMs, 0)) / Math.max(totalMs, 1));
  return heard >= chars.length ? text : chars.slice(0, heard).join("");
}

export { sentences } from "./loop.js";

interface LineInfo {
  attention(said: string): { key: string; revision: number };
  audience(): readonly Handle[];
  cause(): string | null;
}

export class MainLine implements Mouth {
  readonly #agent: Agent;
  readonly lines: LineBook;
  readonly hands: Hands;
  readonly commitments: CommitmentBook;
  readonly proposals: Proposals;
  readonly #turns = new Set<TurnId>();
  /** Message id → its observation: what a turn's first line was caused by. */
  readonly #causes = new Map<string, string>();
  /** When a fixed line was last said, by context. */
  readonly #fallbacks = new Map<string, number>();
  /** Impulse id → the turn its result turn continues. */
  readonly #chains = new Map<string, Chain>();
  #stopFollowing: (() => void)[] = [];
  #pinned: PinnedMemory | null = null;
  /** Results of a voice channel a song holds, one per place: told once the song is over. */
  #afterSong: { context: ContextKey; job: Job }[] = [];
  /** `action` event of a talking tool a wish turn called → the wish it raises. */
  readonly #wishCalls = new Map<string, string>();
  /** What a turn in flight is about (`key#revision`) → that turn: one turn per thing. */
  readonly #live = new Map<string, TurnId>();

  constructor(agent: Agent) {
    this.#agent = agent;
    const services = agent.ctx.services;
    const now = () => agent.ctx.clock.now();
    const log = () => services.get(EventLogKey) ?? null;
    this.lines = new LineBook(() => services.get(DeliveryLedgerKey) ?? null, now);
    this.commitments = new CommitmentBook(log, now, this.config.commitment_due_secs, () =>
      this.wishes(),
    );
    this.proposals = new Proposals({ log, now, services });
    this.hands = new Hands({
      log,
      now,
      activity: () => services.get(ActivityManagerKey) ?? null,
      told: (context, job) => this.#told(context, job),
      release: (context, line) => this.#release(context, line),
      finished: (tool, cause) => {
        this.commitments.kept(tool, cause);
        this.#raised(cause);
      },
    });
  }

  /** What she wants to ask whom (the arbiter's book), when it runs. */
  wishes(): Wishes | null {
    return this.#agent.ctx.services.get(WishesKey) ?? null;
  }

  /** The wish a claim was opened for: a due commitment, a timer or a proposal of hers. */
  wishOf(claim: Pick<MainClaim, "attention" | "proposal">): Wish | null {
    const wishes = this.wishes();
    if (wishes === null) return null;
    const key = claim.attention?.key ?? null;
    return (
      (key === null ? null : wishes.of(key)) ??
      (claim.proposal === null ? null : wishes.of(wishHolder("proposal", claim.proposal.id)))
    );
  }

  /** A talking tool of a wish turn: once it is done, she asked. */
  noteWishCall(event: string | null, wish: string): void {
    if (event === null) return;
    this.#wishCalls.set(event, wish);
    while (this.#wishCalls.size > WISH_CALLS) {
      const oldest = this.#wishCalls.keys().next().value;
      if (oldest === undefined) break;
      this.#wishCalls.delete(oldest);
    }
  }

  #raised(cause: string | null): void {
    const wish = cause === null ? undefined : this.#wishCalls.get(cause);
    if (cause === null || wish === undefined) return;
    this.#wishCalls.delete(cause);
    this.wishes()?.asked(wish);
  }

  /** The turn in flight about `attention`, if one is. */
  liveTurn(attention: ImpulseAttention): TurnId | null {
    return this.#live.get(claimKey(attention)) ?? null;
  }

  /** `turn` is about `attention` until it ends. */
  goLive(attention: ImpulseAttention, turn: TurnId): void {
    this.#live.set(claimKey(attention), turn);
  }

  /** `turn` is over: what it was about may be taken up again. */
  leave(turn: TurnId): void {
    for (const [key, t] of this.#live) if (t === turn) this.#live.delete(key);
  }

  get config(): MainLineConfig {
    return this.#agent.config.mainline;
  }

  floor(): Floor | null {
    return this.#agent.ctx.services.get(FloorKey) ?? null;
  }

  /** Follows the log and looks for overdue commitments. */
  async start(): Promise<void> {
    const ctx = this.#agent.ctx;
    const log = ctx.services.get(EventLogKey);
    if (!log) {
      ctx.log.warn("no event log: what she says and promises is not kept");
    } else {
      const since = toTimestamp(ctx.clock.now() - REBUILD_MS);
      this.#stopFollowing.push(await log.project(this.commitments, { since }));
      this.#stopFollowing.push(await log.project(this.proposals, { since }));
    }
    ctx.spawn("commitments", async (signal) => {
      for await (const _ of interval(this.config.commitment_sweep_ms, signal)) {
        this.commitments.remind();
        this.#tellAfterSong();
      }
    });
  }

  stop(): void {
    for (const stop of this.#stopFollowing.splice(0)) stop();
  }

  /**
   * The pinned layer, with what only the main line owns plugged in. Looked up per turn: the memory
   * module starts after this one and may restart. The prompt keeps the whole persona in its fixed
   * prefix, which must stay the same from turn to turn and uncut, so that section is not read back.
   */
  pinned(): PinnedMemory | null {
    const pinned = this.#agent.ctx.services.get(PinnedMemoryKey) ?? null;
    if (pinned === null || pinned === this.#pinned) return pinned;
    this.#pinned = pinned;
    this.#stopFollowing.push(
      pinned.addSource({
        key: "persona",
        lines: () => this.#agent.persona.corePrompt().split("\n"),
      }),
      pinned.addSource({ key: "rules", lines: (where) => this.ownerRules(where.context) }),
    );
    return pinned;
  }

  // ---- the mouth ------------------------------------------------------------------------------

  own(turn: TurnId): void {
    this.#turns.add(turn);
    while (this.#turns.size > TURNS_REMEMBERED) {
      const oldest = this.#turns.values().next().value;
      if (oldest === undefined) break;
      this.#turns.delete(oldest);
    }
  }

  owns(turn: TurnId | null): boolean {
    return turn !== null && this.#turns.has(turn);
  }

  /** The scheduler as the main line uses it: every line goes through the ledger. */
  mouth(sink: ActionSink, info: LineInfo): ActionSink {
    const lines = this.lines;
    return {
      async submit(action: Action): Promise<void> {
        const p = action.payload;
        if (p.type !== "speak" && p.type !== "send_message") {
          await sink.submit(action);
          return;
        }
        const said = p.type === "speak" ? p.text : p.message.text;
        const { key, revision } = info.attention(said);
        lines.open({
          turn: action.turn,
          context: p.context,
          channel: p.type === "speak" ? "voice" : "text",
          said,
          action: action.id,
          attention_key: key,
          revision,
          audience: info.audience(),
          cause: info.cause(),
          blocked: action.blocked ?? null,
        });
        try {
          await sink.submit(action);
        } catch (error) {
          lines.failed(action.id, errorMessage(error));
          throw error;
        }
      },
      cancelTurn: (turn) => sink.cancelTurn(turn),
    };
  }

  async say(line: FixedLine): Promise<void> {
    const agent = this.#agent;
    if (agent.muted) return;
    const turn = line.turn ?? newId();
    this.own(turn);
    const { context } = line;
    const safe = safeOutgoing(agent.ctx.services.get(ModerationKey), {
      path: "reply",
      text: line.text,
      aloud: context.kind === "voice",
      context,
      turn,
    });
    const { text } = safe;
    const blocked = safe.blocked ?? line.blocked ?? null;
    const floor = this.floor();
    floor?.hold(turn, context, "result");
    const sink = agent.ctx.services.get(ActionSinkKey);
    try {
      if (!sink) throw new Error("no scheduler");
      const mouth = this.mouth(sink, {
        attention: (said) => ({ key: topicKey(said), revision: 1 }),
        audience: () => agent.audience(context),
        cause: () => null,
      });
      const priority = "request" as const;
      if (context.kind === "voice") {
        const [platform, scope] = voiceScope(context);
        await mouth.submit(
          newAction(
            voiceLane(platform, scope),
            priority,
            { type: "speak", context, text, emotion: line.emotion ?? null },
            { ttl: agent.config.voice.speak_ttl_ms, turn, blocked },
          ),
        );
        return;
      }
      const action = newAction(
        textLane(context),
        priority,
        { type: "send_message", context, message: { text, reply_to: null } },
        { ttl: agent.config.reply_ttl_ms, turn, blocked },
      );
      agent.noteOwnText(context, text, action.id);
      await mouth.submit(action);
    } finally {
      floor?.turnEnded(turn);
    }
  }

  // ---- what comes back ------------------------------------------------------------------------

  /** A bus event the main line follows. Returns whether it was one. */
  custom(topic: string, payload: JsonValue): boolean {
    if (topic === ACTION_SETTLED_TOPIC) {
      this.lines.settled(payload as unknown as ActionSettled);
      return true;
    }
    if (ACTIVITY_TOPICS.includes(topic)) {
      this.hands.activityEnded(topic, payload as unknown as ActivityTaskEvent);
      return true;
    }
    if (topic.includes(".task.")) {
      this.hands.taskEvent(topic, payload);
      return true;
    }
    return false;
  }

  noteCause(message: string, event: string): void {
    this.#causes.set(message, event);
    while (this.#causes.size > CAUSES_REMEMBERED) {
      const oldest = this.#causes.keys().next().value;
      if (oldest === undefined) break;
      this.#causes.delete(oldest);
    }
  }

  causeOf(message: string | undefined): string | null {
    return message === undefined ? null : (this.#causes.get(message) ?? null);
  }

  /** A song holds the voice channel of `context`: her lines would wait behind it, then drop. */
  #songHolds(context: ContextKey): boolean {
    if (context.kind !== "voice" || context.scope === null) return false;
    const floor = this.#agent.ctx.services.get(VoiceFloorKey);
    return (floor?.holder(context.scope) ?? null) !== null;
  }

  /** Results that waited for a song: the song is over. */
  #tellAfterSong(): void {
    const waiting = this.#afterSong;
    this.#afterSong = waiting.filter((w) => this.#songHolds(w.context));
    for (const w of waiting) if (!this.#songHolds(w.context)) this.#told(w.context, w.job);
  }

  /** A result is in: a turn of hers (the Floor's `result` row) tells it. */
  #told(context: ContextKey, job: Job): void {
    if (this.#songHolds(context)) {
      // Nothing cuts a song (§7.3); the result stays unsaid and is told once it ends.
      this.#afterSong = [
        ...this.#afterSong.filter((w) => !contextKeyEquals(w.context, context)),
        { context, job },
      ];
      return;
    }
    const agent = this.#agent;
    const now = agent.ctx.clock.now();
    const impulse = newImpulse(
      {
        source: "followup",
        context,
        ttlMs: RESULT_TTL_MS,
        why: "手上的事有結果了",
        hint: "",
        reason: "action_result",
        claim: "result",
        // Results of one place become one turn: "可合併成一句".
        coalesce_key: `result:${contextKeyString(context)}`,
      },
      now,
    );
    this.#chains.set(impulse.id, { depth: job.depth + 1, requester: job.requester });
    const arbiter = agent.ctx.services.get(ArbiterKey);
    if (!arbiter) {
      void agent.openInitiative(context, {
        reason: "action_result",
        hint: "",
        about: [],
        chain: this.takeChain(impulse.id),
        claim: "result",
      });
      return;
    }
    void arbiter.submit(impulse).catch((error: unknown) => {
      agent.log.warn({ error: errorMessage(error) }, "the floor failed on a result");
    });
  }

  takeChain(impulse: string): Chain | null {
    const chain = this.#chains.get(impulse) ?? null;
    this.#chains.delete(impulse);
    return chain;
  }

  /** What a finished line waited for came back done. */
  #release(context: ContextKey, line: ParkedLine): void {
    void this.say({
      context,
      text: line.text,
      emotion: line.emotion,
      source: "mainline.parked",
      blocked: line.blocked ?? null,
    }).catch((error: unknown) => {
      this.#agent.log.warn({ error: errorMessage(error) }, "could not say a line that waited");
    });
  }

  /** The emergency stop: what she was holding back stays unsaid. */
  silence(): void {
    this.hands.dropParked();
  }

  /** What is true of `context` for the gate. */
  scope(): ToolScope | null {
    const manager = this.#agent.ctx.services.get(ActivityManagerKey);
    return manager ? strictScope(manager.snapshot()) : null;
  }

  /** The lines of "最近講過": what really reached someone here. */
  recent(context: ContextKey, limit: number): Delivery[] {
    const ledger = this.#agent.ctx.services.get(DeliveryLedgerKey);
    return ledger?.recent({ context, limit }) ?? [];
  }

  /** Whether a fixed line may go out in `context` now; counts as said if so. */
  takeFallback(context: ContextKey): boolean {
    const now = this.#agent.ctx.clock.now();
    const id = contextId(context);
    const last = this.#fallbacks.get(id);
    if (last !== undefined && now - last < this.config.fallback_gap_ms) return false;
    this.#fallbacks.set(id, now);
    return true;
  }

  /** What she must keep to, all of it, every turn: the owner's rules and what is on hold. */
  ownerRules(context: ContextKey): string[] {
    const services = this.#agent.ctx.services;
    const rules = services.get(DirectivesKey)?.inject(context) ?? [];
    const limits = services.get(ArbiterKey)?.ledger(context).limits;
    return [...rules, ...(limits?.blocked ?? []).map((b) => `${b.capability}:${b.reason}`)];
  }

  /** Tasks in flight that a steer can reach, from what the executors say about themselves. */
  tasks(): { owner: string; task: string; text: string }[] {
    const buckets = this.#agent.ctx.services.get(WorkingContextKey)?.buckets() ?? [];
    return buckets.flatMap((b) => {
      if (!b.writer.endsWith(".task")) return [];
      // A work-lane task is steered with `work_steer`, which knows its goal and budgets.
      if (b.writer === "worklane.task") return [];
      const entry = b.entries.at(-1);
      if (!entry?.attention_key.startsWith("task:")) return [];
      return [
        {
          owner: b.writer.slice(0, -".task".length),
          task: entry.attention_key.slice("task:".length),
          text: entry.text,
        },
      ];
    });
  }

  /** §10.6: changes a task's goal and keeps its progress. Only `applied` makes it true. */
  async steer(job: Job, raw: JsonObject, cause: string | null): Promise<void> {
    const service = this.#agent.ctx.services.get(TaskSteerKey);
    const task = typeof raw.task === "string" ? raw.task : "";
    const known = this.tasks().find((t) => t.task === task);
    const patch = raw.patch;
    if (!service || !known || !isJsonObject(patch)) {
      this.hands.answered(job, { ok: false, text: "沒有這個進行中的任務,或改不了", data: null });
      return;
    }
    const id = newId();
    const why = typeof raw.why === "string" ? raw.why : "";
    const receipt = await service.steer({
      steer: { id, task, patch, why, cause: cause ?? "" },
      owner: known.owner,
      principal: Principals.self(job.context, null),
    });
    switch (receipt.status) {
      case "accepted":
        this.hands.awaitSteer(job, id, "受理了,下一個安全點生效");
        return;
      case "unsupported":
        this.hands.answered(job, {
          ok: false,
          text: "這個任務不能中途改;要改就停掉重開,進度會丟掉",
          data: null,
        });
        return;
      default:
        this.hands.answered(job, { ok: false, text: receipt.detail, data: null });
    }
  }
}

/** What opened a turn of the main line. */
export interface MainClaim {
  kind: FloorClaimKind;
  /** What the turn is about, for its lines. */
  attention: ImpulseAttention | null;
  /** The observation or message behind it. */
  cause: string | null;
  /** It may act but not talk: nobody is there, or her budget is spent. */
  muted: boolean;
  /** The proposal it carries out, with the tool that would do it. */
  proposal: { id: string; tool: string | null } | null;
  chain: Chain | null;
}

/** What a finished output leaves to `turn.ts`. */
export interface Outcome {
  /** Say these, in order. */
  release: HeldLine[];
  /** A claim nothing backs: remind her and ask once more. */
  remind: Claim | null;
}

export class MainTurn {
  readonly #main: MainLine;
  readonly #agent: Agent;
  readonly turn: TurnId;
  readonly context: ContextKey;
  readonly claim: MainClaim;
  readonly gate: LineGate;
  /** What the code changed of her output in this turn (docs/design/v4-patches.md). */
  readonly tally: CorrectionTally;
  /** What really went out of this call, in order. */
  said: SaySegment[] = [];
  #offered = new Set<string>();
  /** A decision event of this turn, the cause of its lines and actions. */
  #decision: string | null = null;
  #held = false;
  #reminded = false;
  /** Results this turn's prompt shows: told once the turn concludes. */
  #telling: readonly Job[] = [];
  /** Tools she wrote as text instead of calling (`toolsWrittenAsText`). */
  #written = new Set<string>();
  /** Overdue commitments she was shown. */
  #overdue: Commitment[] = [];
  /** Tools that ran inside this turn (`loop_tools`), in order. */
  #ran: string[] = [];
  /** The jobs of `#ran`. */
  #loopJobs: Job[] = [];
  /** How much of `said` came from earlier rounds of the tool loop. */
  #earlier = 0;

  constructor(
    main: MainLine,
    agent: Agent,
    turn: TurnId,
    context: ContextKey,
    claim: MainClaim,
    tally: CorrectionTally = new CorrectionTally(context.kind === "voice"),
  ) {
    this.#main = main;
    this.#agent = agent;
    this.turn = turn;
    this.context = context;
    this.claim = claim;
    this.tally = tally;
    main.own(turn);
    this.gate = new LineGate(
      {
        scope: () => main.scope(),
        done: (tool) => main.hands.done(context, tool),
        pending: () => main.hands.pending(context),
      },
      agent.config.corrections.claims,
    );
  }

  get config(): MainLineConfig {
    return this.#main.config;
  }

  get main(): MainLine {
    return this.#main;
  }

  /** Someone is waiting for this turn: it may not end in nothing. */
  get owed(): boolean {
    return floorRank(this.claim.kind) <= floorRank("urgent");
  }

  /** Takes the mic. Returns why not, when the Floor says no. */
  take(): string | null {
    const main = this.#main;
    // A wish that was asked and answered, or that they asked her to stop, opens nothing: the turn
    // that hears "you already asked" cannot be a turn to ask it (2026-11-10, 12:12 to 12:49).
    const wish = main.wishOf(this.claim);
    if (wish?.state === "closed") return "這件事已經問完了,不要再提";
    const attention = this.claim.attention;
    // One turn per thing: a due commitment opened once by its observation and again by a retry
    // of the Arbiter after a slow context must not ask twice (2026-11-10 11:07).
    const other = attention === null ? null : main.liveTurn(attention);
    if (other !== null && other !== this.turn && !this.#addressed()) {
      return "另一個回合正在處理這件事";
    }
    const floor = main.floor();
    if (floor === null) {
      if (attention !== null) main.goLive(attention, this.turn);
      return null;
    }
    if (this.claim.kind === "ambient") {
      const refused = floor.refuses("ambient", this.context);
      if (refused !== null) return refused;
    }
    const keys = this.#answersLine() ? reserving(floor) : null;
    if (keys !== null && attention !== null) {
      // What a person's line caused may have been claimed already (a party game's note of it).
      // Someone who called her is answered unless something was already said to them.
      const said = this.#addressed() ? this.#delivered(attention) : keys.repeated(attention);
      if (said) return "這句話已經有人回了";
    }
    floor.hold(this.turn, this.context, this.claim.kind);
    this.#held = true;
    if (attention !== null) {
      keys?.reserve(attention, this.turn);
      main.goLive(attention, this.turn);
    }
    return null;
  }

  /**
   * Someone called her by name or @-mentioned her. A line that only follows what she said (a
   * player's answer to her quiz question, `reply`) is not: that is the line a note may share.
   */
  #addressed(): boolean {
    return this.claim.kind === "addressed";
  }

  /** The turn answers a person's line (its key is the line's: `msg:` or `voice:utterance:`). */
  #answersLine(): boolean {
    // A claim the Arbiter opened (a note of the line) has the key reserved for itself already.
    const kind = this.claim.kind;
    if (kind !== "addressed" && kind !== "reply" && kind !== "ambient") return false;
    const key = this.claim.attention?.key ?? "";
    return key.startsWith("msg:") || key.startsWith("voice:utterance:");
  }

  /** A line about `attention` reached someone. */
  #delivered(attention: ImpulseAttention): boolean {
    const last = this.#agent.ctx.services.get(DeliveryLedgerKey)?.delivered(attention.key) ?? null;
    return last !== null && last.revision >= (attention.revision ?? 1);
  }

  /** Generation is over: the mic goes once the lines settled. */
  ended(): void {
    this.#main.leave(this.turn);
    if (this.#held) this.#main.floor()?.turnEnded(this.turn);
  }

  offered(tools: readonly string[]): void {
    this.#offered = new Set(tools);
  }

  /**
   * Whether a call of this turn may run: its tool was on offer (after the Directives' filter and
   * her state), or it is one of the output's own (`commit`, `steer_task`). A name the model made up
   * or remembered from an earlier turn is no way around the filter.
   */
  isOffered(tool: string): boolean {
    return isPseudoTool(tool) || this.#offered.has(tool);
  }

  shown(overdue: readonly Commitment[]): void {
    this.#overdue = [...overdue];
  }

  /** The scheduler, with this turn's lines going through the ledger. */
  mouth(sink: ActionSink, audience: () => readonly Handle[]): ActionSink {
    return this.#main.mouth(sink, {
      attention: (said) => {
        const a = this.claim.attention;
        return a === null
          ? { key: topicKey(said), revision: 1 }
          : { key: a.key, revision: a.revision ?? 1 };
      },
      audience,
      cause: () => this.#decision ?? this.claim.cause,
    });
  }

  /**
   * Whether `line` goes out now. A muted turn keeps its mouth shut, and a sentence she said in an
   * earlier round of the tool loop is not said again.
   */
  screen(line: HeldLine): boolean {
    if (this.claim.muted) return false;
    if (this.unrepeated(line.text).trim() === "") {
      this.tally.count("repeat_cut");
      return false;
    }
    const pass = this.gate.pass(line);
    if (pass) this.said.push({ text: line.text, voice: line.spoken, emotion: line.emotion });
    return pass;
  }

  /**
   * Whether a text line must wait for the end of the stream: it claims too early, or an earlier
   * line does (the order stays, across the rounds of the tool loop too).
   */
  holdsText(text: string): boolean {
    return !this.claim.muted && (this.gate.holding() || this.gate.holds(text));
  }

  /** `text` without what she said in an earlier round of the tool loop. */
  unrepeated(text: string): string {
    return withoutRepeats(
      text,
      this.said.slice(0, this.#earlier).map((s) => s.text),
    );
  }

  /** `unrepeated`, counted when it cut something: what a text line of hers goes out as. */
  cutRepeats(text: string): string {
    const left = this.unrepeated(text);
    if (left !== text) this.tally.count("repeat_cut");
    return left;
  }

  /**
   * A text line noted as sent (`sent`) never went out: the reply screen took it. What she said
   * is what reached someone; a dropped line of reasoning must not become a promise she made.
   */
  unsent(text: string): void {
    for (let i = this.said.length - 1; i >= this.#earlier; i--) {
      if (this.said[i]?.text !== text) continue;
      this.said.splice(i, 1);
      return;
    }
  }

  /** A round of the tool loop is over: what she said so far was said. */
  round(): void {
    this.#earlier = this.said.length;
  }

  /**
   * In voice somebody waits in silence while the loop's tools run: a line first, when she has said
   * nothing yet and something slow is coming (`null`: no need).
   */
  waitFor(tools: readonly string[]): string | null {
    if (this.said.length > 0 || !this.#owes()) return null;
    const slow = tools.filter((t) => !INSTANT_TOOLS.has(t));
    if (slow.length === 0) return null;
    this.tally.count("wait_line");
    return waitLine(slow);
  }

  /**
   * A tool of the loop, run inside the turn by `run`. The hands log it like any action (`action`,
   * then `result`), so the gate knows it is done and a commitment it keeps is kept; nobody needs a
   * turn for its result, she reads it in this one. Only when it got something started that ends
   * later (a receipt) do the hands follow it and tell her, as they do for their own.
   */
  async inTurn(
    tool: string,
    args: string,
    run: () => Promise<Run>,
    requester: unknown,
  ): Promise<{ run: Run; accepted: boolean }> {
    const hands = this.#main.hands;
    let parsed: JsonValue = {};
    try {
      parsed = JSON.parse(args === "" ? "{}" : args) as JsonValue;
    } catch {
      // The tool answers for bad arguments.
    }
    const job = hands.begin({
      turn: this.turn,
      context: this.context,
      tool,
      args: parsed,
      report: "none",
      depth: this.claim.chain?.depth ?? 0,
      requester,
      cause: this.claim.cause,
    });
    this.#ran.push(tool);
    this.#loopJobs.push(job);
    let result: Run;
    try {
      result = await run();
    } catch (error) {
      hands.answered(job, { ok: false, text: errorMessage(error), data: null });
      throw error;
    }
    hands.answered(job, result);
    this.#raises(tool, job);
    const accepted = job.state === "accepted";
    if (accepted) job.report = this.claim.muted ? "prompt" : "turn";
    return { run: result, accepted };
  }

  /** Of the lines the gate let out at the end, the ones that are not said already. */
  releasable(lines: readonly HeldLine[]): HeldLine[] {
    const fresh = freshLines(
      lines,
      this.said.map((s) => s.text),
    );
    // A line comes back as it was, or cut (a new object), or not at all.
    this.tally.count("repeat_cut", lines.length - fresh.filter((l) => lines.includes(l)).length);
    return fresh;
  }

  /**
   * The turn ends before its last response after a round of the tool loop: the call after the
   * tools failed (`failed`) or she was cut off (`stopped`). What she said and what she handed over
   * still stand: the decision is logged, the calls she was told went to the hands go there and her
   * promises are kept. What the loop's tools brought back becomes a result: told in a turn of its
   * own when the call failed (someone asked and heard nothing), in her next prompt when she was
   * cut off (whoever cut in has that turn).
   */
  leave(
    output: TurnOutput,
    run: (tool: string, id: string, args: string, signal: AbortSignal) => Promise<Run>,
    requester: unknown,
    why: "failed" | "stopped",
  ): void {
    this.conclude(output, run, requester);
    this.#main.hands.retell(this.#loopJobs, why === "failed" ? "turn" : "prompt");
  }

  /**
   * A talking tool of a turn opened for a wish: once it is done she asked (`MainLine.#raised`).
   * Called before the job ends for the output's tools, after it for the loop's.
   */
  #raises(tool: string, job: Job): void {
    if (!TALK_TOOLS.has(tool)) return;
    const wish = this.#main.wishOf(this.claim);
    if (wish === null) return;
    if (job.state === "done") this.#main.wishes()?.asked(wish.key);
    else if (job.state === "running") this.#main.noteWishCall(job.event, wish.key);
  }

  /** Every tool of the turn: the loop's, then the output's. */
  #acted(output: TurnOutput): string[] {
    return [...this.#ran, ...output.actions.map((a) => a.tool)];
  }

  /** A text line that went out. */
  sent(text: string): void {
    this.said.push({ text, voice: null, emotion: null });
  }

  /**
   * The stream ended. Compares what she said with what she does: lines that were waiting go out,
   * wait for their result or are dropped; a promise without an action becomes a commitment.
   * `earlier`: tools of the output she handed over in an earlier round of the tool loop, and was
   * told so there (`HANDED_OVER`) with a response of hers still to come.
   */
  finish(output: TurnOutput, earlier: readonly string[] = []): Outcome {
    const tally = this.tally;
    const tools = output.actions.map((a) => a.tool);
    const settled: Settled = this.gate.settle(tools);
    tally.count("claim_held", settled.waited);
    const dropped = settled.dropped.find((c) => this.#offered.has(c.tool)) ?? null;
    if (dropped !== null && this.takeCorrection()) {
      this.#agent.log.info({ turn: this.turn, tool: dropped.tool }, "she claimed without doing");
      tally.count("claim_reask");
      return { release: [], remind: dropped };
    }
    tally.count("claim_dropped", settled.dropped.length);
    const release = [...settled.release];
    if (settled.started) {
      tally.count("claim_parked", settled.parked.length);
      release.unshift({ text: STARTED_LINE, spoken: null, emotion: null });
    } else if (release.length === 0 && this.said.length === 0 && tools.length > 0 && this.#owes()) {
      // v4 §4.5 step 1: the fixed line is for an output that acts and cannot say anything about
      // it, because what it does comes back in another turn. A call she handed over in an earlier
      // round of the tool loop was answered to her inside this turn, and she had a response after
      // that: when the response chose silence, a fixed line would only overrule her. Left are the
      // last response's own calls (long activities, lookups past the loop's rounds or time) and
      // any output whose last response gave nothing at all.
      const waiting = output.silence ? tools.filter((t) => !earlier.includes(t)) : tools;
      const slow = waiting.filter((t) => !INSTANT_TOOLS.has(t));
      if (slow.length > 0) {
        tally.count("wait_line");
        release.push({ text: waitLine(slow), spoken: null, emotion: null });
      } else if (waiting.some((t) => NOTE_TOOLS.has(t))) {
        // Only a note, and not a word for whoever waits (2026-11-09 21:06: she kept the lyrics
        // and said nothing more): the note's answer calls her back to say it.
        tally.count("noted_callback");
        this.#notedQuietly = true;
      }
    }
    for (const line of settled.parked) this.#main.hands.park(this.context, line);
    return { release, remind: null };
  }

  /** This output only kept or dropped a note and said nothing to someone waiting. */
  #notedQuietly = false;

  #owes(): boolean {
    return !this.claim.muted && !spendsBudget(this.claim.kind);
  }

  /**
   * One corrective call a turn, for a claim nothing backs or a tool written as text: whether it
   * is still free (it is taken).
   */
  takeCorrection(): boolean {
    if (this.#reminded) return false;
    this.#reminded = true;
    return true;
  }

  /** The results this turn's prompt shows (`Hands.peekResults`). */
  telling(jobs: readonly Job[]): void {
    this.#telling = jobs;
  }

  /** Tools she wrote as text in this turn. */
  wrote(tools: readonly string[]): void {
    for (const tool of tools) this.#written.add(tool);
  }

  /**
   * Commitments of this output: the written ones, and promises with nothing behind them (those
   * only while `[modules.agent.corrections] promise_commit` is on).
   */
  #commit(output: TurnOutput): CommitmentDraft[] {
    const drafts = [...output.commitments];
    if (!this.#agent.config.corrections.promise_commit) return drafts;
    const scope = this.#main.scope();
    const tools = this.#acted(output);
    // A tool written as text is something she said she would do: it must not just evaporate.
    for (const tool of this.#written) {
      if (tools.includes(tool) || drafts.some((d) => d.capability === tool)) continue;
      const said = this.said
        .map((s) => s.text)
        .join("")
        .trim();
      const what = said === "" ? `用 ${tool}` : [...said].slice(0, WHAT_CHARS).join("");
      drafts.push({ what, capability: tool, due_secs: null });
      this.tally.count("tool_text_commit");
    }
    for (const segment of this.said) {
      for (const claim of promisedClaims(segment.text)) {
        if (tools.includes(claim.tool) || (scope !== null && claim.holds(scope))) continue;
        if (drafts.some((d) => d.capability === claim.tool)) continue;
        drafts.push({ what: segment.text.trim(), capability: claim.tool, due_secs: null });
        this.tally.count("promise_commit");
      }
    }
    return drafts;
  }

  /** Logs the decision, keeps what she promised and sends the hands off. */
  conclude(
    output: TurnOutput,
    run: (tool: string, id: string, args: string, signal: AbortSignal) => Promise<Run>,
    requester: unknown,
  ): void {
    const main = this.#main;
    main.hands.toldOf(this.#telling);
    const drafts = this.#commit(output);
    const wish = main.wishOf(this.claim);
    const body: TurnDecision = {
      turn: this.turn,
      claim: this.claim.kind,
      say: this.said.length,
      actions: this.#acted(output),
      commitments: drafts.map((d) => d.what),
      silence: output.silence,
      why_silent: this.said.length > 0 ? null : output.silence ? "她選擇不開口" : "沒有要說的話",
    };
    this.#decision = this.#log(body);
    for (const draft of drafts) {
      const person = wish?.person ?? this.#personIn(draft.what);
      main.commitments.add(draft, this.context, this.turn, this.#decision, person);
    }
    for (const action of output.actions) this.#dispatch(action, run, requester);
    const tools = body.actions;
    const talked = this.said.length > 0 || tools.some((t) => TALK_TOOLS.has(t));
    // A turn opened for a wish that said something raised it: every store holding it closes.
    if (wish !== null && this.said.length > 0) main.wishes()?.asked(wish.key);
    if (this.claim.proposal !== null) this.#settleProposal(this.claim.proposal, tools);
    // Turn that came for an overdue commitment: she did it, or she said so herself. A promise to
    // say something is kept by saying it, in a line or by a message (2026-11-10: the DM of 11:07
    // kept nothing, and the promise was "broken" at 11:37).
    const due = this.#overdue.filter((c) => this.claim.attention?.key === `commitment:${c.id}`);
    for (const c of due) {
      if (this.#keeps(c, tools) || !talked) continue;
      if (c.capability === null && (wish !== null || isTalkPromise(c.what))) {
        main.commitments.said(c, this.#decision);
      } else if (this.said.length > 0) main.commitments.admitted([c], this.#decision);
    }
  }

  /** The person a promise names, by the name she uses for them (`null`: nobody she knows). */
  #personIn(what: string): Handle | null {
    if (!isTalkPromise(what)) return null;
    const handles = this.#agent.ctx.services.get(HandleDirectoryKey)?.list() ?? [];
    let best: Handle | null = null;
    for (const h of handles) {
      if (h.handle.length < 2 || !what.includes(h.handle)) continue;
      if (best === null || h.handle.length > best.length) best = h.handle;
    }
    return best;
  }

  #keeps(c: Commitment, tools: readonly string[]): boolean {
    return c.capability !== null && tools.includes(c.capability.replaceAll(".", "_"));
  }

  #settleProposal(proposal: { id: string; tool: string | null }, tools: readonly string[]): void {
    const board = this.#main.proposals;
    const open = board.get(proposal.id);
    if (open === null) return;
    const taken =
      proposal.tool !== null
        ? tools.includes(proposal.tool)
        : isTalk(open)
          ? this.said.length > 0
          : tools.length > 0;
    board.settle(proposal.id, taken ? "taken" : "declined", "", this.turn);
  }

  #log(body: TurnDecision): string | null {
    const log = this.#agent.ctx.services.get(EventLogKey);
    if (!log) return null;
    return log.append({
      kind: "decision",
      source: "mainline",
      cause: this.claim.cause,
      context: this.context,
      body: body as unknown as JsonValue,
    }).id;
  }

  /** Why she stayed quiet, for a turn that never got to the model. */
  silent(why: string): void {
    this.#log({
      turn: this.turn,
      claim: this.claim.kind,
      say: 0,
      actions: [],
      commitments: [],
      silence: true,
      why_silent: why,
    });
  }

  #dispatch(
    action: TurnOutput["actions"][number],
    run: (tool: string, id: string, args: string, signal: AbortSignal) => Promise<Run>,
    requester: unknown,
  ): void {
    const agent = this.#agent;
    const main = this.#main;
    let args: JsonValue = {};
    try {
      args = JSON.parse(action.args === "" ? "{}" : action.args) as JsonValue;
    } catch {
      // The tool answers for bad arguments.
    }
    const job = main.hands.begin({
      turn: this.turn,
      context: this.context,
      tool: action.tool,
      args,
      // A muted turn has nobody waiting: what came of it is in her next prompt, not a turn.
      report:
        action.tool === ReactTool.NAME || (NOTE_TOOLS.has(action.tool) && !this.#notedQuietly)
          ? "none"
          : this.claim.muted
            ? "prompt"
            : "turn",
      depth: this.claim.chain?.depth ?? 0,
      requester,
      cause: this.#decision,
    });
    this.#raises(action.tool, job);
    const work =
      action.tool === STEER_TOOL
        ? main.steer(job, isJsonObject(args) ? args : {}, this.#decision)
        : run(action.tool, action.id, action.args, agent.ctx.signal).then((r) => {
            main.hands.answered(job, r);
          });
    void work.catch((error: unknown) => {
      main.hands.answered(job, { ok: false, text: errorMessage(error), data: null });
    });
  }
}
