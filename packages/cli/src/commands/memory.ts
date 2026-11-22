// `miyoria memory rebuild`: writes her memory again from the event log (what the segment pass
// does for a live conversation, run over the lines already logged). Offline, on one database file.
//
// - A dry run (the default) reads the log and prints what a run would do and cost, with no model
//   call. It opens the store, which applies schema migrations the file is still missing.
// - `--apply` runs every segment through the pass with the model of the config. Progress is kept
//   in the database (`event_cursors`, consumer `memory.rebuild`), so a stopped run goes on from
//   the segment it was at. `--max-usd` stops it before the next segment once that much is spent.
// - It writes lines and episodes only. It never deletes or supersedes a record.
// - `--apply` records when the rebuild first began, and when a run has handled every segment
//   (the setting `notes:rebuild`): from the next start of the Core on, her notes are the source
//   of her memory (the live segment pass runs, consolidation stops, recall reads the notes).
// - `--apply` is refused while another process holds the database file open (a Core running on
//   it), unless `--force`. That check is the operating system's view of the file (`heldFiles`),
//   not a lock of the Core's own.
// - With `[memory.embedding]` on, `--apply` ends by giving every line of her documents a vector
//   (`rebuildVectors`), and the pass finds related documents by meaning too; either way the
//   report says how many lines still wait for one (the running Core's backfill does the rest).
//
// The notes package is imported by relative path (and lazily): the CLI has no dependency on
// `@miyoria/memory` yet.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadProfile, profileId } from "@miyoria/core/light";
import {
  type ChatProvider,
  type Completer,
  LlmConfigSchema,
  LlmRouter,
  type ModelRef,
  modelRefString,
  OpenAiFactory,
  type Pricing,
  PricingSchema,
  parseModelRef,
} from "@miyoria/llm/llm";
import { type Config, configureLogging, parseSection } from "@miyoria/runtime/kernel";
import { type ReasoningLevel, toTimestamp } from "@miyoria/types";
import { bold, dim, note, ok, println, section, warn } from "../ui.js";
import { configuredDatabase } from "./db.js";
import { loadConfig } from "./node.js";

export class MemoryCommandError extends Error {
  override readonly name = "MemoryCommandError";
}

/** What a run spends at most when `--max-usd` is not given. */
export const DEFAULT_MAX_USD = 2;
/** The model purpose of the segment pass. */
export const REBUILD_PURPOSE = "summarizer";
/** How long the pass waits for a query's vector in a rebuild. */
const REBUILD_VECTOR_WAIT_MS = 10_000;

/** The model of a run: what answers, and what a token costs (`null`: no price in the config). */
export interface RebuildModel {
  router: Completer;
  price: Pricing | null;
  /** The first model of the chain, as `provider:model`; empty without a chain. */
  label: string;
  /** How deeply the pass's model reasons (its thinking is billed as output); absent: `off`. */
  reasoning?: ReasoningLevel;
}

export interface RebuildCommandOptions {
  /** The database file; default `core.database_url`. */
  file?: string | undefined;
  /** Chat lines before this time are left out (an ISO date or time); default 2026-11-15. */
  since?: string | undefined;
  apply: boolean;
  /** USD; default `DEFAULT_MAX_USD`. */
  maxUsd?: string | undefined;
  force: boolean;
}

/** What makes vectors for the end of a run (`Embedder` of the memory package). */
export interface RebuildEmbedder {
  readonly name: string;
  readonly enabled: boolean;
  readonly embeddingModel?: string;
  embed(texts: readonly string[], signal?: AbortSignal): Promise<number[][]>;
  embedQuery?(texts: readonly string[], signal?: AbortSignal): Promise<number[][]>;
  close?(): Promise<void>;
}

/** What tests replace: the model, the check for a process holding the file, the embedder. */
export interface RebuildSeams {
  model?: (config: Config, apply: boolean) => Promise<RebuildModel>;
  held?: (files: readonly string[]) => string[];
  embedder?: (config: Config) => Promise<RebuildEmbedder>;
}

/** Silences the store's migration log lines in the middle of the report. */
function quietLogs(): void {
  if (!process.env.MIYORIA_LOG_LEVEL) configureLogging({ level: "warn" });
}

const loadNotes = async () => ({
  ...(await import("../../../memory/notes/src/rebuild.js")),
  ...(await import("../../../memory/notes/src/store.js")),
  ...(await import("../../../memory/notes/src/vectors.js")),
  ...(await import("../../../memory/notes/src/rank.js")),
});

/** The embedder `[memory.embedding]` names (nothing is loaded until it embeds). */
async function embedderOfConfig(config: Config): Promise<RebuildEmbedder> {
  const { EmbeddingConfigSchema } = await import("../../../memory/memory/src/config.js");
  const { buildEmbedder } = await import("../../../memory/memory/src/embed.js");
  return buildEmbedder(config.get("memory.embedding", EmbeddingConfigSchema));
}

/** `[modules.memory]`, for how the pass ranks related documents by meaning. */
async function memoryConfigOf(config: Config) {
  const { MemoryConfigSchema } = await import("../../../memory/memory/src/config.js");
  return parseSection(MemoryConfigSchema, config.module("memory").config ?? {}, "modules.memory");
}

/**
 * The router of the config, as the Core builds it (the profile's `[llm.purposes]` over the global
 * ones); providers only when `withProviders`, so a dry run needs no keys.
 */
export async function modelOfConfig(
  config: Config,
  withProviders: boolean,
  purpose = REBUILD_PURPOSE,
): Promise<RebuildModel> {
  const llm = config.get("llm", LlmConfigSchema);
  const providers = new Map<string, ChatProvider>();
  if (withProviders) {
    const factory = new OpenAiFactory();
    for (const [name, cfg] of Object.entries(llm.providers)) {
      if (!factory.kinds.includes(cfg.kind)) {
        throw new MemoryCommandError(`provider \`${name}\`: unknown kind \`${cfg.kind}\``);
      }
      providers.set(name, factory.build(name, cfg));
    }
  }
  const pricing = new Map(Object.entries(llm.pricing));
  const router = new LlmRouter(providers, new Map(Object.entries(llm.purposes)), {
    pricing,
    reasoning: new Map(Object.entries(llm.reasoning)),
    imageInput: new Map(Object.entries(llm.image_input)),
  });
  const profile = await loadProfile(config);
  router.setPurposes(
    new Map<string, ModelRef[]>(
      Object.entries(profile.manifest.llm.purposes).map(([name, chain]) => [
        name,
        chain.map(parseModelRef),
      ]),
    ),
  );
  const first = router.chain(purpose)[0];
  const label = first === undefined ? "" : modelRefString(first);
  const price = pricing.get(label);
  return {
    router,
    price: price === undefined ? null : PricingSchema.parse(price),
    label,
    reasoning: router.reasoningFor(purpose, { messages: [] }),
  };
}

function parseSince(text: string | undefined, fallback: ReturnType<typeof toTimestamp>) {
  if (text === undefined) return fallback;
  const at = Date.parse(text);
  if (Number.isNaN(at))
    throw new MemoryCommandError(`--since 要是 ISO 日期,例如 2026-11-15:${text}`);
  return toTimestamp(at);
}

function parseMaxUsd(text: string | undefined): number {
  if (text === undefined) return DEFAULT_MAX_USD;
  const n = Number(text);
  if (!Number.isFinite(n) || n <= 0) {
    throw new MemoryCommandError(`--max-usd 要是大於 0 的數字(美元):${text}`);
  }
  return n;
}

const usd = (n: number) => `$${n.toFixed(n < 0.1 ? 4 : 2)}`;
const count = (n: number) => n.toLocaleString("en-US");

/** `miyoria memory rebuild [file]`. */
export async function rebuildCommand(
  configPath: string,
  options: RebuildCommandOptions,
  seams: RebuildSeams = {},
): Promise<void> {
  quietLogs();
  const config = await loadConfig(configPath);
  const path =
    options.file !== undefined
      ? resolve(options.file)
      : await configuredDatabase(config, configPath);
  if (!existsSync(path)) throw new MemoryCommandError(`找不到資料庫:${path}`);
  const maxUsd = parseMaxUsd(options.maxUsd);
  const profile = profileId(config);
  const notes = await loadNotes();
  const since = parseSince(options.since, notes.REBUILD_SINCE);

  if (options.apply && !options.force) {
    const held = seams.held ?? (await import("@miyoria/store")).heldFiles;
    const open = held([path, `${path}-wal`, `${path}-shm`]);
    if (open.length > 0) {
      throw new MemoryCommandError(
        "資料庫還開著(Core 或別的程式正在用它):先停掉 core,或確定沒問題時加 --force",
      );
    }
  }

  const model = await (seams.model ?? ((c, apply) => modelOfConfig(c, apply)))(
    config,
    options.apply,
  );
  const { SqliteStore } = await import("@miyoria/store");
  const { memoryTables } = await import("../../../memory/memory/src/tables.js");
  const store = await SqliteStore.open(path, { plugins: [notes.notesTables, memoryTables] });
  const embedder = await (seams.embedder ?? embedderOfConfig)(config);
  try {
    const store_ = store.plugin(notes.notesTables);
    const vectorModel = embedder.enabled ? notes.modelOf(embedder) : null;
    /** How many lines wait for a vector, as one line of the report. */
    const waitingLine = () => {
      if (vectorModel === null) {
        return "  向量:沒開([memory.embedding] provider = none),筆記只用關鍵字找";
      }
      const c = store_.vectorCounts(vectorModel);
      return `  向量:${count(c.waiting)} 行還沒有(共 ${count(c.lines)} 行)${dim(`(${vectorModel})`)}`;
    };
    const cursors = store_.cursors();
    if (cursors === null) throw new MemoryCommandError("這個資料庫沒有事件紀錄,沒有東西可以重建");
    const plan = await notes.planRebuild(store.events, cursors, { since });
    const reasoning = model.reasoning ?? "off";
    const estimate = notes.estimateRebuild(plan, model.price, reasoning);

    section(`重建記憶:${path}`);
    note(`從 ${plan.since} 起的聊天事件;${options.apply ? "會呼叫模型" : "預覽,沒有呼叫模型"}`);
    println(`  對話(session):${plan.sessions.length}`);
    println(`  聊天行數:${count(plan.lines)}`);
    println(
      `  段落:${count(estimate.segments)}(還沒做的;已做的 ${count(plan.sessions.reduce((n, s) => n + s.done, 0))} 段會跳過)`,
    );
    const skipped = plan.sessions.filter((s) => s.unplaced);
    if (skipped.length > 0) println(dim(`  不知道在哪裡的對話 ${skipped.length} 個,略過`));
    println(
      `  預估:輸入 ${count(estimate.prompt_tokens)} tokens、輸出 ${count(estimate.completion_tokens)} tokens${reasoning === "off" ? "" : dim(`(含思考,推理 ${reasoning})`)}`,
    );
    println(
      `  預估費用:${estimate.usd === null ? "價格未知" : usd(estimate.usd)}${model.label === "" ? "" : dim(`(${model.label})`)}`,
    );
    println(waitingLine());
    if (!options.apply) {
      println();
      println(
        dim("加 --apply 才會開始(--max-usd 設上限,預設 2 美元);中斷後再跑會從上次停的地方繼續。"),
      );
      return;
    }
    if (model.price === null) {
      throw new MemoryCommandError(
        `config 裡沒有 ${model.label === "" ? "這個用途" : model.label} 的價格([llm.pricing]):沒有價格就無法用 --max-usd 擋住花費`,
      );
    }
    if (estimate.usd !== null && estimate.usd > maxUsd) {
      warn(`預估 ${usd(estimate.usd)} 超過上限 ${usd(maxUsd)};會跑到花滿為止,之後可以再跑繼續`);
    }
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGINT", stop);
    const index = embedder.enabled ? new notes.NotesIndex({ notes: store_, embedder }) : null;
    try {
      const memory = await memoryConfigOf(config);
      const search = new notes.NotesSearch({
        notes: store_,
        index,
        ranking: () => notes.rankingOf(memory),
        // Nobody waits on a rebuild: the first query also waits for the model to load.
        wait: () => ({ text: REBUILD_VECTOR_WAIT_MS, voice: REBUILD_VECTOR_WAIT_MS }),
      });
      const report = await notes.applyRebuild(plan, {
        router: model.router,
        notes: store_,
        search,
        episodes: notes.rebuildEpisodeSink(store, profile, store_.resolver(), plan),
        cursor: cursors,
        price: model.price,
        maxUsd,
        purpose: REBUILD_PURPOSE,
        signal: controller.signal,
        marker: { settings: store.settings, profile },
        onSegment: (done, of) => {
          if (done % 10 === 0 || done === of) println(dim(`  ${done} / ${of}`));
        },
      });
      println();
      println(
        `${bold("結果")}:${report.status};做了 ${report.segments} / ${report.total} 段(空的 ${report.empty}、放棄 ${report.abandoned})`,
      );
      println(`  寫入 ${report.written} 行(丟掉 ${report.dropped} 行)、${report.episodes} 則情節`);
      println(
        `  模型 ${report.usage.calls} 次、輸入 ${count(report.usage.prompt_tokens)}、輸出 ${count(report.usage.completion_tokens)} tokens、花費 ${usd(report.usd)}`,
      );
      if (index !== null && (report.status === "done" || report.status === "budget")) {
        const v = await notes.rebuildVectors(index, {
          signal: controller.signal,
          onBatch: (done, waiting) => println(dim(`  向量 ${done} 行,還有 ${waiting} 行`)),
        });
        const why =
          v.status === "off"
            ? "embedding 沒辦法載入(原因在上面的 log)"
            : v.status === "stalled"
              ? "embedding 出錯(原因在上面的 log)"
              : v.status === "aborted"
                ? "中斷"
                : "";
        println(
          `  向量:補上 ${count(v.done)} 行${v.waiting > 0 ? `,還有 ${count(v.waiting)} 行沒有${why === "" ? "" : `(${why};Core 開著時背景會再補)`}` : ""}`,
        );
      } else {
        println(waitingLine());
      }
      if (report.status === "done") {
        ok("完成");
        note("從下次啟動起,她的記憶以筆記為主:段落整理即時跑,舊的整理停掉,回想讀筆記");
      } else if (report.status === "budget") warn("到上限停下來;再跑一次會從這裡繼續");
      else if (report.status === "aborted") warn("中斷;再跑一次會從這裡繼續");
      else {
        throw new MemoryCommandError(
          `模型出錯,停下來:${report.error ?? "unknown"}(再跑一次會繼續)`,
        );
      }
    } finally {
      process.off("SIGINT", stop);
      index?.close();
    }
  } finally {
    await embedder.close?.();
    store.close();
  }
}
