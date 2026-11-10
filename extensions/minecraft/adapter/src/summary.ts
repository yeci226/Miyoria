// Turns the mod's `observe` snapshot into a short Traditional Chinese summary
// for the model plus a compact structured state (ids kept for actions).

import { pickaxeTier, toolLine } from "./harvest.js";
import { zh } from "./names.js";

interface Pos {
  x: number;
  y: number;
  z: number;
}

interface Stack {
  item: string;
  count: number;
  durability_pct?: number;
  slot?: number;
}

interface LookingAt {
  kind: "block" | "entity" | "none";
  block?: string;
  entity?: string;
  name?: string;
  position?: Pos;
  distance?: number;
}

interface Entity {
  type: string;
  name?: string;
  distance: number;
  hostile: boolean;
  /** Where it stands, when the mod says (a newer mod; hunting aims at it). */
  position?: Pos;
}

interface NotableBlock {
  block: string;
  count: number;
  nearest?: Pos;
  distance?: number;
}

/** The `observe` snapshot (PROTOCOL.md §4); every field is optional here. */
export interface Snapshot {
  health?: number;
  max_health?: number;
  food?: number;
  air?: number;
  position?: Pos;
  block_position?: Pos;
  dimension?: string;
  biome?: string;
  time_of_day?: number;
  time_phase?: string;
  is_night?: boolean;
  weather?: string;
  held_item?: Stack | null;
  inventory?: Record<string, number>;
  inventory_free_slots?: number;
  armor?: Record<string, Stack | null>;
  looking_at?: LookingAt;
  nearby_entities?: Entity[];
  nearby_entities_total?: number;
  hostile_count?: number;
  nearby_blocks?: NotableBlock[];
  baritone?: { available?: boolean; busy?: boolean; process?: string | null; goal?: string | null };
  altoclef?: { available?: boolean; busy?: boolean | null };
  /** A craft / smelt job of the mod's workbench. */
  crafting?: { kind: string; item: string | null } | null;
  /** The reflex the mod is running (`lava`, `fight`, ...), `null` when none. */
  reflex?: { active: string | null } | null;
}

const REFLEX_ACTIVE: Record<string, string> = {
  lava: "逃離岩漿",
  suffocation: "從方塊裡挖出來",
  falling_block: "閃開落下的方塊",
  drowning: "往上游換氣",
  flee: "逃跑",
  fight: "反擊",
  eat: "吃東西",
  unstuck: "掙脫卡住",
  pickup: "撿東西",
};

const MAX_INVENTORY = 16;
const MAX_ENTITIES = 6;
const MAX_BLOCKS = 6;

const PHASES: Record<string, string> = { day: "白天", dusk: "黃昏", night: "晚上", dawn: "清晨" };
const WEATHER: Record<string, string> = { clear: "晴天", rain: "下雨", thunder: "雷雨" };

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Things she can eat, to tell "has food" from "starving with an inventory full of stone". */
const FOOD = new Set([
  "apple",
  "bread",
  "carrot",
  "potato",
  "baked_potato",
  "beetroot",
  "sweet_berries",
  "glow_berries",
  "melon_slice",
  "cookie",
  "pumpkin_pie",
  "mushroom_stew",
  "dried_kelp",
  "golden_carrot",
  "golden_apple",
  "beef",
  "porkchop",
  "chicken",
  "mutton",
  "rabbit",
  "cod",
  "salmon",
]);
const isFood = (id: string) => FOOD.has(id) || id.startsWith("cooked_");

/** "約 3 分鐘後天黑" style hint from the time of day (20 ticks = 1 s; a day is 24000 ticks). */
function untilNext(phase: string | undefined, time: number | undefined): string {
  if (time === undefined) return "";
  const t = ((time % 24000) + 24000) % 24000;
  const mins = (ticks: number) => Math.max(1, Math.round(ticks / 1200));
  if (phase === "day") return `(約 ${mins(12000 - t)} 分鐘後天黑)`;
  if (phase === "dusk") return "(快天黑了)";
  if (phase === "night") return `(約 ${mins(23000 - t)} 分鐘後天亮)`;
  return "";
}

function stack(s: Stack): string {
  const count = s.count > 1 ? `×${s.count}` : "";
  const durability = s.durability_pct === undefined ? "" : `(耐久 ${s.durability_pct}%)`;
  return `${zh(s.item)}${count}${durability}`;
}

function pos(p: Pos): string {
  return `(${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)})`;
}

/** Whether Baritone or AltoClef is working on something (or a reflex has her body). */
export function isBusy(s: Snapshot): boolean {
  return s.baritone?.busy === true || s.altoclef?.busy === true || !!s.crafting || !!s.reflex?.active;
}

/** Summary lines in Traditional Chinese. */
export function summarize(s: Snapshot): string {
  const lines: string[] = [];
  if (s.health !== undefined) {
    const max = s.max_health ?? 20;
    const vitals = [`血量 ${round1(s.health)}/${max}`];
    if (s.food !== undefined) vitals.push(`飢餓 ${s.food}/20${s.food <= 6 ? "(餓了,先吃東西)" : ""}`);
    if (s.air !== undefined && s.air < 300) vitals.push(`氧氣 ${Math.max(0, Math.round(s.air / 30))}/10`);
    lines.push(vitals.join("、"));
  }
  const where: string[] = [];
  const p = s.block_position ?? s.position;
  if (p) where.push(`位置 ${pos(p)}`);
  if (s.dimension) where.push(zh(s.dimension));
  if (s.biome) where.push(zh(s.biome));
  if (where.length) lines.push(where.join("・"));
  const time: string[] = [];
  if (s.time_phase) time.push(`${PHASES[s.time_phase] ?? s.time_phase}${untilNext(s.time_phase, s.time_of_day)}`);
  if (s.weather) time.push(WEATHER[s.weather] ?? s.weather);
  if (time.length) lines.push(time.join("、"));

  lines.push(`手上:${s.held_item ? stack(s.held_item) : "空手"}`);
  const armor = Object.values(s.armor ?? {}).filter((a): a is Stack => !!a);
  if (armor.length) lines.push(`裝備:${armor.map(stack).join("、")}`);
  const inventory = Object.entries(s.inventory ?? {}).sort((a, b) => b[1] - a[1]);
  if (inventory.length) {
    const shown = inventory.slice(0, MAX_INVENTORY).map(([id, n]) => `${zh(id)}×${n}`);
    const more = inventory.length > MAX_INVENTORY ? `…等 ${inventory.length} 種` : "";
    const free = s.inventory_free_slots === undefined ? "" : `(空格 ${s.inventory_free_slots})`;
    lines.push(`背包:${shown.join("、")}${more}${free}`);
  } else if (s.inventory) {
    lines.push("背包:空的");
  }
  if (s.inventory) {
    lines.push(toolLine(s.inventory));
    const food = inventory.filter(([id]) => isFood(id)).map(([id, n]) => `${zh(id)}×${n}`);
    lines.push(`食物:${food.length ? food.join("、") : "沒有"}`);
  }

  const look = s.looking_at;
  if (look && look.kind !== "none") {
    const what = look.kind === "block" ? zh(look.block) : (look.name ?? zh(look.entity));
    const dist = look.distance === undefined ? "" : `(${round1(look.distance)} 格)`;
    lines.push(`看著:${what}${dist}`);
  }

  const entities = s.nearby_entities ?? [];
  if (entities.length) {
    const shown = entities.slice(0, MAX_ENTITIES).map((e) => {
      const name = e.type === "player" && e.name ? `玩家 ${e.name}` : (e.name ?? zh(e.type));
      return `${name} ${Math.round(e.distance)} 格${e.hostile ? "(敵對)" : ""}`;
    });
    const total = s.nearby_entities_total ?? entities.length;
    const more = total > shown.length ? `…共 ${total} 隻` : "";
    lines.push(`附近:${shown.join("、")}${more}`);
  }
  if (s.hostile_count) lines.push(`⚠ 附近有 ${s.hostile_count} 隻敵對生物`);

  const blocks = s.nearby_blocks ?? [];
  if (blocks.length) {
    const shown = blocks.slice(0, MAX_BLOCKS).map((b) => {
      const dist = b.distance === undefined ? "" : ` ${Math.round(b.distance)} 格`;
      return `${zh(b.block)}×${b.count}${dist}`;
    });
    lines.push(`看得到的方塊:${shown.join("、")}`);
  } else if (s.nearby_blocks) {
    lines.push("看得到的方塊:沒有特別的");
  }

  const activity: string[] = [];
  if (s.baritone?.available === false) activity.push("沒有 Baritone");
  else if (s.baritone?.busy) activity.push(`Baritone 執行中(${s.baritone.process ?? "?"})`);
  else if (s.baritone) activity.push("Baritone 閒置");
  if (s.altoclef?.busy) activity.push("AltoClef 任務進行中");
  if (s.crafting) {
    activity.push(s.crafting.kind === "craft" ? `正在合成 ${zh(s.crafting.item)}` : "正在用熔爐");
  }
  const reflex = s.reflex?.active;
  if (reflex) activity.push(`本能反應中:${REFLEX_ACTIVE[reflex] ?? reflex}`);
  if (activity.length) lines.push(activity.join("、"));
  return lines.join("\n");
}

/** Compact structured state: ids kept, noise (hotbar, yaw, ...) dropped. */
export function compactState(s: Snapshot): Record<string, unknown> {
  const p = s.block_position ?? s.position;
  const state: Record<string, unknown> = {
    connected: true,
    in_game: true,
    busy: isBusy(s),
    health: s.health === undefined ? undefined : round1(s.health),
    food: s.food,
    position: p ? { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) } : undefined,
    dimension: s.dimension,
    biome: s.biome,
    time: s.time_phase,
    weather: s.weather,
    held: s.held_item?.item ?? null,
    pickaxe_tier: s.inventory ? pickaxeTier(s.inventory) : undefined,
    // All of it (at most 36 kinds): a goal's success condition is read from here, and the one
    // loaf of bread must not fall off the end of a list of stone.
    inventory: Object.fromEntries(Object.entries(s.inventory ?? {}).sort((a, b) => b[1] - a[1])),
    free_slots: s.inventory_free_slots,
    entities: (s.nearby_entities ?? []).slice(0, MAX_ENTITIES * 2).map((e) => ({
      type: e.type,
      ...(e.name ? { name: e.name } : {}),
      d: Math.round(e.distance),
      ...(e.hostile ? { hostile: true } : {}),
    })),
    blocks: (s.nearby_blocks ?? []).slice(0, MAX_BLOCKS * 2).map((b) => ({
      block: b.block,
      count: b.count,
      ...(b.nearest ? { at: b.nearest } : {}),
    })),
    baritone: s.baritone ? { busy: s.baritone.busy ?? false, process: s.baritone.process ?? null } : undefined,
    altoclef: s.altoclef?.available ? { busy: s.altoclef.busy ?? null } : undefined,
    crafting: s.crafting ?? undefined,
    reflex: s.reflex?.active ?? undefined,
  };
  for (const key of Object.keys(state)) if (state[key] === undefined) delete state[key];
  return state;
}
