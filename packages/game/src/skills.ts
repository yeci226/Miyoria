// Skills (docs/design/v4-plan.md §11.2 item 8, §8.3): when a goal with a success condition is
// reached, the methods that made progress on the way are kept as "how I got X", and the next
// goal for X shows them to her. Published on `SKILL_TOPIC`, and kept across restarts by the
// director (`skill-store.ts`: her skill store, else the settings store through the work lane).
// Pure apart from the clock values passed in.

/** Topic of a learned skill, `Skill`. */
export const SKILL_TOPIC = "game.director.skill";

export interface Skill {
  game: string;
  /** The item the goal wanted. */
  target: string;
  /** The goal as she put it. */
  goal: string;
  /** The methods that made progress, in order (`obtain {"item":"cooked_beef"}`). */
  steps: string[];
  at: number;
}

/** Kept per target (newest first) and in all. */
const PER_TARGET = 3;
const MAX_SKILLS = 40;

export class SkillBook {
  readonly #skills: Skill[] = [];

  /** Keeps a skill (an identical one moves to the front). Returns it, or `null` without steps. */
  learn(skill: Skill): Skill | null {
    if (skill.steps.length === 0) return null;
    const same = (s: Skill) =>
      s.game === skill.game &&
      s.target === skill.target &&
      s.steps.join("\n") === skill.steps.join("\n");
    const i = this.#skills.findIndex(same);
    if (i >= 0) this.#skills.splice(i, 1);
    this.#skills.unshift(skill);
    const forTarget = this.#skills.filter(
      (s) => s.game === skill.game && s.target === skill.target,
    );
    for (const old of forTarget.slice(PER_TARGET))
      this.#skills.splice(this.#skills.indexOf(old), 1);
    this.#skills.splice(MAX_SKILLS);
    return skill;
  }

  /**
   * A skill kept from an earlier run: it goes behind what she learned since (older), and an
   * identical one is not kept twice.
   */
  restore(skill: Skill): void {
    if (skill.steps.length === 0) return;
    const same = this.#skills.some(
      (s) =>
        s.game === skill.game &&
        s.target === skill.target &&
        s.steps.join("\n") === skill.steps.join("\n"),
    );
    if (same) return;
    const forTarget = this.#skills.filter(
      (s) => s.game === skill.game && s.target === skill.target,
    );
    if (forTarget.length >= PER_TARGET || this.#skills.length >= MAX_SKILLS) return;
    this.#skills.push(skill);
  }

  /** Every skill of `game`, newest first (what is kept across restarts). */
  forGame(game: string): Skill[] {
    return this.#skills.filter((s) => s.game === game);
  }

  forTarget(game: string, target: string): Skill[] {
    return this.#skills.filter((s) => s.game === game && s.target === target);
  }

  /**
   * Prompt lines: the ways she got `target` before, or (no target) the things she has managed
   * at all, newest first.
   */
  lines(game: string, target: string | null, max = 5): string[] {
    if (target !== null) {
      return this.forTarget(game, target).map((s) => `之前拿到 ${s.target}:${s.steps.join(" → ")}`);
    }
    const seen = new Set<string>();
    const out: string[] = [];
    for (const s of this.#skills) {
      if (s.game !== game || seen.has(s.target)) continue;
      seen.add(s.target);
      out.push(`${s.target}:${s.steps.join(" → ")}`);
      if (out.length >= max) break;
    }
    return out;
  }
}
