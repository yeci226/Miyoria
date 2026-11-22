// The main line (docs/design/v3-architecture.md §3, §10): the mouth every line of hers goes
// through, and what it keeps of them.
//
// `MainLine` lives as long as the module: the lines in flight (`LineBook`, the DeliveryLedger),
// her commitments (`CommitmentBook`, read back from the log) and the mouth the scheduler asks
// ("is this one of yours?"). The turns themselves are the new runner's (`@miyoria/brain/selfhost`):
// it marks its turns as the main line's (`own`), holds the Floor for a run (`holdsFloor`) and says
// each line through `say`, which is also the way out for fixed lines (the panel's "say", a game's
// chat reply).

import { errorMessage, interval } from "@miyoria/runtime/kernel";
import {
  type Action,
  type ActionSettled,
  type ActionSink,
  ActionSinkKey,
  type ContextKey,
  contextKeyEquals,
  DeliveryLedgerKey,
  DirectivesKey,
  EventLogKey,
  Events,
  type FixedLine,
  type Floor,
  FloorKey,
  type Handle,
  type JsonValue,
  type MessageRef,
  ModerationKey,
  type Mouth,
  newAction,
  newId,
  type PinnedMemory,
  PinnedMemoryKey,
  safeOutgoing,
  type TurnId,
  textLane,
  topicKey,
  toTimestamp,
  voiceLane,
  type Wishes,
  WishesKey,
  WorkingContextKey,
} from "@miyoria/types";
import type { MainLineConfig } from "../config.js";
import { voiceScope } from "../handle.js";
import type { Agent } from "../runtime.js";
import { CommitmentBook } from "./commitments.js";
import { LineBook } from "./lines.js";

/** What she says when something has to be said and the model cannot (§21). */
export const FALLBACK_LINES = [
  "欸?我剛剛恍神了,可以再說一次嗎?",
  "等等,腦袋卡了一下……再跟我說一次好不好?",
];

const TURNS_REMEMBERED = 512;
/** Log history the commitments are rebuilt from. */
const REBUILD_MS = 24 * 3_600_000;

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

interface LineInfo {
  attention(said: string): { key: string; revision: number };
  audience(): readonly Handle[];
  /** Whom the line is said to (`FixedLine.to`); `undefined`: not known. */
  to?(): readonly Handle[] | undefined;
  cause(): string | null;
}

export class MainLine implements Mouth {
  readonly #agent: Agent;
  readonly lines: LineBook;
  readonly commitments: CommitmentBook;
  readonly #turns = new Set<TurnId>();
  /** Turns of the text runner that hold the Floor for their whole run (`holdsFloor`). */
  readonly #held = new Set<TurnId>();
  /** The reply reference of a turn's next text line in a place (`replyNext`). */
  readonly #replies = new Map<TurnId, { context: ContextKey; ref: MessageRef }>();
  /** What the lines of a turn are about, when the Arbiter admitted it for that (`about`). */
  readonly #about = new Map<TurnId, { key: string; revision: number }>();
  #stopFollowing: (() => void)[] = [];
  #pinned: PinnedMemory | null = null;

  constructor(agent: Agent) {
    this.#agent = agent;
    const services = agent.ctx.services;
    const now = () => agent.ctx.clock.now();
    const log = () => services.get(EventLogKey) ?? null;
    this.lines = new LineBook(() => services.get(DeliveryLedgerKey) ?? null, now);
    this.commitments = new CommitmentBook(log, now, this.config.commitment_due_secs, () =>
      this.wishes(),
    );
  }

  /** What she wants to ask whom (the arbiter's book), when it runs. */
  wishes(): Wishes | null {
    return this.#agent.ctx.services.get(WishesKey) ?? null;
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
    }
    ctx.spawn("commitments", async (signal) => {
      for await (const _ of interval(this.config.commitment_sweep_ms, signal)) {
        this.commitments.remind();
      }
    });
  }

  stop(): void {
    for (const stop of this.#stopFollowing.splice(0)) stop();
  }

  /**
   * The pinned layer, with what only the main line owns plugged in. Looked up per run: the memory
   * module starts after this one and may restart. The prompt keeps the whole persona in its fixed
   * prefix, which must stay the same from run to run and uncut, so that section is not read back.
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
  #mouth(sink: ActionSink, info: LineInfo): ActionSink {
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
          to: info.to?.(),
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

  /**
   * The text runner's run of `turn` holds the Floor from its start to its end (`held`), or no
   * longer: while it does, `say` takes no hold of its own for a line of that turn.
   */
  holdsFloor(turn: TurnId, held: boolean): void {
    if (held) this.#held.add(turn);
    else {
      this.#held.delete(turn);
      this.#replies.delete(turn);
      this.#about.delete(turn);
    }
  }

  /**
   * The lines of `turn` are about `attention` (an observation the Arbiter admitted the run for),
   * until the run lets go of the Floor: the delivery ledger then knows it was said, so the same
   * thing is not claimed again within its repeat window.
   */
  about(turn: TurnId, attention: { key: string; revision?: number } | null): void {
    if (attention === null) return;
    this.#about.set(turn, { key: attention.key, revision: attention.revision ?? 1 });
    while (this.#about.size > TURNS_REMEMBERED) {
      const oldest = this.#about.keys().next().value;
      if (oldest === undefined) break;
      this.#about.delete(oldest);
    }
  }

  /** The next line `say` sends for `turn` in `context` answers `ref` (the platform's reference). */
  replyNext(turn: TurnId, context: ContextKey, ref: MessageRef | null): void {
    if (ref === null) this.#replies.delete(turn);
    else this.#replies.set(turn, { context, ref });
  }

  /** The reply reference `replyNext` left for this line, taken. */
  #replyOf(turn: TurnId, context: ContextKey): MessageRef | null {
    const reply = this.#replies.get(turn);
    if (reply === undefined || !contextKeyEquals(reply.context, context)) return null;
    this.#replies.delete(turn);
    return reply.ref;
  }

  async say(line: FixedLine): Promise<void> {
    const agent = this.#agent;
    if (agent.muted) return;
    const turn = line.turn ?? newId();
    this.own(turn);
    const { context } = line;
    const replyTo = this.#replyOf(turn, context);
    const safe = safeOutgoing(agent.ctx.services.get(ModerationKey), {
      path: "reply",
      text: line.text,
      aloud: context.kind === "voice",
      context,
      turn,
    });
    const { text } = safe;
    const blocked = safe.blocked ?? line.blocked ?? null;
    const floor = this.#held.has(turn) ? null : this.floor();
    floor?.hold(turn, context, "result");
    const sink = agent.ctx.services.get(ActionSinkKey);
    try {
      if (!sink) throw new Error("no scheduler");
      const about = this.#about.get(turn) ?? null;
      const mouth = this.#mouth(sink, {
        attention: (said) => about ?? { key: topicKey(said), revision: 1 },
        audience: () => line.audience ?? agent.audience(context),
        to: () => line.to,
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
      await mouth.submit(
        newAction(
          textLane(context),
          priority,
          { type: "send_message", context, message: { text, reply_to: replyTo } },
          { ttl: agent.config.reply_ttl_ms, turn, blocked },
        ),
      );
    } finally {
      floor?.turnEnded(turn);
    }
  }

  // ---- what comes back ------------------------------------------------------------------------

  /** A bus event the main line follows (`action.settled`). Returns whether it was one. */
  custom(topic: string, payload: JsonValue): boolean {
    if (topic === Events.ActionSettled.type) {
      this.lines.settled(payload as unknown as ActionSettled);
      return true;
    }
    return false;
  }

  /**
   * The owner's rules (his directives), all of them, every run. Nothing else: what is on hold and
   * what did not work lately are her state (the ledger block, `ledgerBlock`), never rules. A tool
   * that failed once was shown here as a rule she had to obey (2026-11-22: 「送魚幣給一個人:不知道
   * 「…」是誰,沒有送出」 under 主人規則).
   */
  ownerRules(context: ContextKey): string[] {
    return this.#agent.ctx.services.get(DirectivesKey)?.inject(context) ?? [];
  }

  /** Tasks in flight, from what the executors say about themselves. */
  tasks(): { owner: string; task: string; text: string }[] {
    const buckets = this.#agent.ctx.services.get(WorkingContextKey)?.buckets() ?? [];
    return buckets.flatMap((b) => {
      if (!b.writer.endsWith(".task")) return [];
      // The game director's own driven task is its business, not a task of hers.
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
}
