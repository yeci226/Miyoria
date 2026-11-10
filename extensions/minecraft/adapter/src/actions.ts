// The goals offered to the model (the executor's goals, docs/design/v2-architecture.md §3.8)
// and how one action maps onto the mod's requests (PROTOCOL.md §5). A request only *starts*
// work; the executor (`adapter.ts`) turns it into a task and reports its end with a code.
//
// Getting an item has one entry, `obtain` (strategies `plan`, `altoclef`, `craft`, see
// `adapter.ts`); the old `get`, `craft` and `smelt` goals are still accepted (`HIDDEN_ACTIONS`)
// but no longer offered, so the model does not choose between three overlapping paths.

import type { GameAction, GameActionSpec, JsonSchema, TaskFailureCode } from "@miyoria/sdk";
import { harvestProblem } from "./harvest.js";
import { zh } from "./names.js";

const int = (description: string): JsonSchema => ({ type: "integer", description });
const str = (description: string): JsonSchema => ({ type: "string", description });
const obj = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({
  type: "object",
  properties,
  required,
});
const xyz = obj({ x: int("x"), y: int("y"), z: int("z") }, ["x", "y", "z"]);

export const ACTIONS: GameActionSpec[] = [
  {
    name: "goto",
    description: "用 Baritone 走到座標({x,y,z} 或只給 {x,z}),或走到最近一個你看得到的某種方塊旁({block},不會透視)",
    parameters: obj({
      x: int("x"),
      y: int("y(可省略)"),
      z: int("z"),
      block: str("方塊 id,例如 crafting_table"),
      near: int("走到離座標幾格內就好"),
    }),
    budget_s: 120,
  },
  {
    name: "mine",
    description:
      "用 Baritone 挖你看得到的某些方塊(不會透視,挖著挖著看到新的會繼續);要有對的鎬:石頭要木鎬、鐵礦要石鎬、鑽石要鐵鎬;count 省略 = 挖到 stop 或看得到的都挖完",
    parameters: obj({
      blocks: { type: "array", items: { type: "string" }, description: "方塊 id,例如 [\"iron_ore\",\"deepslate_iron_ore\"]" },
      block: str("單一方塊 id"),
      count: int("要幾個"),
    }),
    budget_s: 300,
  },
  {
    name: "follow",
    description: "跟著某個玩家({player})或某種生物({entity})走",
    parameters: obj({ player: str("玩家名稱"), entity: str("生物 id") }),
    budget_s: 120,
  },
  {
    name: "explore",
    description:
      "以某點(預設目前位置)為中心探索沒去過的地方;給 find 就找到那個方塊或生物時停下。看到新東西才算有進展,只是跑滿時間不算",
    parameters: obj({
      x: int("x"),
      z: int("z"),
      find: { type: "array", items: { type: "string" }, description: "要找的方塊或生物 id,例如 [\"oak_log\",\"cow\"]" },
    }),
    budget_s: 120,
  },
  {
    name: "farm",
    description: "自動收割並重新種植附近的作物",
    parameters: obj({ range: int("範圍(格),0 = 預設") }),
    budget_s: 180,
  },
  {
    name: "build",
    description: "用 Baritone 照藍圖蓋建築(baritone/schematics 裡的檔名)",
    parameters: obj({ schematic: str("藍圖檔名"), x: int("x"), y: int("y"), z: int("z") }, ["schematic"]),
    budget_s: 900,
  },
  {
    name: "obtain",
    description:
      "取得一個物品(工具、材料、方塊、食物都是),只說目標就好(例如 {item:\"iron_pickaxe\"}):程式依配方和工具等級往回推出步驟(砍樹 → 木材 → 工作台 → 木鎬 → 石頭 → 石鎬 → 熔爐 → 鐵…),一步一步挖、合成、燒、放,邊做邊回報,做完或卡住會說原因;只會挖看得到的方塊。食物也行:cooked_beef 會自己打牛再烤、bread 會收小麥再做,{item:\"food\"} 挑附近最容易的吃的。count 是背包裡總共要有幾個。不會的東西有 AltoClef 時交給它",
    parameters: obj(
      {
        item: str("物品 id,例如 oak_planks、crafting_table、iron_pickaxe、torch、furnace"),
        count: int("數量,預設 1"),
      },
      ["item"],
    ),
    budget_s: 600,
  },
  {
    name: "hunt",
    description:
      "打獵:追著某種動物打({entity},例如 cow、pig、chicken、sheep、rabbit),直到多掉了 count 個肉(預設 1);附近沒有會先探索。要熟食用 obtain cooked_beef 這類",
    parameters: obj({ entity: str("動物 id,例如 cow"), count: int("要多拿幾個肉,預設 1") }, ["entity"]),
    budget_s: 180,
  },
  {
    name: "shelter",
    description: "躲起來過夜:有床就放下來睡,沒有就往下挖三格、用方塊封頂,等到天亮(天黑時系統會自己做,通常不用呼叫)",
    parameters: obj({}),
    budget_s: 540,
  },
  {
    name: "recover",
    description: "回到上次死掉的地方撿掉的東西(東西約 5 分鐘後消失;死後系統會自己做,通常不用呼叫)",
    parameters: obj({}),
    budget_s: 180,
  },
  {
    name: "place",
    description: "把背包裡的一個方塊放在腳邊的地上(例如工作台、熔爐)",
    parameters: obj({ item: str("方塊 id,例如 crafting_table") }, ["item"]),
    budget_s: 20,
  },
  {
    name: "chat",
    description: "在遊戲聊天室說一句話",
    parameters: obj({ message: str("要說的話(256 字以內)") }, ["message"]),
    budget_s: 10,
  },
  { name: "stop", description: "停下所有動作(Baritone、AltoClef、按住的按鍵)", parameters: obj({}), budget_s: 10 },
  {
    name: "look",
    description: "轉頭:{yaw,pitch}(度)或看向座標 {at:{x,y,z}}",
    parameters: obj({ yaw: { type: "number" }, pitch: { type: "number" }, at: xyz }),
    budget_s: 10,
  },
  {
    name: "attack",
    description: "左鍵(攻擊 / 挖準心指到的東西);hold_ticks 按住多久(20 = 1 秒)",
    parameters: obj({ hold_ticks: int("1–1200") }),
    budget_s: 75,
  },
  {
    name: "use",
    description: "右鍵(吃東西、放方塊、開門…);吃東西約 hold_ticks 32",
    parameters: obj({ hold_ticks: int("1–1200") }),
    budget_s: 75,
  },
  { name: "select", description: "切換快捷列:{slot:0-8} 或 {item}", parameters: obj({ slot: int("0–8"), item: str("物品 id") }), budget_s: 10 },
  { name: "respawn", description: "死掉時按重生", parameters: obj({}), budget_s: 15 },
  {
    name: "launch",
    description: "開遊戲(用 Prism Launcher;開始玩的時候系統會自己做,不用呼叫)",
    parameters: obj({}),
    budget_s: 240,
  },
  { name: "quit", description: "關遊戲(結束玩的時候系統會自己做,不用呼叫)", parameters: obj({}), budget_s: 15 },
];

/**
 * Goals still accepted but not offered to the model: `get` = `obtain` with strategy `altoclef`;
 * `craft` / `smelt` = one craft / one furnace load (the `craft` strategy, and the planner's own
 * steps), kept for old prompts and viewers' wording.
 */
export const HIDDEN_ACTIONS: GameActionSpec[] = [
  {
    name: "get",
    description:
      "用 AltoClef 取得物品(自動砍樹、挖礦、合成…),例如 {item:\"iron_pickaxe\"};狀態的 capabilities.altoclef 為 true 才能用,不然用 craft / smelt 自己做",
    parameters: obj({ item: str("物品 id"), count: int("數量,預設 1") }, ["item"]),
    budget_s: 600,
  },
  {
    name: "craft",
    description:
      "合成物品:小配方用背包的 2x2 格,3x3 配方(鎬、劍、熔爐…)要站在工作台旁;例如 {item:\"oak_planks\",count:4}。材料不夠會說缺什麼",
    parameters: obj({ item: str("要做的物品 id"), count: int("要幾個(成品數,預設 1)") }, ["item"]),
    budget_s: 60,
  },
  {
    name: "smelt",
    description:
      "用旁邊的熔爐燒東西:把 item 和燃料放進去(會自動挑煤炭 / 木材),燒好(每個約 10 秒)要再 smelt 一次拿出來;不給 item = 只拿出燒好的",
    parameters: obj({ item: str("要燒的物品 id,例如 raw_iron"), count: int("幾個(預設全部)"), fuel: str("燃料 id(可省略)") }),
    budget_s: 60,
  },
];

/** One request to send to the mod (`type` plus parameters). */
export interface BridgeRequest {
  type: string;
  params: Record<string, unknown>;
}

export interface MapOptions {
  allowCommands?: boolean;
  /** Her inventory (`item id → count`) when known; `mine` refuses blocks her pickaxe cannot harvest. */
  inventory?: Record<string, number>;
}

/** Thrown for arguments the model got wrong; the message goes back to it. */
export class ActionError extends Error {}

const num = (v: unknown): number | undefined => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
};
const text = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
const id = (v: unknown): string | undefined => text(v)?.toLowerCase().replace(/\s+/g, "_");

function baritone(command: string, params: Record<string, unknown> = {}): BridgeRequest {
  return { type: "baritone", params: { command, ...params } };
}

function hold(args: Record<string, unknown>): Record<string, unknown> {
  const ticks = num(args.hold_ticks);
  if (ticks === undefined) return {};
  return { hold_ticks: Math.min(1200, Math.max(1, Math.round(ticks))) };
}

/** Maps an action onto mod requests; throws `ActionError` for bad arguments. */
export function toRequests(action: GameAction, opts: MapOptions = {}): BridgeRequest[] {
  const a = action.args ?? {};
  switch (action.name) {
    case "goto": {
      const x = num(a.x);
      const y = num(a.y);
      const z = num(a.z);
      const near = num(a.near);
      if (x !== undefined && z !== undefined) {
        return [baritone("goto", { x: Math.round(x), ...(y === undefined ? {} : { y: Math.round(y) }), z: Math.round(z), ...(near === undefined ? {} : { near }) })];
      }
      const block = id(a.block);
      if (block) return [baritone("goto", { block })];
      throw new ActionError("goto 要給 {x,z}、{x,y,z} 或 {block}");
    }
    case "mine": {
      const list = Array.isArray(a.blocks) ? a.blocks.map(id).filter((b): b is string => !!b) : [];
      const single = id(a.block);
      if (single) list.push(single);
      if (!list.length) throw new ActionError("mine 要給 blocks(方塊 id 陣列)或 block");
      if (opts.inventory) {
        for (const block of list) {
          const problem = harvestProblem(block, opts.inventory);
          if (problem) throw new ActionError(problem);
        }
      }
      const count = num(a.count);
      return [baritone("mine", { blocks: [...new Set(list)], ...(count ? { count: Math.max(0, Math.round(count)) } : {}) })];
    }
    case "follow": {
      const player = text(a.player);
      if (player) return [baritone("follow", { player })];
      const entity = id(a.entity);
      if (entity) return [baritone("follow", { entity })];
      throw new ActionError("follow 要給 player 或 entity");
    }
    case "explore": {
      // `find` is the adapter's business (it watches what she sees), not the mod's.
      const x = num(a.x);
      const z = num(a.z);
      return [baritone("explore", x !== undefined && z !== undefined ? { x: Math.round(x), z: Math.round(z) } : {})];
    }
    case "farm": {
      const range = num(a.range);
      return [baritone("farm", range === undefined ? {} : { range: Math.max(0, Math.round(range)) })];
    }
    case "build": {
      const schematic = text(a.schematic);
      if (!schematic) throw new ActionError("build 要給 schematic(藍圖檔名)");
      const origin: Record<string, number> = {};
      for (const k of ["x", "y", "z"] as const) {
        const v = num(a[k]);
        if (v !== undefined) origin[k] = Math.round(v);
      }
      return [baritone("build", { schematic, ...(Object.keys(origin).length === 3 ? origin : {}) })];
    }
    case "get": {
      const item = id(a.item);
      if (!item || !/^[a-z0-9_:]+$/.test(item)) throw new ActionError("get 要給 item(物品 id)");
      const count = Math.max(1, Math.round(num(a.count) ?? 1));
      return [{ type: "altoclef", params: { command: `get ${item} ${count}` } }];
    }
    case "craft": {
      const item = id(a.item);
      if (!item || !/^[a-z0-9_:]+$/.test(item)) throw new ActionError("craft 要給 item(物品 id)");
      const count = Math.min(64, Math.max(1, Math.round(num(a.count) ?? 1)));
      return [{ type: "craft", params: { item, count } }];
    }
    case "smelt": {
      const params: Record<string, unknown> = {};
      const item = id(a.item);
      if (item) params.item = item;
      const count = num(a.count);
      if (item && count !== undefined) params.count = Math.min(64, Math.max(1, Math.round(count)));
      const fuel = id(a.fuel);
      if (item && fuel) params.fuel = fuel;
      return [{ type: "smelt", params }];
    }
    case "place": {
      const item = id(a.item);
      if (!item) throw new ActionError("place 要給 item(方塊 id)");
      return [{ type: "place", params: { item } }];
    }
    case "chat": {
      const message = text(a.message);
      if (!message) throw new ActionError("chat 要給 message");
      if (!opts.allowCommands && /^[/@#]/.test(message)) {
        throw new ActionError("chat 不能下指令(/、@、# 開頭)");
      }
      return [{ type: "chat", params: { message: [...message].slice(0, 256).join("") } }];
    }
    case "stop":
      return [{ type: "stop", params: {} }];
    case "look": {
      const at = a.at as Record<string, unknown> | undefined;
      if (at && typeof at === "object") {
        const [x, y, z] = [num(at.x), num(at.y), num(at.z)];
        if (x === undefined || y === undefined || z === undefined) throw new ActionError("look.at 要有 x,y,z");
        return [{ type: "look", params: { at: { x, y, z } } }];
      }
      const yaw = num(a.yaw);
      const pitch = num(a.pitch);
      if (yaw === undefined && pitch === undefined) throw new ActionError("look 要給 yaw / pitch 或 at");
      return [
        {
          type: "look",
          params: {
            ...(yaw === undefined ? {} : { yaw }),
            ...(pitch === undefined ? {} : { pitch: Math.min(90, Math.max(-90, pitch)) }),
          },
        },
      ];
    }
    case "attack":
      return [{ type: "attack", params: hold(a) }];
    case "use":
      return [{ type: "use", params: hold(a) }];
    case "select": {
      const slot = num(a.slot);
      if (slot !== undefined) {
        if (slot < 0 || slot > 8) throw new ActionError("slot 要是 0–8");
        return [{ type: "select_slot", params: { slot: Math.round(slot) } }];
      }
      const item = id(a.item);
      if (item) return [{ type: "select_slot", params: { item } }];
      throw new ActionError("select 要給 slot 或 item");
    }
    case "respawn":
      return [{ type: "respawn", params: {} }];
    default:
      throw new ActionError(`沒有「${action.name}」這個動作`);
  }
}

/** Short Traditional Chinese line describing what was started. */
export function describeAction(action: GameAction): string {
  const a = action.args ?? {};
  switch (action.name) {
    case "goto":
      return a.block ? `走向 ${a.block}` : `走到 (${a.x}, ${a.y ?? "~"}, ${a.z})`;
    case "mine":
      return `開始挖 ${[...(Array.isArray(a.blocks) ? a.blocks : []), ...(a.block ? [a.block] : [])].join("、")}${a.count ? ` ×${a.count}` : ""}`;
    case "follow":
      return `跟著 ${a.player ?? a.entity}`;
    case "explore":
      return "開始探索";
    case "farm":
      return "開始種田";
    case "build":
      return `開始蓋 ${a.schematic}`;
    case "get":
      return `用 AltoClef 取得 ${a.item}${a.count ? ` ×${a.count}` : ""}`;
    case "obtain":
      return `開始取得 ${zh(String(a.item))}${a.count ? ` ×${a.count}` : ""}`;
    case "hunt":
      return `開始打${zh(String(a.entity))}`;
    case "shelter":
      return "開始找地方躲起來過夜";
    case "recover":
      return "回去撿死掉時掉的東西";
    case "craft":
      return `開始合成 ${zh(String(a.item))}${a.count ? ` ×${a.count}` : ""}`;
    case "smelt":
      return a.item ? `把 ${zh(String(a.item))} 放進熔爐` : "去熔爐拿東西";
    case "place":
      return `放下 ${zh(String(a.item))}`;
    case "chat":
      return `說了:${a.message}`;
    case "stop":
      return "停下來了";
    default:
      return `做了 ${action.name}`;
  }
}

/** `"oak_log/birch_log"` → `"橡木原木、樺木原木"`. */
const names = (ids: string): string => ids.split("/").map(zh).join("、");

/**
 * `"stick x2, oak_planks+ x3"` (the mod's `missing_items` list) → `"木棒 stick×2、橡木材 oak_planks(或同類)×3"`.
 * The id stays next to the name: she can ask for it as it is, and the director's method guard
 * reads what is missing from it, so a held recipe comes back once that is in her inventory.
 */
function missingList(list: string): string {
  return [...list.matchAll(/([a-z0-9_:]+)(\+?) x(\d+)/g)]
    .map(([, item, similar, n]) => {
      if (item === "fuel") return "燃料(煤炭、木炭、木材或原木)";
      const name = zh(item);
      return `${name}${name === item ? "" : ` ${item}`}${similar ? "(或同類)" : ""}×${n}`;
    })
    .join("、");
}

/** Mod error code (or `not_connected` / `timeout`) → the task failure code it means. */
export function failureCode(code: string): TaskFailureCode {
  switch (code) {
    case "not_visible":
      return "not_found";
    case "too_far":
      return "unreachable";
    case "missing_items":
    case "needs_station":
    case "not_in_game":
    case "game_paused":
    case "baritone_unavailable":
    case "altoclef_unavailable":
      return "precondition";
    case "busy":
    case "reflex_active":
      return "busy";
    case "not_connected":
      return "disconnected";
    case "timeout":
      return "timeout";
    case "invalid_args":
    case "unknown_type":
    case "bad_request":
      return "invalid";
    default:
      return "internal";
  }
}

/** Mod error code → message for the model. */
export function errorText(code: string, message: string): string {
  switch (code) {
    case "not_visible": {
      const what = /^no (\S+) in sight/.exec(message)?.[1];
      return `附近看不到${what ? names(what) : "那種方塊"}(只能找、挖你親眼看得到的,不會透視)。換個地方 explore,或去地表、洞穴裡找`;
    }
    case "too_far": {
      const m = /nearest (\S+) in sight is (\d+) blocks away at (-?\d+),(-?\d+),(-?\d+)/.exec(message);
      if (!m) return `太遠了:${message}`;
      const [, what, dist, x, y, z] = m;
      return `看得到的${zh(what)}在 ${dist} 格外(${x}, ${y}, ${z}),先 goto {"block":"${what}"} 走過去再做`;
    }
    case "missing_items": {
      const list = /^missing (.*?)(;|$)/.exec(message)?.[1] ?? "";
      const table = message.includes("crafting_table") ? ",而且要站在工作台旁邊做" : "";
      return `材料不夠:還缺 ${missingList(list) || list}${table}`;
    }
    case "needs_station": {
      const furnace = message.includes("furnace");
      return furnace
        ? "附近沒有看得到的熔爐:先用 8 個鵝卵石 craft furnace,再 place 放下來"
        : "這個配方要用工作台(3x3),附近沒有看得到的工作台:先 craft crafting_table,再 place 放下來";
    }
    case "busy":
      return "上一個合成 / 熔爐動作還沒做完,等它結束(或 stop)";
    case "not_connected":
      return "沒有連上 Minecraft(遊戲沒開,或 miyoria-bridge 模組沒載入)";
    case "not_in_game":
      return "還在主選單或載入中,不在遊戲世界裡";
    case "game_paused":
      return "遊戲現在是暫停的(單人遊戲的暫停選單),要等擁有者回到遊戲才能挖礦或找方塊";
    case "baritone_unavailable":
      return "沒有安裝 Baritone,不能自動走路 / 挖礦";
    case "altoclef_unavailable":
      return "沒有安裝 AltoClef(或還沒初始化),不能用 get";
    case "invalid_args":
      return `參數不對:${message}`;
    case "timeout":
      return "模組沒有回應(逾時)";
    case "reflex_active":
      return "身體正在本能反應(逃生、反擊或吃東西),等它結束再下指令";
    default:
      return `${code}:${message}`;
  }
}
