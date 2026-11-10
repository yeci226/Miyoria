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
  WorkingContextKey,
} from "@miyoria/types";
import type { Claim } from "../claims.js";
import type { MainLineConfig } from "../config.js";
import { voiceScope } from "../handle.js";
import type { Agent } from "../runtime.js";
import type { ToolScope } from "../tool-scope.js";
import { ReactTool } from "../tools.js";
import { contextId } from "../util.js";
import { CommitmentBook } from "./commitments.js";
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
import { STEER_TOOL } from "./output.js";
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
/** An output that acts but says nothing, when someone waits for her. */
export const WAIT_LINE = "等我一下。";

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

/** Sentences of `text`, punctuation kept. */
export function sentences(text: string): string[] {
  return (text.match(/[^。!?!?\n]+[。!?!?\n]*/g) ?? []).filter((s) => s.trim() !== "");
}

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

  constructor(agent: Agent) {
    this.#agent = agent;
    const services = agent.ctx.services;
    const now = () => agent.ctx.clock.now();
    const log = () => services.get(EventLogKey) ?? null;
    this.lines = new LineBook(() => services.get(DeliveryLedgerKey) ?? null, now);
    this.commitments = new CommitmentBook(log, now, this.config.commitment_due_secs);
    this.proposals = new Proposals({ log, now, services });
    this.hands = new Hands({
      log,
      now,
      activity: () => services.get(ActivityManagerKey) ?? null,
      told: (context, job) => this.#told(context, job),
      release: (context, line) => this.#release(context, line),
      finished: (tool, cause) => this.commitments.kept(tool, cause),
    });
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

  constructor(main: MainLine, agent: Agent, turn: TurnId, context: ContextKey, claim: MainClaim) {
    this.#main = main;
    this.#agent = agent;
    this.turn = turn;
    this.context = context;
    this.claim = claim;
    main.own(turn);
    this.gate = new LineGate({
      scope: () => main.scope(),
      done: (tool) => main.hands.done(context, tool),
      pending: () => main.hands.pending(context),
    });
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
    const floor = this.#main.floor();
    if (floor === null) return null;
    if (this.claim.kind === "ambient") {
      const refused = floor.refuses("ambient", this.context);
      if (refused !== null) return refused;
    }
    floor.hold(this.turn, this.context, this.claim.kind);
    this.#held = true;
    return null;
  }

  /** Generation is over: the mic goes once the lines settled. */
  ended(): void {
    if (this.#held) this.#main.floor()?.turnEnded(this.turn);
  }

  offered(tools: readonly string[]): void {
    this.#offered = new Set(tools);
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

  /** Whether `line` goes out now. A muted turn keeps its mouth shut. */
  screen(line: HeldLine): boolean {
    if (this.claim.muted) return false;
    const pass = this.gate.pass(line);
    if (pass) this.said.push({ text: line.text, voice: line.spoken, emotion: line.emotion });
    return pass;
  }

  /** Whether a text line must wait for the end of the stream. */
  holdsText(text: string): boolean {
    return !this.claim.muted && this.gate.holds(text);
  }

  /** A text line that went out. */
  sent(text: string): void {
    this.said.push({ text, voice: null, emotion: null });
  }

  /**
   * The stream ended. Compares what she said with what she does: lines that were waiting go out,
   * wait for their result or are dropped; a promise without an action becomes a commitment.
   */
  finish(output: TurnOutput): Outcome {
    const tools = output.actions.map((a) => a.tool);
    const settled: Settled = this.gate.settle(tools);
    const dropped = settled.dropped.find((c) => this.#offered.has(c.tool)) ?? null;
    if (dropped !== null && this.takeCorrection()) {
      this.#agent.log.info({ turn: this.turn, tool: dropped.tool }, "she claimed without doing");
      return { release: [], remind: dropped };
    }
    const release = [...settled.release];
    if (settled.started) {
      release.unshift({ text: STARTED_LINE, spoken: null, emotion: null });
    } else if (release.length === 0 && this.said.length === 0 && tools.length > 0 && this.#owes()) {
      release.push({ text: WAIT_LINE, spoken: null, emotion: null });
    }
    for (const line of settled.parked) this.#main.hands.park(this.context, line);
    return { release, remind: null };
  }

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

  /** Commitments of this output: the written ones, and promises with nothing behind them. */
  #commit(output: TurnOutput): CommitmentDraft[] {
    const drafts = [...output.commitments];
    const scope = this.#main.scope();
    const tools = output.actions.map((a) => a.tool);
    // A tool written as text is something she said she would do: it must not just evaporate.
    for (const tool of this.#written) {
      if (tools.includes(tool) || drafts.some((d) => d.capability === tool)) continue;
      const said = this.said
        .map((s) => s.text)
        .join("")
        .trim();
      const what = said === "" ? `用 ${tool}` : [...said].slice(0, WHAT_CHARS).join("");
      drafts.push({ what, capability: tool, due_secs: null });
    }
    for (const segment of this.said) {
      for (const claim of promisedClaims(segment.text)) {
        if (tools.includes(claim.tool) || (scope !== null && claim.holds(scope))) continue;
        if (drafts.some((d) => d.capability === claim.tool)) continue;
        drafts.push({ what: segment.text.trim(), capability: claim.tool, due_secs: null });
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
    const body: TurnDecision = {
      turn: this.turn,
      claim: this.claim.kind,
      say: this.said.length,
      actions: output.actions.map((a) => a.tool),
      commitments: drafts.map((d) => d.what),
      silence: output.silence,
      why_silent: this.said.length > 0 ? null : output.silence ? "她選擇不開口" : "沒有要說的話",
    };
    this.#decision = this.#log(body);
    for (const draft of drafts) {
      main.commitments.add(draft, this.context, this.turn, this.#decision);
    }
    for (const action of output.actions) this.#dispatch(action, run, requester);
    const tools = body.actions;
    if (this.claim.proposal !== null) this.#settleProposal(this.claim.proposal, tools);
    // Turn that came for an overdue commitment: she did it, or she said so herself.
    if (this.#overdue.length > 0 && this.said.length > 0 && this.claim.attention !== null) {
      const closing = this.#overdue.filter(
        (c) => this.claim.attention?.key === `commitment:${c.id}` && !this.#keeps(c, tools),
      );
      main.commitments.admitted(closing, this.#decision);
    }
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
      report: action.tool === ReactTool.NAME ? "none" : this.claim.muted ? "prompt" : "turn",
      depth: this.claim.chain?.depth ?? 0,
      requester,
      cause: this.#decision,
    });
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
