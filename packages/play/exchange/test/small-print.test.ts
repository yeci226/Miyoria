// The small print under every exchange surface (owner 2026-11-21): this walks every command, then
// every control on every reply it reaches (a few levels deep), every picture builder and the
// notice card, and fails on the first one without the base line, or a real-stock surface without
// the data-source line, or a 2× surface without the leverage line.

import {
  type Card,
  CommandRegistry,
  type CommandReply,
  type ComponentInvocationData,
  Permissions,
} from "@miyoria/commands";
import {
  type ContextKey,
  EXCHANGE_DISCLAIMER,
  EXCHANGE_DISCLAIMER_LEVERAGE,
  EXCHANGE_DISCLAIMER_REAL,
  exchangeDisclaimer,
  type PictureDataMap,
  type PictureFile,
  type PictureKind,
  type Pictures,
  type Places,
} from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { card, LEVERAGE_CONFIRM, PATHS, registerCommands } from "../src/commands.js";
import type { ExchangeConfig } from "../src/config.js";
import { discordProblems, modalProblems } from "./discord-limits.js";
import { ALICE, BOB, local, rig } from "./rig.js";

/** Identity's places as the rich list's `範圍` reads them: one server, `g`, with Alice in it. */
const places = {
  at: () => ({ space_id: "space-g", room_id: "room", parent_room_id: null, session: "s" }),
  ofGuild: () => null,
  members: () => new Set(["p-alice"]),
} as unknown as Places;

const ctx: ContextKey = { platform: "discord", scope: "g", channel: "100", kind: "channel" };

/** A renderer that draws (a file named by its index) or fails, and remembers each picture's data. */
class Drawn implements Pictures {
  readonly data: { kind: PictureKind; data: { small_print: string } }[] = [];
  constructor(private readonly draws: boolean) {}
  async render<K extends PictureKind>(
    kind: K,
    data: PictureDataMap[K],
  ): Promise<PictureFile | null> {
    this.data.push({ kind, data: data as unknown as { small_print: string } });
    if (!this.draws) return null;
    return {
      name: `pic-${this.data.length - 1}.png`,
      data: new Uint8Array([1]),
      contentType: "image/png",
      alt: kind,
      artifact_id: null,
    };
  }
  async forMember() {
    return null;
  }
}

/** The small print a message shows: its card's own text, and what its pictures end with. */
function printed(reply: CommandReply, pictures: Drawn): { card: string; drawn: string[] } {
  const blocks = (reply.card as Card | undefined)?.blocks ?? [];
  const card = blocks
    .flatMap((b) => (b.type === "text" || b.type === "muted" ? [b.text] : []))
    .join("\n");
  const drawn = blocks.flatMap((b) => {
    if (b.type !== "image") return [];
    const i = Number(/^pic-(\d+)\.png$/.exec(b.name)?.[1]);
    const d = pictures.data[i];
    return d ? [d.data.small_print] : [];
  });
  return { card: reply.card ? card : reply.text, drawn };
}

/**
 * Walks every command and every control on every reply it reaches (a few levels deep, modals
 * submitted), as `invoker`; every reply and modal is checked against Discord's limits on the way.
 */
async function walk(
  draws: boolean,
  invoker: typeof ALICE,
  name: string,
  world: World = FIRST,
): Promise<{ seen: CommandReply[]; pictures: Drawn; forms: unknown[]; specs: unknown[] }> {
  // The wallet keeps the first character's coin name: the profile's is the one source.
  const r = await rig({ open: true, ...world.config }, undefined, {
    name: () => world.exchange,
    currency: () => world.currency,
  });
  r.wallet.fund(ALICE, 500);
  r.wallet.fund(BOB, 500);
  await r.service.openAccount(ALICE);
  await r.at(local(0, 12, 30));
  await r.service.real.place(ALICE, { side: "buy", code: world.codes[0], shares: 1 }, "a");
  await r.at(local(0, 13, 1));
  // A waiting order (its cancel button), placed after the day's last tick.
  await r.at(local(0, 23, 30));
  await r.service.real.place(ALICE, { side: "buy", code: world.codes[1], shares: 1 }, "b");
  const pictures = new Drawn(draws);
  const registry = new CommandRegistry(Permissions.fromStrings(["discord:1", "discord:2"]));
  registerCommands(
    registry,
    () => r.service,
    () => pictures,
    () => world.exchange,
    () => places,
    () => world.currency,
  );
  const forms: unknown[] = [];
  const who = { ...base, invoker, invoker_display_name: name };
  const seen: CommandReply[] = [];
  const queue: { reply: CommandReply; depth: number }[] = [];
  const check = (reply: CommandReply) =>
    expect(discordProblems(reply), reply.card?.title ?? reply.text).toEqual([]);
  for (const path of PATHS) {
    const args: Record<string, string> = path.endsWith("quote") ? { code: world.codes[0] } : {};
    const reply = await registry.dispatch({ path: path.split(" "), args, ...who });
    queue.push({ reply, depth: 0 });
  }
  // The rich list's two forms, and the default of a DM (everyone's).
  for (const scope of ["這個伺服器", "全部"]) {
    const reply = await registry.dispatch({
      path: ["me", "market", "rich"],
      args: { 範圍: scope },
      ...who,
    });
    queue.push({ reply, depth: 0 });
  }
  const dm: ContextKey = { platform: "discord", scope: null, channel: "dm", kind: "dm" };
  queue.push({
    reply: await registry.dispatch({
      path: ["me", "market", "rich"],
      args: {},
      ...who,
      context: dm,
    }),
    depth: 0,
  });
  const pressed = new Set<string>();
  while (queue.length > 0) {
    const { reply, depth } = queue.shift() as { reply: CommandReply; depth: number };
    seen.push(reply);
    check(reply);
    if (depth >= 3) continue;
    for (const b of (reply.card as Card | undefined)?.blocks ?? []) {
      const controls: ComponentInvocationData[] =
        b.type === "buttons"
          ? b.buttons
              .filter((x) => !x.disabled)
              .map((x) => ({ custom_id: x.id, message_id: "m", ...who }))
          : b.type === "select"
            ? b.select.options
                // The first two of every select, every heat map and the 月線 of the chart's.
                .filter((o, i) => i < 2 || o.value.startsWith("map:") || o.value === "monthly")
                .map((o) => ({
                  custom_id: b.select.id,
                  values: [o.value],
                  message_id: "m",
                  ...who,
                }))
            : [];
      for (const c of controls) {
        const key = `${c.custom_id}|${c.values?.[0] ?? ""}`;
        if (pressed.has(key)) continue;
        pressed.add(key);
        const out = await registry.dispatchComponent(c);
        if (!out) continue;
        if (out.result.type === "modal") {
          const m = out.result.modal;
          forms.push(m);
          expect(modalProblems(m), m.title).toEqual([]);
          // Each form of the one amount: shares, coins, and garbage (the line with both forms).
          for (const amount of ["1", "$50", "全部", "三股"]) {
            const fields = Object.fromEntries(
              m.fields.map((f) => [f.id, f.id === "amount" ? amount : "1"]),
            );
            const sub = await registry.dispatchComponent({
              custom_id: m.id,
              fields,
              message_id: "m",
              ...who,
            });
            if (sub && sub.result.type !== "modal")
              queue.push({ reply: sub.result.reply, depth: depth + 1 });
          }
          continue;
        }
        queue.push({ reply: out.result.reply, depth: depth + 1 });
      }
    }
  }
  return {
    seen,
    pictures,
    forms,
    specs: [...registry.specs(), registry.groupDescription("me market")],
  };
}

/** A profile's world: its coin and exchange names, its local stocks, the two codes bought. */
interface World {
  currency: string;
  exchange: string;
  config: Partial<ExchangeConfig>;
  codes: [string, string];
}

/** The first character's: no profile words at all. */
const FIRST: World = {
  currency: "魚幣",
  exchange: "深海交易所",
  config: {},
  codes: ["RICE", "WHLE"],
};

/** Another profile's: every word of the first character's world renamed. */
const OTHER: World = {
  currency: "貝殼",
  exchange: "珊瑚交易所",
  config: {
    local_companies: {
      feeding: { code: "FOOD", name: "海帶便當", anchor: 60 },
      songs: { code: "TUNE", name: "浪花錄音", anchor: 70 },
      silence: { code: "NAPZ", name: "珊瑚睡袋" },
      game: { code: "PLAY", name: "貝殼遊樂" },
      model: { code: "MIND", name: "潮汐智慧" },
    },
  },
  codes: ["FOOD", "TUNE"],
};

/** What only the first character's world says: none of it may show in another profile's. */
const FIRST_WORDS = [
  "魚幣",
  "深海交易所",
  "RICE",
  "WHLE",
  "NAPS",
  "CUBE",
  "DPSK",
  "白飯食品",
  "鯨落唱片",
  "打盹床業",
  "方塊礦業",
  "DipSick",
];

const base = {
  context: ctx,
  invoker_is_guild_admin: false,
};

describe("the small print", () => {
  for (const [draws, invoker, name] of [
    [true, ALICE, "Alice"],
    [false, ALICE, "Alice"],
    [true, BOB, "Bob"],
  ] as const) {
    it(`is on every message the commands and their controls reach, once (${name}, pictures ${draws ? "drawn" : "failing"})`, async () => {
      const { seen, pictures } = await walk(draws, invoker, name);
      expect(seen.length).toBeGreaterThan(10);
      for (const reply of seen) {
        const where = reply.card?.title ?? reply.text;
        const { card, drawn } = printed(reply, pictures);
        const all = [card, ...drawn].join("\n");
        // Present at least once per message, in the card or in its picture.
        expect(all, where).toContain(EXCHANGE_DISCLAIMER);
        // Not the identical sentence twice: a drawn picture already says it.
        if (drawn.some((d) => d.includes(EXCHANGE_DISCLAIMER)))
          expect(card, where).not.toContain(EXCHANGE_DISCLAIMER);
        // The plain text (where a picture cannot go) always has it.
        expect(reply.text, where).toContain(EXCHANGE_DISCLAIMER);
        if (all.includes(LEVERAGE_CONFIRM))
          expect(all, where).toContain(EXCHANGE_DISCLAIMER_LEVERAGE);
        if (card.includes("資料來源:Yahoo")) expect(all, where).toContain(EXCHANGE_DISCLAIMER_REAL);
      }
      const kinds = new Set(pictures.data.map((d) => d.kind));
      for (const k of [
        "exchange_overview",
        "exchange_quote",
        "exchange_map",
        "exchange_rich",
        // Bob has no trades to draw.
        ...(invoker === ALICE ? ["exchange_portfolio", "exchange_receipt"] : []),
      ])
        expect(kinds.has(k as PictureKind), k).toBe(true);
      for (const d of pictures.data)
        expect(d.data.small_print, d.kind).toContain(EXCHANGE_DISCLAIMER);
      // Bob had no account: the walk reached the 開戶 card and went on after it.
      if (invoker === BOB) expect(seen.some((x) => x.text.includes("開戶不花錢"))).toBe(true);
    });
  }

  for (const [draws, invoker, name] of [
    [true, ALICE, "Alice"],
    [false, BOB, "Bob"],
  ] as const) {
    it(`speaks another profile's coin, exchange and stocks on every surface (${name}, pictures ${draws ? "drawn" : "failing"})`, async () => {
      const { seen, pictures, forms, specs } = await walk(draws, invoker, name, OTHER);
      expect(seen.length).toBeGreaterThan(10);
      const base = exchangeDisclaimer("貝殼");
      for (const reply of seen) {
        const where = reply.card?.title ?? reply.text;
        const { card, drawn } = printed(reply, pictures);
        // The same small print, in this profile's coin name, on every message.
        expect([card, ...drawn].join(" "), where).toContain(base);
        expect(reply.text, where).toContain(base);
      }
      for (const d of pictures.data) expect(d.data.small_print, d.kind).toContain(base);
      const all = JSON.stringify([seen, pictures.data, forms, specs]);
      for (const word of FIRST_WORDS) expect(all, word).not.toContain(word);
      // Its own names are there: the coin, the exchange, the renamed stocks.
      for (const word of ["貝殼", "珊瑚交易所", "FOOD", "海帶便當", "MIND", "潮汐智慧"])
        expect(all, word).toContain(word);
    });
  }

  it("is under the notice card members get by DM", () => {
    expect(card("深海交易所", ["一則通知"], { real: true, leverage: true }).text).toContain(
      EXCHANGE_DISCLAIMER + EXCHANGE_DISCLAIMER_REAL + EXCHANGE_DISCLAIMER_LEVERAGE,
    );
  });
});
