import type { AccountRef, ContextKey, Timestamp } from "@miyoria/types";
import { timestampMs } from "@miyoria/types";

/** Short numeric id, convenient to type in commands (`queue skip 3`). */
export type ItemId = number;

export type ItemState = "pending" | "active" | "done" | "skipped" | "removed";

export interface QueueItem {
  id: ItemId;
  requester: AccountRef;
  requester_name: string;
  /** Free-form, e.g. `game_goal`, `song`, `chat`. */
  kind: string;
  text: string;
  /** Where the request was made, for replying later. */
  context: ContextKey | null;
  created_at: Timestamp;
  /** Moderator-set; higher goes first, ahead of fairness. */
  priority: number;
  /** Manual position set by `moveItem`; orders items of equal priority. */
  slot: number | null;
  /** Upvote count (`voters.length`). */
  votes: number;
  voters: AccountRef[];
  state: ItemState;
}

/** Input of `RequestQueue.submit`. */
export interface SubmitRequest {
  requester: AccountRef;
  requesterName: string;
  kind: string;
  text: string;
  context?: ContextKey | null;
  priority?: number;
}

export interface Ballot {
  account: AccountRef;
  option: number;
  /** When the ballot was cast or last changed. */
  at: Timestamp;
}

/** A running vote. */
export interface VoteState {
  options: string[];
  started_at: Timestamp;
  ends_at: Timestamp;
  /** One per account (latest wins). */
  ballots: Ballot[];
}

/** Ballots per option. */
export function tallies(vote: Pick<VoteState, "options" | "ballots">): number[] {
  const t = vote.options.map(() => 0);
  for (const b of vote.ballots) {
    if (b.option < t.length) t[b.option] = (t[b.option] ?? 0) + 1;
  }
  return t;
}

/**
 * Option with the most ballots. Ties go to the option that reached its tally first (smallest
 * time of its latest ballot). `null` without ballots.
 */
export function voteWinner(vote: Pick<VoteState, "options" | "ballots">): number | null {
  const counts = tallies(vote);
  let best: { index: number; count: number; reached: number } | null = null;
  for (let i = 0; i < vote.options.length; i++) {
    const count = counts[i] ?? 0;
    if (count === 0) continue;
    let reached = Number.NEGATIVE_INFINITY;
    for (const b of vote.ballots)
      if (b.option === i) reached = Math.max(reached, timestampMs(b.at));
    if (best === null || count > best.count || (count === best.count && reached < best.reached)) {
      best = { index: i, count, reached };
    }
  }
  return best?.index ?? null;
}

/** Outcome of a finished vote. */
export interface VoteResult {
  options: string[];
  tallies: number[];
  winner: number | null;
  total: number;
  ended_at: Timestamp;
}

export function winnerOption(result: Pick<VoteResult, "options" | "winner">): string | null {
  return result.winner === null ? null : (result.options[result.winner] ?? null);
}

export type QueueErrorKind =
  | "blocked"
  | "empty_text"
  | "text_too_long"
  | "user_limit"
  | "queue_full"
  | "not_found"
  | "wrong_state"
  | "vote_running"
  | "no_vote"
  | "bad_vote"
  | "unknown_option";

/** Why a queue operation was refused. `arg` carries the variant's value (limit, id, text). */
export class QueueError extends Error {
  override readonly name = "QueueError";

  constructor(
    readonly kind: QueueErrorKind,
    message: string,
    readonly arg: number | string | null = null,
  ) {
    super(message);
  }

  static blocked(): QueueError {
    return new QueueError("blocked", "the requester is blocked");
  }
  static emptyText(): QueueError {
    return new QueueError("empty_text", "request text is empty");
  }
  static textTooLong(max: number): QueueError {
    return new QueueError("text_too_long", `request text is longer than ${max} characters`, max);
  }
  static userLimit(max: number): QueueError {
    return new QueueError("user_limit", `already ${max} pending requests from this account`, max);
  }
  static queueFull(max: number): QueueError {
    return new QueueError("queue_full", `the queue is full (${max} pending)`, max);
  }
  static notFound(id: ItemId): QueueError {
    return new QueueError("not_found", `no item #${id}`, id);
  }
  static wrongState(id: ItemId): QueueError {
    return new QueueError("wrong_state", `item #${id} is not in a state that allows this`, id);
  }
  static voteRunning(): QueueError {
    return new QueueError("vote_running", "a vote is already running");
  }
  static noVote(): QueueError {
    return new QueueError("no_vote", "no vote is running");
  }
  static badVote(why: string): QueueError {
    return new QueueError("bad_vote", `invalid vote: ${why}`, why);
  }
  static unknownOption(option: string): QueueError {
    return new QueueError("unknown_option", `unknown vote option \`${option}\``, option);
  }
}
