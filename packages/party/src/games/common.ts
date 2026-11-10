// Small pieces the games share.

import { safeName } from "@miyoria/types";
import type { Player } from "../game.js";
import { closeness, fold, judgeAnswer, type Verdict } from "../match.js";

/** What someone said, quoted for her: short and inert. */
export function quote(text: string, max = 40): string {
  return safeName(text, max);
}

/** How she calls a player in a note. */
export function nameOf(player: Player): string {
  return player.her ? "你" : safeName(player.name, 24);
}

/** Whole seconds left until `deadline`. */
export function secsLeft(deadline: number, now: number): number {
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

/** A guess at a hidden answer that is still open. */
export interface NearMiss {
  player: Player;
  text: string;
}

/**
 * One round of "guess the hidden answer" (quiz, song): who got it, near misses for her to rule
 * on, and the hints given. The answer never leaves this object while the round is open, except
 * through `reveal` once it is over.
 */
export class HiddenRound {
  readonly no: number;
  readonly deadline: number;
  readonly #answers: readonly string[];
  #open = true;
  #hints = 0;
  #near: NearMiss | null = null;
  readonly #hintLines: string[] = [];
  /** Players who already got a near-miss note this round (one each). */
  readonly #told = new Set<string>();

  constructor(no: number, answers: readonly string[], deadline: number) {
    this.no = no;
    this.#answers = answers;
    this.deadline = deadline;
  }

  get open(): boolean {
    return this.#open;
  }

  get near(): NearMiss | null {
    return this.#near;
  }

  get hintsGiven(): readonly string[] {
    return this.#hintLines;
  }

  /** The answer, once the round is over (`null` while it is open). */
  revealed(): string | null {
    return this.#open ? null : (this.#answers[0] ?? "");
  }

  /** Closes the round and gives the answer: only for the moment it is announced. */
  close(): string {
    this.#open = false;
    this.#near = null;
    return this.#answers[0] ?? "";
  }

  judge(text: string): Verdict {
    return this.#open ? judgeAnswer(text, this.#answers) : "miss";
  }

  /** How near a near miss is, without the answer. */
  howClose(text: string): string {
    return closeness(text, this.#answers);
  }

  /** Remembers a near miss; true the first time this player has one this round. */
  nearMiss(player: Player, text: string): boolean {
    this.#near = { player, text };
    if (this.#told.has(player.key)) return false;
    this.#told.add(player.key);
    return true;
  }

  /** Takes the near miss waiting for her ruling (of `player`, when given). */
  takeNear(player: Player | null): NearMiss | null {
    const near = this.#near;
    if (near === null || (player !== null && near.player.key !== player.key)) return null;
    this.#near = null;
    return near;
  }

  /**
   * The next hint: `extra` first (e.g. the singer), then the length, the first character, the
   * first two. `null` when there is no more.
   */
  hint(extra: readonly string[] = []): string | null {
    const answer = this.#answers[0] ?? "";
    const chars = [...answer.replace(/\s+/g, "")];
    const numeric = /^\d+$/.test(fold(answer));
    const steps = [
      ...extra,
      numeric ? "答案是一個數字" : `答案是 ${chars.length} 個字`,
      ...(numeric ? [] : [`第一個字是「${chars[0] ?? ""}」`]),
      ...(!numeric && chars.length >= 4 ? [`前兩個字是「${chars.slice(0, 2).join("")}」`] : []),
    ];
    const step = steps[this.#hints];
    if (step === undefined) return null;
    this.#hints++;
    this.#hintLines.push(step);
    return step;
  }
}
