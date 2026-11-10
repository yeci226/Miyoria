// The Floor (docs/design/v3-architecture.md §7): whether she may take the mic now. No model is
// involved. What it knows comes from the EventLog, so a restart rebuilds it:
//
// * her budget counts lines that really reached someone (`delivered`), and nothing else: running
//   a tool, starting a task, a turn that stayed quiet or a line that was cut off change nothing.
//   That is the MaiBot lesson of §7.2 (any tool reset its counter: 10 messages in 41 s).
// * a person speaking is the only thing that ends a run of lines nobody answered
//   (`max_unanswered`), and what adds to the budget (`per_human_line`).
// * how she feels is one weight on `base_lines`, inside hard limits (§12). It moves no count, no
//   claim and no interrupt level: lines already said stay said, `max_unanswered` stops her
//   however she feels, and a bad mood never takes her last line.
// * a hold ends when generation is over and every line of the turn settled: playback finished,
//   was cut off, failed or was cancelled. A line that never reports back loses the mic after
//   `max_hold_secs`: a lost ack must not make her mute (§21).
//
// The claim order is `FLOOR_CLAIMS`. The queue around it (coalescing, retries, the decision trail)
// is the Arbiter's: under `pipeline = "v3"` it asks this class instead of its own V2 rules.
//
// One decision on what she starts herself (v4 §7.6). Before, five limiters overlapped: the
// Arbiter's gaps between her starts, this class's wait after lines nobody answered, the channel
// level's start gap, mind's `SelfStarts` and the V2 `max_unanswered` of `unanswered.ts`. A wish
// could pass one and be held by the next with another reason and another time. Now `check` is the
// one place: every one of those waits is an input (`StartFacts`, read from the Arbiter's books and
// the channel level), the latest of them is the answer, with one reason and one retry time.

import {
  type ArbiterReason,
  type ContextKey,
  contextKeyString,
  type Delivery,
  type DeliveryLedger,
  type EventLog,
  type FloorBudget,
  type FloorClaimKind,
  type FloorHold,
  type Floor as FloorService,
  floorRank,
  type ImpulseAttention,
  type InterruptLevel,
  isJsonObject,
  type JsonValue,
  type LogEvent,
  type ObservationBody,
  type Projection,
  spendsBudget,
  type TurnId,
  timestampMs,
  toTimestamp,
  type UndeliveredBody,
  type UtteranceBody,
} from "@miyoria/types";
import type { FloorConfig } from "./config.js";

const MINUTE_MS = 60_000;
/** Turns and lines remembered: more than a window holds. */
const MEMORY = 2_000;
const PLACES = 500;

/** Source of the `decision` event that says what a turn was. */
export const FLOOR_SOURCE = "floor";

/** The `body` of a floor `decision` event. */
export interface FloorTurnBody {
  floor_turn: TurnId;
  kind: FloorClaimKind;
}

/** What the Floor reads that is not in the log. Every part is optional. */
export interface FloorEnv {
  now(): number;
  ledger?(): DeliveryLedger | null;
  log?(): Pick<EventLog, "append"> | null;
  /** People in that voice channel besides her (`null`: not voice, or unknown). */
  humans?(context: ContextKey): number | null;
  /** She is performing there: singing, or live with a game. */
  performing?(context: ContextKey): boolean;
  /** Her own talkativeness as a factor on the budget (1: as configured). */
  talk?(context: ContextKey): number;
  /** What her feelings lean her talkativeness (`AffectBiases.talkativeness`, 0: nothing). */
  feeling?(context: ContextKey): number;
  /** `context` is the channel her daily posts go to (`DailyPostsKey`): posting there needs nobody. */
  postsTo?(context: ContextKey): boolean;
}

/**
 * What the waits on her own starts depend on, from the Arbiter's books and the channel's level.
 * Times are epoch ms; a gap of 0 is no gap.
 */
export interface StartFacts {
  /** Her last own start anywhere, and in this place. */
  lastAnywhere: number | null;
  lastHere: number | null;
  /** Between any two of her starts (`min_gap_secs`). */
  minGapMs: number;
  /** The gap here before misses (`gap_text_secs` / `gap_voice_secs`). */
  baseGapMs: number;
  /** The gap here now: the base doubled per start nobody picked up, up to `max_backoff`. */
  placeGapMs: number;
  /** Her starts here in a row nobody picked up. */
  misses: number;
  /** The channel level's gap between her starts here (`start_gap_ms`). */
  levelGapMs: number;
  /** She just spoke here: her own starts wait until then (`after_speech_*_secs`). */
  afterSpeechUntil: number | null;
  /** Formats a time for her (`clockText`). */
  clock(at: number): string;
}

/** Why a claim may not take the mic. */
export interface FloorRefusal {
  reason: ArbiterReason;
  detail: string;
  retryAt: number | null;
}

interface Place {
  /** When lines of her own reached someone. */
  lines: number[];
  /** When people spoke here. */
  humans: number[];
  /** Her own turns in a row with no person speaking since. */
  unanswered: number;
  lastOwnAt: number | null;
  lastHumanAt: number | null;
}

interface TurnFact {
  kind: FloorClaimKind;
  place: string | null;
  /** It already counted as a turn of hers nobody asked for. */
  counted: boolean;
}

/** A small map that forgets its oldest keys. */
function trim<K, V>(map: Map<K, V>, max: number): void {
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) return;
    map.delete(oldest);
  }
}

function placeKey(context: ContextKey): string {
  return contextKeyString(context);
}

/** `v` when it is a number at all: a broken reading must not lift a limit. */
const finite = (v: number | undefined, otherwise: number): number =>
  v !== undefined && Number.isFinite(v) ? v : otherwise;

export class FloorCore implements FloorService, Projection {
  readonly #cfg: FloorConfig;
  readonly #maxUnanswered: number;
  readonly #env: FloorEnv;
  readonly #holds = new Map<TurnId, FloorHold>();
  readonly #places = new Map<string, Place>();
  readonly #turns = new Map<TurnId, TurnFact>();
  /** Line id → its turn. */
  readonly #lines = new Map<string, TurnId>();
  /** What a turn in flight is about: not claimable a second time. */
  readonly #reserved = new Map<string, { turn: TurnId | null; until: number }>();

  constructor(config: FloorConfig, maxUnanswered: number, env: FloorEnv) {
    this.#cfg = config;
    this.#maxUnanswered = maxUnanswered;
    this.#env = env;
  }

  #now(): number {
    return this.#env.now();
  }

  #place(key: string): Place {
    let place = this.#places.get(key);
    if (!place) {
      place = { lines: [], humans: [], unanswered: 0, lastOwnAt: null, lastHumanAt: null };
      this.#places.set(key, place);
      trim(this.#places, PLACES);
    }
    return place;
  }

  #prune(place: Place, now: number): void {
    const from = now - this.#cfg.budget.window_mins * MINUTE_MS;
    place.lines = place.lines.filter((at) => at > from);
    place.humans = place.humans.filter((at) => at > from);
  }

  // ---- holding the mic ------------------------------------------------------------------------

  hold(turn: TurnId, context: ContextKey, kind: FloorClaimKind): void {
    const place = placeKey(context);
    this.#turns.set(turn, { kind, place, counted: false });
    trim(this.#turns, MEMORY);
    this.#holds.set(turn, {
      turn,
      context,
      kind,
      since: toTimestamp(this.#now()),
      ended: false,
      lines: 0,
    });
    const body: FloorTurnBody = { floor_turn: turn, kind };
    this.#env.log?.()?.append({
      kind: "decision",
      source: FLOOR_SOURCE,
      context,
      body: body as unknown as JsonValue,
    });
  }

  turnEnded(turn: TurnId): void {
    const hold = this.#holds.get(turn);
    if (!hold) return;
    hold.ended = true;
    this.#maybeFree(hold);
  }

  release(turn: TurnId, _why: string): void {
    this.#holds.delete(turn);
    for (const [key, r] of this.#reserved) if (r.turn === turn) this.#reserved.delete(key);
  }

  releaseContext(context: ContextKey, why: string): void {
    const key = placeKey(context);
    for (const hold of [...this.#holds.values()]) {
      if (placeKey(hold.context) === key) this.release(hold.turn, why);
    }
  }

  #maybeFree(hold: FloorHold): void {
    if (hold.ended && hold.lines <= 0) this.release(hold.turn, "done");
  }

  holder(context: ContextKey): FloorHold | null {
    const key = placeKey(context);
    let best: FloorHold | null = null;
    for (const hold of this.#holds.values()) {
      if (placeKey(hold.context) !== key) continue;
      if (best === null || floorRank(hold.kind) < floorRank(best.kind)) best = hold;
    }
    return best === null ? null : { ...best };
  }

  /** What is held for longer than a line can take goes. */
  expire(): TurnId[] {
    const now = this.#now();
    const limit = this.#cfg.max_hold_secs * 1000;
    const gone: TurnId[] = [];
    for (const hold of [...this.#holds.values()]) {
      if (now - timestampMs(hold.since) < limit) continue;
      gone.push(hold.turn);
      this.release(hold.turn, "no ack");
    }
    for (const [key, r] of this.#reserved) if (r.until <= now) this.#reserved.delete(key);
    return gone;
  }

  interruptLevel(
    incoming: FloorClaimKind,
    holder: FloorClaimKind,
    overHer = false,
  ): InterruptLevel {
    // Nothing she chose to say herself cuts anyone off, and neither does a result.
    if (spendsBudget(incoming) || incoming === "result") return "queue";
    const ownLine = spendsBudget(holder);
    if (incoming === "urgent") {
      if (ownLine) return "cut_short";
      return holder === "urgent" ? "queue" : "wrap_up";
    }
    if (overHer) return "interrupt";
    return ownLine ? "wrap_up" : "queue";
  }

  // ---- budget ---------------------------------------------------------------------------------

  budget(context: ContextKey): FloorBudget {
    const now = this.#now();
    const place = this.#place(placeKey(context));
    this.#prune(place, now);
    const { budget } = this.#cfg;
    const performing = this.#env.performing?.(context) ?? false;
    const base = this.#ownLines(context) + place.humans.length * budget.per_human_line;
    return {
      window_mins: budget.window_mins,
      used: place.lines.length,
      allowed: Math.floor(base + (performing ? budget.performing_bonus : 0)),
      human_lines: place.humans.length,
      unanswered: place.unanswered,
      waiting_for_response: this.#waiting(place),
      performing,
    };
  }

  /** `base_lines` as she and her feelings want it, inside the owner's limits. */
  #ownLines(context: ContextKey): number {
    const { budget, max_talk_multiplier: most } = this.#cfg;
    const talk = Math.min(Math.max(finite(this.#env.talk?.(context), 1), 0), most);
    const {
      feeling_weight: weight,
      min_feeling_multiplier: low,
      max_feeling_multiplier: high,
    } = this.#cfg;
    const lean = finite(this.#env.feeling?.(context), 0);
    const felt = Math.min(Math.max(1 + weight * lean, low), high);
    const lines = budget.base_lines * Math.min(talk * felt, most);
    // What she would have had without her feelings, she has at least a line of.
    return Math.max(lines, Math.min(budget.base_lines * talk, 1));
  }

  #waiting(place: Place): boolean {
    return this.#maxUnanswered > 0 && place.unanswered >= this.#maxUnanswered;
  }

  /** `max_unanswered` reached in `context`. */
  waitingForResponse(context: ContextKey): boolean {
    return this.#waiting(this.#place(placeKey(context)));
  }

  /** When the next line of her own may come, after a run nobody answered. */
  #backoffUntil(place: Place): number | null {
    if (place.unanswered <= 0 || place.lastOwnAt === null) return null;
    const { backoff_base_secs: base, unanswered_backoff: factor } = this.#cfg.budget;
    return place.lastOwnAt + base * 1000 * factor ** (place.unanswered - 1);
  }

  /** People are around to hear something she starts herself. */
  #someoneThere(context: ContextKey, place: Place): boolean {
    if (context.kind === "dm") return true;
    // Her daily posts have a channel of their own (§8.4): a post is read later, by whoever comes.
    if (this.#env.postsTo?.(context) === true) return true;
    const humans = this.#env.humans?.(context) ?? null;
    if (humans !== null) return humans > 0;
    // A text channel has no roll call. Someone there not long ago is the nearest thing to it, and
    // a channel long gone quiet stays quiet (§7.2: silence is no reason to open a topic).
    const last = place.lastHumanAt;
    return last !== null && this.#now() - last <= this.#cfg.text_presence_mins * MINUTE_MS;
  }

  // ---- claims ---------------------------------------------------------------------------------

  /**
   * Whether `kind` may have the mic in `context` now. `addressed`, `reply`, `result` and `urgent`
   * always may: someone waits, or it cannot wait.
   */
  check(
    kind: FloorClaimKind,
    context: ContextKey,
    hint?: string | null,
    start?: StartFacts | null,
  ): FloorRefusal | null {
    if (!spendsBudget(kind)) return null;
    const now = this.#now();
    const place = this.#place(placeKey(context));
    this.#prune(place, now);
    if (kind !== "ambient" && this.#waiting(place)) {
      return {
        reason: "unanswered",
        detail: `你在這裡連續 ${this.#maxUnanswered} 次開口都沒人回應,等有人說話再開口`,
        retryAt: null,
      };
    }
    const budget = this.budget(context);
    if (budget.used >= budget.allowed) {
      const oldest = place.lines[0];
      const retryAt =
        oldest === undefined ? null : oldest + this.#cfg.budget.window_mins * MINUTE_MS;
      return {
        reason: "rate",
        detail: `這 ${budget.window_mins} 分鐘你自己講了 ${budget.used} 句,額度用完了,等大家說話再開口`,
        retryAt,
      };
    }
    const wait = this.#wait(kind, place, start ?? null, now);
    if (wait !== null) return wait;
    if (kind === "wish") {
      if (!this.#someoneThere(context, place)) {
        return { reason: "nobody", detail: "現在沒有真人在場,不對空氣說話", retryAt: null };
      }
      const said =
        hint === null || hint === undefined || hint.trim() === ""
          ? null
          : (this.#env.ledger?.()?.saidLately(hint, { context }) ?? null);
      if (said !== null) {
        return { reason: "repeat", detail: "這件事你剛說過了,沒有新進展就不用再提", retryAt: null };
      }
    }
    return null;
  }

  refuses(kind: FloorClaimKind, context: ContextKey, hint?: string | null): string | null {
    return this.check(kind, context, hint)?.detail ?? null;
  }

  /**
   * The one wait before a claim of `kind` (`null`: none): after lines nobody answered, for every
   * claim that spends her budget; and for a wish of hers with `start`, the gap since her last
   * start anywhere, the gap here (doubled per start nobody picked up), the channel level's gap and
   * the moment after she spoke. The latest of them decides, so she hears one reason and one time.
   */
  #wait(
    kind: FloorClaimKind,
    place: Place,
    start: StartFacts | null,
    now: number,
  ): FloorRefusal | null {
    const waits: FloorRefusal[] = [];
    const backoff = this.#backoffUntil(place);
    if (backoff !== null) {
      waits.push({
        reason: "unanswered",
        detail: `你剛才連續 ${place.unanswered} 次開口沒人回應,再等一下`,
        retryAt: backoff,
      });
    }
    if (kind === "wish" && start !== null) waits.push(...startWaits(start));
    let latest: FloorRefusal | null = null;
    for (const w of waits) {
      if (w.retryAt === null || w.retryAt <= now) continue;
      if (latest === null || (latest.retryAt ?? 0) < w.retryAt) latest = w;
    }
    return latest;
  }

  /** When a wish of hers with `start` may come in `context` (`null`: now). */
  startsAt(context: ContextKey, start: StartFacts): number | null {
    const now = this.#now();
    const place = this.#place(placeKey(context));
    return this.#wait("wish", place, start, now)?.retryAt ?? null;
  }

  // ---- narration dedupe -----------------------------------------------------------------------

  /** The revision a keyed claim stands for: a repeat window passed is a new one. */
  revisionOf(attention: ImpulseAttention): number {
    if (attention.revision !== undefined) return attention.revision;
    const last: Delivery | null = this.#env.ledger?.()?.delivered(attention.key) ?? null;
    if (last === null) return 1;
    const since = this.#now() - timestampMs(last.delivered_at);
    return since >= attention.repeat_after_ms ? last.revision + 1 : last.revision;
  }

  /** Whether this revision was delivered, or a turn is on its way to deliver it. */
  repeated(attention: ImpulseAttention): boolean {
    const revision = this.revisionOf(attention);
    if (this.#reserved.has(`${attention.key}#${revision}`)) return true;
    const ledger = this.#env.ledger?.() ?? null;
    if (ledger === null) return false;
    return !ledger.mayClaim({
      attention_key: attention.key,
      revision,
      salience: "notable",
    });
  }

  /** A turn took `attention`: nothing else claims it until the turn is over. */
  reserve(attention: ImpulseAttention, turn: TurnId | null): void {
    const revision = this.revisionOf(attention);
    this.#reserved.set(`${attention.key}#${revision}`, {
      turn,
      until: this.#now() + this.#cfg.max_hold_secs * 1000,
    });
    trim(this.#reserved, MEMORY);
  }

  /** `attention` did not go out: it may be claimed again. */
  unreserve(attention: ImpulseAttention): void {
    this.#reserved.delete(`${attention.key}#${this.revisionOf(attention)}`);
  }

  // ---- what happens around her ----------------------------------------------------------------

  /** A new stay in voice is a new audience: nobody there ignored her yet. */
  newAudience(context: ContextKey): void {
    this.#place(placeKey(context)).unanswered = 0;
  }

  #humanSpoke(context: ContextKey, at: number): void {
    const places = [placeKey(context)];
    // The text chat of a voice channel is the same room (same channel id, kind `channel`).
    if (context.kind === "channel") places.push(placeKey({ ...context, kind: "voice" }));
    for (const key of places) {
      const place = this.#place(key);
      place.humans.push(at);
      place.lastHumanAt = at;
      place.unanswered = 0;
    }
  }

  #delivered(delivery: Delivery, at: number): void {
    const turn = this.#lines.get(delivery.line);
    const fact = turn === undefined ? undefined : this.#turns.get(turn);
    if (turn !== undefined) this.#settled(turn);
    if (fact === undefined || !spendsBudget(fact.kind)) return;
    const place = this.#place(fact.place ?? placeKey(delivery.context));
    place.lines.push(at);
    place.lastOwnAt = at;
    // People already talking is not her talking to nobody: `ambient` needs a person to happen.
    if (!fact.counted && fact.kind !== "ambient") {
      fact.counted = true;
      place.unanswered += 1;
    }
  }

  #settled(turn: TurnId): void {
    const hold = this.#holds.get(turn);
    if (!hold) return;
    hold.lines = Math.max(hold.lines - 1, 0);
    this.#maybeFree(hold);
  }

  apply(event: LogEvent): void {
    const at = timestampMs(event.at);
    switch (event.kind) {
      case "decision": {
        if (event.source !== FLOOR_SOURCE || !isJsonObject(event.body)) return;
        const { floor_turn: turn, kind } = event.body as unknown as FloorTurnBody;
        if (typeof turn !== "string" || this.#turns.has(turn)) return;
        const place = event.context === null ? null : placeKey(event.context);
        this.#turns.set(turn, { kind, place, counted: false });
        trim(this.#turns, MEMORY);
        return;
      }
      case "utterance": {
        const turn = (event.body as unknown as UtteranceBody).turn;
        if (turn === null || turn === undefined) return;
        this.#lines.set(event.id, turn);
        trim(this.#lines, MEMORY);
        const hold = this.#holds.get(turn);
        if (hold) hold.lines += 1;
        return;
      }
      case "delivered":
        this.#delivered(event.body as unknown as Delivery, at);
        return;
      case "result": {
        if (!isJsonObject(event.body) || typeof event.body.delivery !== "string") return;
        const turn = this.#lines.get((event.body as unknown as UndeliveredBody).line);
        if (turn !== undefined) this.#settled(turn);
        return;
      }
      case "observation": {
        if (!isJsonObject(event.body) || !isJsonObject(event.body.observation)) return;
        const body = event.body as unknown as ObservationBody;
        const { from, context } = body.observation;
        if (body.speech === true && from !== null && context !== null) {
          this.#humanSpoke(context, at);
        }
        return;
      }
      default:
        return;
    }
  }
}

/** The waits of a start of hers that only depend on her books and the channel level. */
function startWaits(s: StartFacts): FloorRefusal[] {
  const out: FloorRefusal[] = [];
  if (s.lastAnywhere !== null && s.minGapMs > 0) {
    const at = s.lastAnywhere + s.minGapMs;
    out.push({ reason: "cooldown", detail: `剛主動開過話題,${s.clock(at)} 之後`, retryAt: at });
  }
  if (s.afterSpeechUntil !== null) {
    out.push({
      reason: "cooldown",
      detail: "你剛在這裡講完話,等一下再自己開話題",
      retryAt: s.afterSpeechUntil,
    });
  }
  if (s.lastHere !== null) {
    const at = s.lastHere + s.placeGapMs;
    const missed = s.misses > 0 && s.placeGapMs > s.baseGapMs;
    out.push({
      reason: missed ? "unanswered" : "cooldown",
      detail: missed
        ? `你在這裡主動開的話題最近連續 ${s.misses} 次沒人接,下次可主動在 ${s.clock(at)} 之後`
        : `你剛在這裡主動開過話題,下次可主動在 ${s.clock(at)} 之後`,
      retryAt: at,
    });
    if (s.levelGapMs > 0) {
      const level = s.lastHere + s.levelGapMs;
      out.push({
        reason: "ceiling",
        detail: `這個頻道的等級限制:${s.clock(level)} 之後才能再自己開話題`,
        retryAt: level,
      });
    }
  }
  return out;
}
