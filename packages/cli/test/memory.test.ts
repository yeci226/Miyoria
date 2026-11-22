// `miyoria memory rebuild`: the printer and the guards over the notes package's rebuild, on a temp
// database with synthetic chat events and a scripted model.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatRequest, ChatResponse, Completer } from "@miyoria/llm/llm";
import { SqliteStore } from "@miyoria/store";
import { type IncomingMessage, toTimestamp } from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { memoryTables } from "../../memory/memory/src/tables.js";
import { notesTables } from "../../memory/notes/src/store.js";
import { rebuildState } from "../../memory/notes/src/switch.js";
import { COMMANDS, helpText, parseArgs } from "../src/cli.js";
import { type RebuildModel, rebuildCommand } from "../src/commands/memory.js";
import { setOutput } from "../src/ui.js";

const T0 = Date.UTC(2026, 10, 20, 12);
const MIN = 60_000;
const GUILD = { platform: "discord", scope: "g1", channel: "c1", kind: "channel" } as const;
const OWEN = { account: { platform: "discord", id: "100" }, display_name: "Owen", is_bot: false };
const PRICE = { input_per_mtok: 1, cached_input_per_mtok: null, output_per_mtok: 2 };

let root = "";
let db = "";
let cfg = "";
let out: string[] = [];
let restore: () => void = () => undefined;
const text = () => out.join("");

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "miyoria-cli-memory-"));
  mkdirSync(join(root, "data"));
  out = [];
  restore = setOutput({ out: (t) => out.push(t), err: (t) => out.push(t) });
  db = join(root, "data", "core.db");
  cfg = join(root, "miyoria.toml");
  writeFileSync(cfg, `[core]\nprofile = "deepseek-chan"\ndatabase_url = "sqlite:data/core.db"\n`);
  const store = await SqliteStore.open(db, { plugins: [notesTables, memoryTables] });
  for (let i = 0; i < 3; i++) say(store, i * MIN, `我喜歡拉麵 ${i}`);
  for (let i = 0; i < 2; i++) say(store, 60 * MIN + i * MIN, `後來又聊到咖哩 ${i}`);
  await store.close();
});
afterEach(() => {
  restore();
  rmSync(root, { recursive: true, force: true });
});

let n = 0;
function say(store: SqliteStore, ms: number, body: string) {
  const message: IncomingMessage = {
    id: { context: GUILD, id: `m${++n}` },
    author: OWEN,
    text: body,
    mentions_self: false,
    reply_to_self: false,
    attachments: [],
    ts: toTimestamp(T0 + ms),
  };
  store.chat.message(message, { self: false, source: "platform.discord" });
}

function model(price: RebuildModel["price"]): { model: RebuildModel; asked: ChatRequest[] } {
  const asked: ChatRequest[] = [];
  const router: Completer = {
    async complete(_purpose: string, request: ChatRequest): Promise<ChatResponse> {
      asked.push(request);
      return {
        text: JSON.stringify({ edits: [] }),
        reasoning: "",
        tool_calls: [],
        finish_reason: "stop",
        usage: { prompt_tokens: 1000, completion_tokens: 100, cached_prompt_tokens: null },
      };
    },
  };
  return { model: { router, price, label: "p:m" }, asked };
}

const options = { apply: false, force: false, since: "2026-11-15" };
const free = () => [] as string[];

describe("miyoria memory rebuild", () => {
  it("is a command with its options", () => {
    const memory = COMMANDS.subcommands?.find((c) => c.name === "memory");
    const rebuild = memory?.subcommands?.find((c) => c.name === "rebuild");
    expect(rebuild).toBeDefined();
    expect(helpText([COMMANDS, memory as never, rebuild as never])).toContain("--apply");
    const parsed = parseArgs(["memory", "rebuild", "--apply", "--max-usd", "3", "x.db"]);
    expect(parsed.ctx.options).toMatchObject({ apply: true, "max-usd": "3" });
    expect(parsed.ctx.args).toEqual(["x.db"]);
  });

  it("previews by default: sessions, segments, lines, tokens, and no model call", async () => {
    const m = model(null);
    await rebuildCommand(cfg, { ...options, file: db }, { model: async () => m.model, held: free });
    expect(text()).toContain("對話(session):1");
    expect(text()).toContain("聊天行數:5");
    expect(text()).toContain("段落:2");
    expect(text()).toMatch(/預估:輸入 [\d,]+ tokens、輸出 [\d,]+ tokens/);
    expect(text()).toContain("價格未知");
    expect(text()).toContain("加 --apply");
    expect(m.asked).toHaveLength(0);

    out = [];
    const priced = model(PRICE);
    await rebuildCommand(
      cfg,
      { ...options, file: db },
      { model: async () => priced.model, held: free },
    );
    expect(text()).toMatch(/預估費用:\$/);
    expect(text()).not.toContain("價格未知");
    expect(priced.asked).toHaveLength(0);

    // A pass that thinks first: the output counts the thinking, and the line says so.
    out = [];
    const thinking = model(PRICE);
    await rebuildCommand(
      cfg,
      { ...options, file: db },
      { model: async () => ({ ...thinking.model, reasoning: "medium" }), held: free },
    );
    expect(text()).toMatch(/輸出 6,600 tokens.*含思考,推理 medium/);
  });

  it("leaves out what is before --since", async () => {
    await rebuildCommand(
      cfg,
      { ...options, file: db, since: "2026-11-20T12:30:00Z" },
      { model: async () => model(null).model, held: free },
    );
    expect(text()).toContain("聊天行數:2");
  });

  it("refuses --apply while another process holds the database, unless --force", async () => {
    const m = model(PRICE);
    const seams = { model: async () => m.model, held: (files: readonly string[]) => [...files] };
    await expect(rebuildCommand(cfg, { ...options, file: db, apply: true }, seams)).rejects.toThrow(
      "資料庫還開著",
    );
    expect(m.asked).toHaveLength(0);
    await rebuildCommand(cfg, { ...options, file: db, apply: true, force: true }, seams);
    expect(m.asked).toHaveLength(2);
  });

  it("refuses --apply for a model with no price", async () => {
    const m = model(null);
    await expect(
      rebuildCommand(
        cfg,
        { ...options, file: db, apply: true },
        { model: async () => m.model, held: free },
      ),
    ).rejects.toThrow("[llm.pricing]");
    expect(m.asked).toHaveLength(0);
  });

  it("does the work, keeps its place, and stops at --max-usd", async () => {
    // One call costs 1000 * 1 + 100 * 2 = 0.0012 USD; 0.001 is spent after the first.
    const first = model(PRICE);
    await rebuildCommand(
      cfg,
      { ...options, file: db, apply: true, maxUsd: "0.001" },
      { model: async () => first.model, held: free },
    );
    expect(first.asked).toHaveLength(1);
    expect(text()).toContain("budget");
    const state = async () => {
      const store = await SqliteStore.open(db, { plugins: [notesTables, memoryTables] });
      try {
        return await rebuildState(store.settings, "deepseek-chan");
      } finally {
        await store.close();
      }
    };
    expect(await state()).toMatchObject({ done_at: null });

    out = [];
    const second = model(PRICE);
    await rebuildCommand(
      cfg,
      { ...options, file: db, apply: true },
      { model: async () => second.model, held: free },
    );
    expect(second.asked).toHaveLength(1);
    expect(text()).toContain("done");
    expect(text()).toContain("記憶以筆記為主");
    expect((await state())?.done_at).not.toBeNull();

    out = [];
    await rebuildCommand(
      cfg,
      { ...options, file: db },
      { model: async () => model(PRICE).model, held: free },
    );
    expect(text()).toContain("段落:0");
  });

  it("ends --apply with vectors for her documents' lines, and says how many wait", async () => {
    const store = await SqliteStore.open(db, { plugins: [notesTables, memoryTables] });
    store.plugin(notesTables).add(
      "topic:拉麵",
      {
        section: "重點",
        text: "車站前的拉麵很好吃",
        provenance: "observed",
        scope: { type: "public" },
      },
      { author: "tool" },
    );
    await store.close();
    const embedded: string[] = [];
    const embedder = {
      name: "fake",
      enabled: true,
      embeddingModel: "fake|1",
      embed: async (texts: readonly string[]) => {
        embedded.push(...texts);
        return texts.map((t) => [t.length, 1]);
      },
    };
    const seams = { model: async () => model(PRICE).model, held: free };

    const withEmbedder = { ...seams, embedder: async () => embedder };
    await rebuildCommand(cfg, { ...options, file: db }, withEmbedder);
    expect(text()).toContain("向量:1 行還沒有(共 1 行)");
    expect(embedded).toEqual([]);

    out = [];
    await rebuildCommand(cfg, { ...options, file: db, apply: true }, withEmbedder);
    expect(text()).toContain("向量:補上 1 行");
    expect(embedded).toContain("車站前的拉麵很好吃");

    out = [];
    await rebuildCommand(cfg, { ...options, file: db }, withEmbedder);
    expect(text()).toContain("向量:0 行還沒有(共 1 行)");

    // `[memory.embedding]` not set: the report says so.
    out = [];
    await rebuildCommand(cfg, { ...options, file: db }, seams);
    expect(text()).toContain("向量:沒開");
  });

  it("rejects a bad --since and a bad --max-usd", async () => {
    const seams = { model: async () => model(PRICE).model, held: free };
    await expect(
      rebuildCommand(cfg, { ...options, file: db, since: "yesterday" }, seams),
    ).rejects.toThrow("--since");
    await expect(
      rebuildCommand(cfg, { ...options, file: db, maxUsd: "-1" }, seams),
    ).rejects.toThrow("--max-usd");
  });
});
