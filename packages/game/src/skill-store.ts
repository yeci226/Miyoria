// Where the director's skills live across restarts (docs/design/v4-plan.md §11.2 item 8, §8.3).
//
// Until now what she learned in a game ("bread: farm wheat, then craft") lived in the module and
// was gone with it. Kept here, in this order:
//
// 1. her skill store, when the `skills` module runs: one skill per game (`game-minecraft`), a
//    readable page she can open herself, written and read through the gate like any skill
//    (principal `director`), so its limits and the owner's rules hold;
// 2. else (or when that refuses) the settings store, through the work lane (`WorkLane.keep`).
//
// The page is lines she can read, one per item: `- bread ← obtain {"item":"wheat"} → …`.

import type { ActionOutcome } from "@miyoria/actions";
import { errorMessage, getLogger } from "@miyoria/kernel";
import { isJsonObject, type JsonObject, type JsonValue, type WorkLane } from "@miyoria/types";
import type { Skill } from "./skills.js";

const log = getLogger("game.skills");

export const SKILL_READ = "skill.read";
export const SKILL_WRITE = "skill.write";

/** Her skill of a game's ways (`game-minecraft`). */
export function skillName(game: string): string {
  return `game-${game.toLowerCase().replace(/[^a-z0-9_-]/g, "-")}`.slice(0, 48);
}

const ARROW = " → ";
const LINE = /^- ([a-z0-9_:+-]+) ← (.+)$/;

/** The page of a game's skills (newest first). */
export function skillPage(game: string, skills: readonly Skill[]): string {
  return [
    `玩 ${game} 時拿到東西的做法(遊戲自己記下的,新的在前面)。每行:要的東西 ← 有進展的步驟。`,
    "",
    ...skills.map((s) => `- ${s.target} ← ${s.steps.join(ARROW)}`),
  ].join("\n");
}

/** The skills on a page written by `skillPage` (lines it does not know are skipped). */
export function parseSkillPage(game: string, text: string, at: number): Skill[] {
  const out: Skill[] = [];
  for (const raw of text.split("\n")) {
    const m = LINE.exec(raw.trim());
    if (!m) continue;
    const steps = (m[2] ?? "")
      .split(ARROW)
      .map((s) => s.trim())
      .filter((s) => s !== "");
    if (steps.length === 0) continue;
    out.push({ game, target: m[1] as string, goal: m[1] as string, steps, at });
  }
  return out;
}

function fromJson(game: string, value: JsonValue | null): Skill[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((v) => {
    if (!isJsonObject(v) || typeof v.target !== "string" || !Array.isArray(v.steps)) return [];
    const steps = v.steps.filter((s): s is string => typeof s === "string");
    if (steps.length === 0) return [];
    return [
      {
        game,
        target: v.target,
        goal: typeof v.goal === "string" ? v.goal : v.target,
        steps,
        at: typeof v.at === "number" ? v.at : 0,
      },
    ];
  });
}

/** A skill capability, run by the director through the gate (principal `director`). */
export type SkillCall = (
  call: { capability: string; args: JsonObject; why: string },
  signal?: AbortSignal,
) => Promise<ActionOutcome>;

export interface ShelfDeps {
  /** Whether her skill store offers `capability` (the `skills` module runs). */
  has(capability: string): boolean;
  act: SkillCall;
  lane(): WorkLane | null;
  now(): number;
}

/** The owner a game's skills are kept under in the work lane. */
export function skillOwner(game: string): string {
  return `game.${game}`;
}

export class SkillShelf {
  readonly #d: ShelfDeps;

  constructor(deps: ShelfDeps) {
    this.#d = deps;
  }

  #has(capability: string): boolean {
    return this.#d.has(capability);
  }

  /** The skills kept for `game`, newest first; none when nothing is kept anywhere. */
  async load(game: string, signal?: AbortSignal): Promise<Skill[]> {
    if (this.#has(SKILL_READ)) {
      try {
        const outcome = await this.#d.act(
          {
            capability: SKILL_READ,
            args: { name: skillName(game) },
            why: "遊戲開始前,想起之前學會的做法",
          },
          signal,
        );
        if (outcome.status === "done") {
          const page = isJsonObject(outcome.result.data) ? outcome.result.data.text : null;
          const text = typeof page === "string" ? page : outcome.result.text;
          const skills = parseSkillPage(game, text, this.#d.now());
          if (skills.length > 0) return skills;
        }
      } catch (error) {
        log.debug({ game, err: errorMessage(error) }, "no skill page to read");
      }
    }
    const lane = this.#d.lane();
    if (lane === null) return [];
    try {
      return fromJson(game, await lane.kept(skillOwner(game), "skills"));
    } catch (error) {
      log.debug({ game, err: errorMessage(error) }, "no kept skills");
      return [];
    }
  }

  /** Keeps `skills` (newest first) for `game`: her skill store if it takes them, else the lane. */
  async save(
    game: string,
    skills: readonly Skill[],
    signal?: AbortSignal,
  ): Promise<"skills" | "settings" | "none"> {
    if (this.#has(SKILL_WRITE)) {
      try {
        const outcome = await this.#d.act(
          {
            capability: SKILL_WRITE,
            args: {
              name: skillName(game),
              description: `玩 ${game} 時拿到各種東西的做法(遊戲自己記的)`,
              body: skillPage(game, skills),
            },
            why: "記下這場學會的做法",
          },
          signal,
        );
        if (outcome.status === "done") return "skills";
        log.debug({ game, status: outcome.status }, "the skill store did not take the skills");
      } catch (error) {
        log.debug({ game, err: errorMessage(error) }, "could not write the skill page");
      }
    }
    const lane = this.#d.lane();
    if (lane === null) return "none";
    const value = skills.map((s) => ({
      target: s.target,
      goal: s.goal,
      steps: [...s.steps],
      at: s.at,
    }));
    await lane.keep(skillOwner(game), "skills", value);
    return "settings";
  }
}
