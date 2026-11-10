// `attention_key` (docs/design/v3-architecture.md §6, §8): the content key of a thing that
// happened, so saying it again in other words is still the same thing. V2's narration stop-gap
// (`@miyoria/game` narration.ts, `Impulse.attention`) and the V3 fact layer use the same keys,
// which is what lets a later phase replace the one with the other.

import { isJsonObject, type JsonObject, type JsonValue } from "./json.js";

/** Letters of a free line in its own key. */
const KEY_LETTERS = 24;
/** Goals that end in having an item: the same thing as the event of making it. */
const ITEM_ACTIONS = new Set(["craft", "obtain", "get"]);

/** Game events that are worth a line although nothing marks them important. */
export const NOTED_GAME_EVENTS: readonly string[] = [
  "craft_finished",
  "smelt_finished",
  "night_started",
];

/** Letters and digits only, lower case (CJK kept). */
export function keyLetters(text: string): string {
  return [...text.toLowerCase()].filter((c) => /[\p{L}\p{N}]/u.test(c)).join("");
}

function bigrams(text: string): Set<string> {
  const chars = [...keyLetters(text)];
  const out = new Set<string>();
  for (let i = 0; i + 1 < chars.length; i++) out.add(`${chars[i]}${chars[i + 1]}`);
  return out;
}

/**
 * Whether two short lines are about the same thing: at least 3 shared character bigrams covering
 * at least 40% of the shorter one (the rule of `mind/selfstart.ts`).
 */
export function similarLines(a: string, b: string): boolean {
  const x = bigrams(a);
  const y = bigrams(b);
  if (x.size === 0 || y.size === 0) return false;
  let shared = 0;
  for (const g of x) if (y.has(g)) shared++;
  return shared >= 3 && shared / Math.min(x.size, y.size) >= 0.4;
}

/** What a game event is about (`stone_pickaxe`, `zombie`, `lava`), `""` when it does not say. */
export function gameEventSubject(data: JsonObject | null): string {
  if (data === null) return "";
  for (const field of ["item", "title", "attacker", "last_attacker", "kind", "source"]) {
    const value = data[field];
    if (typeof value === "string" && value !== "") return value;
  }
  const types = data.new_types;
  if (Array.isArray(types)) {
    return types
      .filter((t) => typeof t === "string")
      .sort()
      .join("+");
  }
  const items = data.items;
  if (isJsonObject(items)) return Object.keys(items).sort().join("+");
  return "";
}

/** The key of a game event: `game:craft:stone_pickaxe`, `game:damage:zombie`, `game:night_started`. */
export function gameEventKey(kind: string, data: JsonObject | null): string {
  const what = gameEventSubject(data);
  const name = kind.replace(/_finished$/, "");
  return what === "" ? `game:${name}` : `game:${name}:${what}`;
}

/** The action a goal was running, as far as a key cares. */
export interface GoalAction {
  name: string;
  args: { [key: string]: JsonValue };
}

/** The key of a goal she reached (one that ends in having an item: the key of making it). */
export function gameGoalKey(text: string, action: GoalAction | null): string {
  const item = action?.args.item;
  if (action && ITEM_ACTIONS.has(action.name) && typeof item === "string" && item !== "") {
    return `game:craft:${item}`;
  }
  return `game:goal:${[...keyLetters(text)].slice(0, KEY_LETTERS).join("")}`;
}

/** The key of a game line that is about nothing that happened. */
export function gameRemarkKey(text: string): string {
  return `game:remark:${[...keyLetters(text)].slice(0, KEY_LETTERS).join("")}`;
}

/** The key of a topic she came up with herself (§8: `topic:<normalized>`). */
export function topicKey(text: string): string {
  return `topic:${[...keyLetters(text)].slice(0, KEY_LETTERS).join("")}`;
}
