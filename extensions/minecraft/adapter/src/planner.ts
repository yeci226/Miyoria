// Works backwards from an item she wants to the steps that get it in survival: recipes, smelting,
// the blocks that drop it and the pickaxe tier each block needs (harvest.ts), the crafting
// table / furnace each step stands at, and food: the animals that drop meat (hunting), the
// furnace that cooks it, the crops a farm gives. Pure: inventory in, steps out. The runner
// (obtain.ts) executes the first step and plans again from what the game really shows.
//
// Food came last (docs/design/v4-plan.md §11.2 item 4): on 2026-11-08 she asked `obtain` for
// bread, cooked beef, cod and apples dozens of times and it only knew crafting, so every answer
// was "no recipe" or "missing wheat".
//
// Ingredients that any member of a vanilla tag satisfies are groups: `#logs`, `#planks`
// (`oak_planks` from `oak_log`, ...), `#stone` (cobblestone, cobbled deepslate, blackstone) and
// `#coal` (coal, charcoal). Each source is produced in one go for the whole plan (all the logs
// at once, not a trip per plank).

import { type Tier, pickaxeTier, requiredTier } from "./harvest.js";
import { zh } from "./names.js";

export type Inventory = Record<string, number>;

const WOODS = ["oak", "birch", "spruce", "jungle", "acacia", "dark_oak", "mangrove", "cherry"];
const STEMS = ["crimson", "warped"];
const COLORS = [
  "white",
  "orange",
  "magenta",
  "light_blue",
  "yellow",
  "lime",
  "pink",
  "gray",
  "light_gray",
  "cyan",
  "purple",
  "blue",
  "brown",
  "green",
  "red",
  "black",
];

const GROUPS: Record<string, string[]> = {
  "#logs": [
    ...WOODS.flatMap((w) => [`${w}_log`, `stripped_${w}_log`, `${w}_wood`, `stripped_${w}_wood`]),
    ...STEMS.flatMap((w) => [`${w}_stem`, `stripped_${w}_stem`, `${w}_hyphae`, `stripped_${w}_hyphae`]),
  ],
  "#planks": [...WOODS, ...STEMS, "bamboo"].map((w) => `${w}_planks`),
  "#stone": ["cobblestone", "cobbled_deepslate", "blackstone"],
  "#coal": ["coal", "charcoal"],
  "#wool": COLORS.map((c) => `${c}_wool`),
  "#beds": COLORS.map((c) => `${c}_bed`),
  /** Raw meat, what hunting any animal gives. */
  "#meat": ["beef", "porkchop", "mutton", "chicken", "rabbit"],
  /** Anything worth eating (no rotten flesh, no spider eyes). */
  "#food": [
    "cooked_beef",
    "cooked_porkchop",
    "cooked_mutton",
    "cooked_chicken",
    "cooked_rabbit",
    "cooked_cod",
    "cooked_salmon",
    "bread",
    "baked_potato",
    "golden_carrot",
    "apple",
    "carrot",
    "potato",
    "beetroot",
    "melon_slice",
    "sweet_berries",
    "glow_berries",
    "dried_kelp",
    "cookie",
    "pumpkin_pie",
    "mushroom_stew",
    "beef",
    "porkchop",
    "mutton",
    "chicken",
    "rabbit",
    "cod",
    "salmon",
  ],
};

/** The planks a log makes (`stripped_birch_wood` → `birch_planks`). */
export function planksOf(log: string): string | undefined {
  // longest match first: `dark_oak` before `oak`
  const wood = [...WOODS, ...STEMS].sort((a, b) => b.length - a.length).find((w) => log.includes(w));
  return wood ? `${wood}_planks` : undefined;
}

export function isGroup(item: string): boolean {
  return item.startsWith("#");
}

export function members(item: string): string[] {
  return GROUPS[item] ?? [item];
}

/** How many of `item` (a group counts every member) the inventory holds. */
export function countOf(inv: Inventory, item: string): number {
  let n = inv[item] ?? 0;
  if (isGroup(item)) for (const m of members(item)) n += inv[m] ?? 0;
  return n;
}

interface Recipe {
  yield: number;
  needs: Array<[string, number]>;
  /** 3x3: needs a crafting table. */
  table: boolean;
}

const recipe = (y: number, needs: Array<[string, number]>, table = true): Recipe => ({ yield: y, needs, table });

const RECIPES: Record<string, Recipe> = {
  "#planks": recipe(4, [["#logs", 1]], false),
  stick: recipe(4, [["#planks", 2]], false),
  crafting_table: recipe(1, [["#planks", 4]], false),
  furnace: recipe(1, [["#stone", 8]]),
  chest: recipe(1, [["#planks", 8]]),
  torch: recipe(4, [["#coal", 1], ["stick", 1]], false),
  bucket: recipe(1, [["iron_ingot", 3]]),
  shears: recipe(1, [["iron_ingot", 2]], false),
  shield: recipe(1, [["#planks", 6], ["iron_ingot", 1]]),
  bowl: recipe(4, [["#planks", 3]]),
  ladder: recipe(3, [["stick", 7]]),
  bread: recipe(1, [["wheat", 3]]),
  flint_and_steel: recipe(1, [["iron_ingot", 1], ["flint", 1]], false),
  blaze_powder: recipe(2, [["blaze_rod", 1]], false),
  ender_eye: recipe(1, [["blaze_powder", 1], ["ender_pearl", 1]], false),
  bow: recipe(1, [["stick", 3], ["string", 3]]),
  arrow: recipe(4, [["flint", 1], ["stick", 1], ["feather", 1]]),
};

// A bed takes three wool of its own colour (any planks).
for (const c of COLORS) RECIPES[`${c}_bed`] = recipe(1, [[`${c}_wool`, 3], ["#planks", 3]]);

// Tools and armour of every material.
const TOOL_MATERIALS: Record<string, string> = {
  wooden: "#planks",
  stone: "#stone",
  iron: "iron_ingot",
  golden: "gold_ingot",
  diamond: "diamond",
};
for (const [prefix, material] of Object.entries(TOOL_MATERIALS)) {
  RECIPES[`${prefix}_pickaxe`] = recipe(1, [[material, 3], ["stick", 2]]);
  RECIPES[`${prefix}_axe`] = recipe(1, [[material, 3], ["stick", 2]]);
  RECIPES[`${prefix}_shovel`] = recipe(1, [[material, 1], ["stick", 2]]);
  RECIPES[`${prefix}_hoe`] = recipe(1, [[material, 2], ["stick", 2]]);
  RECIPES[`${prefix}_sword`] = recipe(1, [[material, 2], ["stick", 1]]);
}
for (const [prefix, material] of [["iron", "iron_ingot"], ["golden", "gold_ingot"], ["diamond", "diamond"]] as const) {
  RECIPES[`${prefix}_helmet`] = recipe(1, [[material, 5]]);
  RECIPES[`${prefix}_chestplate`] = recipe(1, [[material, 8]]);
  RECIPES[`${prefix}_leggings`] = recipe(1, [[material, 7]]);
  RECIPES[`${prefix}_boots`] = recipe(1, [[material, 4]]);
}

/** Furnace output → input. */
const SMELTING: Record<string, string> = {
  iron_ingot: "raw_iron",
  gold_ingot: "raw_gold",
  copper_ingot: "raw_copper",
  charcoal: "#logs",
  glass: "sand",
  stone: "cobblestone",
  smooth_stone: "stone",
  cooked_beef: "beef",
  cooked_porkchop: "porkchop",
  cooked_mutton: "mutton",
  cooked_chicken: "chicken",
  cooked_rabbit: "rabbit",
  cooked_cod: "cod",
  cooked_salmon: "salmon",
  baked_potato: "potato",
  dried_kelp: "kelp",
};

/** Items she gets by killing animals → the animals that drop them. */
const HUNTED: Record<string, string[]> = {
  beef: ["cow", "mooshroom"],
  porkchop: ["pig"],
  mutton: ["sheep"],
  chicken: ["chicken"],
  rabbit: ["rabbit"],
  cod: ["cod"],
  salmon: ["salmon"],
  leather: ["cow", "mooshroom"],
  feather: ["chicken"],
  "#meat": ["cow", "pig", "sheep", "chicken", "rabbit", "mooshroom"],
};

/** The meat each animal she hunts drops (what `hunt {entity}` is for). */
export const ANIMAL_DROP: Record<string, string> = {
  cow: "beef",
  mooshroom: "beef",
  pig: "porkchop",
  sheep: "mutton",
  chicken: "chicken",
  rabbit: "rabbit",
  cod: "cod",
  salmon: "salmon",
};

/** Crops a farm harvests (Baritone `farm`: ripe ones only, replanted) → their blocks. */
const GATHERED: Record<string, string[]> = {
  wheat: ["wheat"],
  carrot: ["carrots"],
  potato: ["potatoes"],
  beetroot: ["beetroots"],
};

/** Items mined from blocks (Baritone counts the drops of these blocks in the inventory). */
const MINED: Record<string, string[]> = {
  "#logs": WOODS.map((w) => `${w}_log`),
  "#stone": ["stone", "cobblestone", "deepslate", "cobbled_deepslate"],
  cobblestone: ["stone", "cobblestone"],
  cobbled_deepslate: ["deepslate", "cobbled_deepslate"],
  "#coal": ["coal_ore", "deepslate_coal_ore"],
  coal: ["coal_ore", "deepslate_coal_ore"],
  raw_iron: ["iron_ore", "deepslate_iron_ore"],
  raw_copper: ["copper_ore", "deepslate_copper_ore"],
  raw_gold: ["gold_ore", "deepslate_gold_ore"],
  diamond: ["diamond_ore", "deepslate_diamond_ore"],
  redstone: ["redstone_ore", "deepslate_redstone_ore"],
  lapis_lazuli: ["lapis_ore", "deepslate_lapis_ore"],
  emerald: ["emerald_ore", "deepslate_emerald_ore"],
  dirt: ["dirt", "grass_block"],
  sand: ["sand"],
  red_sand: ["red_sand"],
  gravel: ["gravel"],
  // Gravel drops flint now and then; the runner mines again until there is enough.
  flint: ["gravel"],
  clay_ball: ["clay"],
  obsidian: ["obsidian"],
  melon_slice: ["melon"],
};

/** The pickaxe that reaches each tier. */
const TIER_PICKAXE: Record<Exclude<Tier, 0>, string> = {
  1: "wooden_pickaxe",
  2: "stone_pickaxe",
  3: "iron_pickaxe",
  4: "diamond_pickaxe",
};

/**
 * Fuels and how many items each smelts, in the order the mod picks them. Logs are not burnt
 * as they are: as planks the same log smelts four times as much.
 */
const FUELS: Array<[string, number]> = [
  ["#coal", 8],
  ["coal_block", 80],
  ["#planks", 1.5],
];

export type Step =
  | { kind: "mine"; item: string; blocks: string[]; count: number }
  | { kind: "craft"; item: string; count: number; table: boolean }
  | { kind: "smelt"; item: string; input: string; count: number }
  | { kind: "place"; item: "crafting_table" | "furnace" }
  /** Kill one of `entities` after another until `count` more of `item` dropped. */
  | { kind: "hunt"; item: string; entities: string[]; count: number }
  /** Harvest ripe `crops` (and replant) until `count` more of `item`. */
  | { kind: "gather"; item: string; crops: string[]; count: number };

/** What she can use where she stands (from `observe`'s visible blocks and creatures). */
export interface World {
  table?: boolean;
  furnace?: boolean;
  /** Animals in sight (entity types). */
  animals?: string[];
  /** Crop blocks in sight. */
  crops?: string[];
}

/** The target cannot be planned (unknown item, a loop); the message goes back to her. */
export class PlanError extends Error {}

const MAX_DEPTH = 16;
const MAX_STEPS = 60;

/** Normalizes a requested item (`"Iron Pickaxe"`, `"minecraft:iron_pickaxe"`, `"planks"`). */
export function normalizeItem(raw: string): string {
  const id = raw.trim().toLowerCase().replace(/^minecraft:/, "").replace(/\s+/g, "_");
  if (id === "planks" || id === "wood_planks") return "#planks";
  if (id === "log" || id === "logs" || id === "wood") return "#logs";
  if (id === "food" || id === "食物") return "#food";
  if (id === "meat" || id === "raw_meat") return "#meat";
  return id;
}

/** Whether the planner knows how to get `item` at all. */
export function knows(item: string): boolean {
  if (item in RECIPES || item in SMELTING || item in MINED) return true;
  if (item in HUNTED || item in GATHERED || item === "#food") return true;
  return item.endsWith("_planks") && planksOf(item) !== undefined;
}

/** The food the world around her offers most cheaply (what `obtain food` goes for). */
function foodChoice(inv: Inventory, world: World): string {
  const cook = world.furnace === true || (inv.furnace ?? 0) > 0;
  const animal = world.animals?.find((a) => a in ANIMAL_DROP);
  if (animal !== undefined) {
    const raw = ANIMAL_DROP[animal] as string;
    const cooked = Object.keys(SMELTING).find((out) => SMELTING[out] === raw);
    return cook && cooked !== undefined ? cooked : raw;
  }
  if (world.crops?.includes("wheat")) return "bread";
  if (world.crops?.includes("carrots")) return "carrot";
  if (world.crops?.includes("potatoes")) return cook ? "baked_potato" : "potato";
  // Nothing in sight: go hunting (the runner explores until an animal shows up).
  return "#meat";
}

/** Drops of monsters she has to fight or trade for; the planner cannot plan them. */
const MOB_DROPS: Record<string, string> = {
  blaze_rod: "要到下界要塞打烈焰人",
  ender_pearl: "要打終界使者,或在下界用金錠跟豬布林交易",
  string: "要打蜘蛛,或破壞蜘蛛網",
};

/** Why `item` cannot be planned, and what she can do instead. */
export function unknownText(item: string): string {
  const mob = MOB_DROPS[item];
  if (mob) return `${itemName(item)}沒辦法自己做出來,${mob}`;
  return `不知道怎麼取得${itemName(item)}(只會砍樹、挖礦、合成、用熔爐燒、打獵和收成)。要吃的用 obtain {item:"food"},或 cooked_beef、cooked_porkchop、bread 這類`;
}

class Planner {
  readonly steps: Step[] = [];
  readonly #inv: Inventory;
  readonly #world: World;
  /** Pass 1 totals per produced item; pass 2 makes the whole amount the first time it is needed. */
  readonly #batch: Map<string, number>;
  readonly #made = new Map<string, number>();

  constructor(inv: Inventory, world: World, batch: Map<string, number>) {
    this.#inv = { ...inv };
    this.#world = { ...world };
    this.#batch = batch;
  }

  /** Produced amount per step key (for the next pass). */
  totals(): Map<string, number> {
    const out = new Map<string, number>();
    for (const s of this.steps) {
      if (s.kind === "place") continue;
      out.set(s.item, (out.get(s.item) ?? 0) + s.count);
    }
    return out;
  }

  #take(item: string, n: number): number {
    let left = n;
    for (const key of isGroup(item) ? [item, ...members(item)] : [item]) {
      const have = this.#inv[key] ?? 0;
      const used = Math.min(have, left);
      if (used > 0) {
        this.#inv[key] = have - used;
        left -= used;
      }
      if (left === 0) break;
    }
    return n - left;
  }

  #add(item: string, n: number): void {
    this.#inv[item] = (this.#inv[item] ?? 0) + n;
  }

  /** Makes sure `n` of `item` exist, then uses them up (`consume`) or keeps them (tools). */
  need(item: string, n: number, consume: boolean, depth: number): void {
    if (depth > MAX_DEPTH || this.steps.length > MAX_STEPS) {
      throw new PlanError(`${zh(item)}的步驟太多了,先自己做一部分`);
    }
    const have = countOf(this.#inv, item);
    if (have < n) this.#produce(item, n - have, depth + 1);
    if (consume) this.#take(item, n);
  }

  #tool(tier: Tier, depth: number): void {
    if (tier === 0 || pickaxeTier(this.#inv) >= tier) return;
    this.need(TIER_PICKAXE[tier as Exclude<Tier, 0>], 1, false, depth);
  }

  #station(kind: "crafting_table" | "furnace", depth: number): void {
    const key = kind === "crafting_table" ? "table" : "furnace";
    if (this.#world[key]) return;
    this.need(kind, 1, true, depth);
    this.steps.push({ kind: "place", item: kind });
    this.#world[key] = true;
  }

  #fuel(items: number, depth: number): void {
    let left = items;
    for (const [fuel, burns] of FUELS) {
      if (left <= 0) return;
      const units = Math.min(countOf(this.#inv, fuel), Math.ceil(left / burns));
      this.#take(fuel, units);
      left -= units * burns;
    }
    if (left > 0) this.need("#planks", Math.ceil(left / 1.5), true, depth);
  }

  /** How many to make: the missing amount, or the whole batch the first time. */
  #amount(item: string, missing: number): number {
    const batch = this.#batch.get(item) ?? 0;
    const made = this.#made.get(item) ?? 0;
    const amount = Math.max(missing, batch - made);
    this.#made.set(item, made + amount);
    return amount;
  }

  #produce(item: string, missing: number, depth: number): void {
    if (item === "#food") {
      this.#produce(foodChoice(this.#inv, this.#world), missing, depth);
      return;
    }
    // `oak_planks` asked for by name: any planks recipe, crafted as that wood when logs allow.
    const key = item.endsWith("_planks") && planksOf(item) ? "#planks" : item;
    const r = RECIPES[key];
    if (r) {
      if (r.table) this.#station("crafting_table", depth);
      const times = Math.ceil(this.#amount(key, missing) / r.yield);
      for (const [ing, qty] of r.needs) this.need(ing, qty * times, true, depth);
      this.steps.push({ kind: "craft", item, count: times * r.yield, table: r.table });
      this.#add(item, times * r.yield);
      return;
    }
    const input = SMELTING[item];
    if (input) {
      const amount = this.#amount(item, missing);
      this.#station("furnace", depth);
      this.need(input, amount, true, depth);
      this.#fuel(amount, depth);
      this.steps.push({ kind: "smelt", item, input, count: amount });
      this.#add(item, amount);
      return;
    }
    const blocks = MINED[item];
    if (blocks) {
      const amount = this.#amount(item, missing);
      this.#tool(Math.max(...blocks.map(requiredTier)) as Tier, depth);
      this.steps.push({ kind: "mine", item, blocks, count: amount });
      this.#add(item, amount);
      return;
    }
    const animals = HUNTED[item];
    if (animals) {
      const amount = this.#amount(item, missing);
      this.steps.push({ kind: "hunt", item, entities: animals, count: amount });
      this.#add(item, amount);
      return;
    }
    const crops = GATHERED[item];
    if (crops) {
      const amount = this.#amount(item, missing);
      this.steps.push({ kind: "gather", item, crops, count: amount });
      this.#add(item, amount);
      return;
    }
    throw new PlanError(unknownText(item));
  }
}

/**
 * The steps from `inv` to `count` of `target`; empty when she already has them. Throws
 * `PlanError`.
 */
export function plan(target: string, count: number, inv: Inventory, world: World = {}): Step[] {
  const item = normalizeItem(target);
  if (countOf(inv, item) >= count) return [];
  const first = new Planner(inv, world, new Map());
  first.need(item, count, false, 0);
  const second = new Planner(inv, world, first.totals());
  second.need(item, count, false, 0);
  return second.steps;
}

const GROUP_NAMES: Record<string, string> = {
  "#logs": "原木",
  "#planks": "木材",
  "#stone": "鵝卵石",
  "#coal": "煤炭",
  "#meat": "生肉",
  "#food": "食物",
};

/** Display name of an item or group. */
export function itemName(item: string): string {
  return GROUP_NAMES[item] ?? zh(item);
}

/** `做工作台`-style text of one step. */
export function describeStep(step: Step): string {
  const name = itemName;
  switch (step.kind) {
    case "mine":
      return `${step.item === "#logs" ? "砍" : "挖"}${name(step.item)}×${step.count}`;
    case "craft":
      return `做${name(step.item)}×${step.count}`;
    case "smelt":
      return `用熔爐燒${name(step.item)}×${step.count}`;
    case "place":
      return `放下${zh(step.item)}`;
    case "hunt":
      return `打${step.entities.slice(0, 3).map(zh).join("、")}拿${name(step.item)}×${step.count}`;
    case "gather":
      return `收成${name(step.item)}×${step.count}`;
  }
}
