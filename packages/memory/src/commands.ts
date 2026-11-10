// `/me memory show | export | forget` (your own memories) and `/admin memory wipe` (everything
// she remembers, owner only).
//
// The wipe deletes data categories (`@miyoria/store` `DATA_CATEGORIES`, shared with the panel's
// data page) in one transaction, after sending a JSON backup of exactly what it deletes, with the
// modules caching that data stopped around the transaction. Chat history
// and the consolidation watermarks always go together: without the log, a watermark is
// harmless; without the watermark, the log would be extracted into memories again.

import { gzipSync } from "node:zlib";
import {
  type AnyComponentRoute,
  ArgKind,
  argSpec,
  type CardBlock,
  type CommandRegistry,
  type CommandReply,
  type ComponentInvocation,
  ComponentResult,
  cancelled,
  cardReply,
  commandSpec,
  componentId,
  confirm,
  defineRoute,
  type Invocation,
  intParam,
  notice,
  pageButtons,
  pageOf,
} from "@miyoria/commands";
import { errorMessage, getLogger, type ServiceLookup, SupervisorKey } from "@miyoria/kernel";
import {
  AuditLogKey,
  categoryModules,
  type DataCategoryId,
  type MemoryKind,
  type MemoryRecord,
  ProfileDataStoreKey,
  resolveCategories,
  type WipeCounts,
} from "@miyoria/store";
import {
  type AccountRef,
  type Clock,
  newId,
  type PersonId,
  type ProfileId,
  systemClock,
  toTimestamp,
} from "@miyoria/types";
import type { ForgetReport, MemoryEngine } from "./engine.js";
import { isEventRef } from "./evidence.js";
import { hasScope, scopeLabel, visibleScopes } from "./scope.js";
import { effectiveConfidence, relativeDate } from "./score.js";

const log = getLogger("memory.commands");

export const PATHS = [
  "me memory show",
  "me memory export",
  "me memory forget",
  "admin memory wipe",
] as const;

export const NODE_WIPE = "owner.memory.wipe";
const PAGE_SIZE = 10;

/** Largest backup sent as is; bigger ones are gzipped. */
const MAX_PLAIN_BACKUP = 8 * 1024 * 1024;
/** Largest (gzipped) backup a bot may attach. */
const MAX_BACKUP = 9.5 * 1024 * 1024;

export type WipeScope = "memories" | "relationships" | "history" | "everything";

const SCOPES: readonly WipeScope[] = ["memories", "relationships", "history", "everything"];

export const WIPE_SCOPE_LABEL: Record<WipeScope, string> = {
  memories: "記憶",
  relationships: "記憶與關係",
  history: "記憶、關係與聊天紀錄",
  everything: "全部",
};

const WIPE_SCOPE_DETAIL: Record<WipeScope, string> = {
  memories: "她記得的所有事（經歷、事實、筆記、之後要問的事），以及她自己整理的資料。",
  relationships:
    "記憶，加上她對每個人的好感、信任、熟悉度、印象、感情描述與變化紀錄，以及心情、內在狀態、內心獨白、反思、學到的事與回饋紀錄。",
  history: "記憶與關係，加上聊天紀錄、對話筆記、決策紀錄與記憶整理進度。",
  everything: "以上全部，加上主動發話的狀態。",
};

/**
 * The data categories (`@miyoria/store` `DATA_CATEGORIES`) each scope deletes. Every later
 * scope includes the earlier ones. Memories take the maintenance key with them; her mood,
 * inner state and feelings about people go with the relationships; the consolidation
 * watermarks are part of `messages`, so they never go without the log they point into.
 */
export function wipePlan(scope: WipeScope): DataCategoryId[] {
  const level = SCOPES.indexOf(scope);
  const ids: DataCategoryId[] = ["memories", "knowledge"];
  if (level >= 1) ids.push("relationships", "inner", "mood", "learning");
  if (level >= 2) ids.push("messages", "decisions");
  if (level >= 3) ids.push("initiative");
  return resolveCategories(ids);
}

/** Modules stopped around a wipe of `scope` (their caches would write the old state back). */
export function wipeModules(scope: WipeScope): string[] {
  return categoryModules(wipePlan(scope));
}

/** What `me memory forget` removes, said before it is asked and again after it is done. */
export const FORGET_REMOVES =
  "會刪除：關於你的記憶、你告訴她的事，以及從你說過的話整理出來的記憶（經歷、事實、她的筆記）。";
/** What it leaves, and why. */
export const FORGET_KEEPS =
  "不會刪除：聊天紀錄和事件紀錄（那是整理記憶的證據，只有擁有者能用 /admin memory wipe 清除）、她對你的好感與印象，以及和你無關、也不是從你的話整理出來的記憶。之後你再說起同樣的事，她可能會重新記下來。";

const R = {
  showPage: "me:memory:page",
  show: "me:memory:show",
  forgetAsk: "me:memory:forget:ask",
  forgetAll: "me:memory:forget:all",
  forgetKeyword: "me:memory:forget:keyword",
  forgetNo: "me:memory:forget:no",
  wipeScope: "admin:memory:wipe:scope",
  wipeAsk: "admin:memory:wipe:ask",
  wipeGo: "admin:memory:wipe:go",
  wipeNo: "admin:memory:wipe:no",
} as const;

export interface MemoryCommandDeps {
  services: ServiceLookup;
  clock?: Clock;
}

/** What `forget` would take from someone, as far as a place may show it. */
export interface OwnMemories {
  records: MemoryRecord[];
  person: PersonId | null;
  /** Ids of the records derived from what they said (the rest are about them). */
  derived: ReadonlySet<string>;
}

/**
 * The records about `account`, then the ones derived from what they said, newest first, keeping
 * what `visible` allows. `/me memory` passes the scopes of the invocation, the member page its own
 * rule. `derived: false` skips those: finding them walks every memory.
 */
export async function ownMemories(
  engine: MemoryEngine,
  account: AccountRef,
  visible: (record: MemoryRecord, person: PersonId | null) => boolean,
  options: { derived?: boolean } = {},
): Promise<OwnMemories> {
  const person = await engine.personOf(account);
  const own = (await engine.memoriesOf(person, account, false)).filter((r) => visible(r, person));
  const found =
    options.derived === false
      ? { records: [] }
      : await engine.derivedFrom(person, account, new Set(own.map((r) => r.id)));
  const derived = found.records.filter((r) => r.superseded_by === null && visible(r, person));
  const records = [...own, ...derived].sort(
    (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || (b.id < a.id ? -1 : 1),
  );
  return { records, person, derived: new Set(derived.map((r) => r.id)) };
}

class Handler {
  readonly clock: Clock;

  constructor(
    readonly engine: MemoryEngine,
    readonly deps: MemoryCommandDeps,
  ) {
    this.clock = deps.clock ?? systemClock;
  }

  get profile(): ProfileId {
    return this.engine.profile;
  }

  /**
   * What `forget` would take, as far as it may be shown in the invocation's context: the
   * records about the invoker, then the ones derived from what they said (`derived`).
   */
  async visible(inv: Invocation): Promise<OwnMemories> {
    // Only the invoker is "in" the context of the reply, so DM memories show up only in the
    // invoker's own DM.
    return ownMemories(this.engine, inv.invoker, (r, person) =>
      hasScope(visibleScopes(inv.context, [inv.invoker], person === null ? [] : [person]), r.scope),
    );
  }

  async show(inv: Invocation, page: number): Promise<CommandReply> {
    const { records, derived } = await this.visible(inv);
    if (records.length === 0) return notice("info", "在這裡，她還沒有記得關於你的事。");
    const now = toTimestamp(this.clock.now());
    const view = pageOf(records, page, PAGE_SIZE);
    const lines = view.items.map(
      (r) =>
        `〔${kindLabel(r.kind)}・${originLabel(r)}〕${truncate(r.content.replaceAll("\n", " "), 160)}\n-# ${relativeDate(r.created_at, now)}・${evidenceLabel(r)}${derived.has(r.id) ? "・出自你說的話" : ""}`,
    );
    const blocks: CardBlock[] = [
      { type: "text", text: lines.join("\n") },
      ...pageButtons(view, (p) => componentId(R.showPage, p)),
      {
        type: "buttons",
        buttons: [{ id: componentId(R.forgetAsk), label: "全部忘記", style: "danger" }],
      },
      {
        type: "muted",
        text: "這是她整理出來的記憶,不是聊天紀錄。匯出完整內容請使用 /me memory export。",
      },
    ];
    return cardReply(blocks, {
      title: `她記得的事（${records.length}）`,
      accent: "brand",
      session: {},
    });
  }

  async export(inv: Invocation): Promise<CommandReply> {
    const { records, derived } = await this.visible(inv);
    if (records.length === 0) return notice("info", "在這裡沒有關於你的記憶可以匯出。");
    const now = toTimestamp(this.clock.now());
    const json = `${JSON.stringify(
      records.map((r) =>
        exportItem(r, effectiveConfidence(this.engine.config, r, now), derived.has(r.id)),
      ),
      null,
      2,
    )}\n`;
    const name = `memories-${toTimestamp(this.clock.now()).slice(0, 10)}.json`;
    return cardReply([{ type: "text", text: `已匯出 ${records.length} 筆記憶。` }], {
      title: "匯出記憶",
      accent: "success",
      files: [{ name, data: json, contentType: "application/json" }],
    });
  }

  async forget(inv: Invocation, keyword: string | null): Promise<CommandReply> {
    const person = await this.engine.personOf(inv.invoker);
    const report = await this.engine.forget(person, inv.invoker, keyword);
    const n = report.deleted;
    // Said as it is: what went, how much of it was not about the person themselves, what stayed.
    const detail = [forgetBreakdown(report), FORGET_KEEPS].filter((t) => t !== "").join("\n");
    if (keyword === null) {
      return n === 0
        ? notice("info", "她本來就沒有記得關於你的事。", unverifiedNote(report) || FORGET_KEEPS)
        : notice("success", `已讓她忘記關於你的 ${n} 件事。`, detail);
    }
    return n === 0
      ? notice("info", `她沒有記得和「${keyword}」有關的事。`, unverifiedNote(report) || null)
      : notice("success", `已讓她忘記和「${keyword}」有關的 ${n} 件事。`, detail);
  }

  askForget(raw: string): CommandReply {
    const target = raw.trim();
    if (target === "") return notice("warn", "請輸入要忘記的關鍵字，或輸入 all 忘記全部。");
    if (target.toLowerCase() === "all") {
      return confirm({
        title: "忘記全部",
        text: "確定要讓她忘記關於你的所有事嗎？這無法復原。",
        detail: `${FORGET_REMOVES}\n${FORGET_KEEPS}\n需要備份的話，請先使用 /me memory export。`,
        confirmId: componentId(R.forgetAll),
        cancelId: componentId(R.forgetNo),
        confirmLabel: "全部忘記",
      });
    }
    const reply = confirm({
      title: "忘記",
      text: `確定要讓她忘記和「${truncate(target, 50)}」有關的事嗎？這無法復原。`,
      detail: `${FORGET_REMOVES}\n${FORGET_KEEPS}`,
      confirmId: componentId(R.forgetKeyword),
      cancelId: componentId(R.forgetNo),
      confirmLabel: "忘記",
    });
    // The keyword may hold any text, so it travels in the panel session, not the id.
    reply.session = { data: { keyword: target } };
    return reply;
  }

  // ---- wipe -----------------------------------------------------------------------------------

  wipeStart(): CommandReply {
    return cardReply(
      [
        {
          type: "text",
          text:
            `這會刪除 profile \`${this.profile}\` 的資料，選擇範圍後會再確認一次。\n` +
            "人物、帳號連結、權限、稽核紀錄與人格設定不受影響。",
        },
        {
          type: "select",
          select: {
            id: componentId(R.wipeScope),
            placeholder: "選擇清除範圍…",
            options: SCOPES.map((s) => ({
              label: WIPE_SCOPE_LABEL[s],
              value: s,
              description: truncate(WIPE_SCOPE_DETAIL[s], 100),
            })),
          },
        },
      ],
      { title: "清除記憶", accent: "danger", session: {} },
    );
  }

  async wipeConfirm(scope: WipeScope): Promise<CommandReply> {
    const store = this.deps.services.get(ProfileDataStoreKey);
    if (!store) return notice("error", "目前無法清除資料。", "找不到 ProfileDataStore 服務。");
    const inventory = await store.inventory(this.profile);
    const part = (id: string) =>
      inventory.categories.flatMap((c) => c.parts).find((p) => p.id === id)?.count ?? 0;
    const counts = [
      `記憶 ${part("memory_records")} 筆`,
      ...(scope !== "memories"
        ? [`關係 ${part("relationships")} 筆（變化紀錄 ${part("relationship_deltas")} 筆）`]
        : []),
      ...(scope === "history" || scope === "everything"
        ? [`聊天紀錄 ${part("message_log")} 則、決策紀錄 ${part("decision_log")} 筆`]
        : []),
    ];
    return confirm({
      title: `清除：${WIPE_SCOPE_LABEL[scope]}`,
      text:
        `${WIPE_SCOPE_DETAIL[scope]}\n將刪除：${counts.join("、")}。\n` +
        "刪除前會先傳送一份 JSON 備份檔。按下確認後，請輸入 profile id。",
      detail: "刪除後無法復原。",
      confirmId: componentId(R.wipeAsk, scope),
      cancelId: componentId(R.wipeNo),
      confirmLabel: "確認並輸入 profile id",
    });
  }

  async wipe(inv: ComponentInvocation, scope: WipeScope): Promise<CommandReply> {
    const typed = inv.field("profile");
    if (typed !== this.profile) {
      return notice("warn", "輸入的 profile id 不正確，沒有刪除任何資料。");
    }
    const store = this.deps.services.get(ProfileDataStoreKey);
    if (!store) return notice("error", "目前無法清除資料。", "找不到 ProfileDataStore 服務。");
    if (!inv.canFollowUp()) {
      return notice("error", "這個平台無法傳送備份檔，已取消清除。");
    }
    const plan = wipePlan(scope);
    const at = toTimestamp(this.clock.now());

    // 1. The backup, sent before anything is deleted.
    let file: { name: string; data: Uint8Array | string; contentType: string };
    try {
      const backup = await store.export(this.profile, plan);
      const json = `${JSON.stringify(backup, null, 2)}\n`;
      const base = `${this.profile}-${scope}-${at.slice(0, 19).replaceAll(":", "")}`;
      file =
        Buffer.byteLength(json) <= MAX_PLAIN_BACKUP
          ? { name: `${base}.json`, data: json, contentType: "application/json" }
          : { name: `${base}.json.gz`, data: gzipSync(json), contentType: "application/gzip" };
      const size = typeof file.data === "string" ? Buffer.byteLength(file.data) : file.data.length;
      if (size > MAX_BACKUP) {
        return notice(
          "error",
          `備份檔太大（${(size / 1024 / 1024).toFixed(1)} MB），已取消清除。`,
          "請先用 scripts/backup 備份資料庫，再改用較小的範圍或直接操作資料庫。",
        );
      }
      await inv.followUp(
        cardReply([{ type: "text", text: "這是清除前的備份檔，請妥善保存。" }], {
          title: "記憶備份",
          accent: "info",
          ephemeral: true,
          files: [file],
        }),
      );
    } catch (error) {
      log.warn({ error: errorMessage(error) }, "memory wipe backup failed");
      return notice("error", "無法建立或傳送備份檔，沒有刪除任何資料。", errorMessage(error));
    }

    // 2. One transaction, with the modules caching the data stopped around it (a module
    // saving its state on stop must not write the deleted state back).
    let counts: WipeCounts;
    let failed: string[] = [];
    try {
      const sup = this.deps.services.get(SupervisorKey);
      const run = () => store.wipe(this.profile, plan);
      if (sup) {
        const paused = await sup.pause(wipeModules(scope), run);
        counts = paused.value;
        failed = paused.failed;
      } else {
        counts = await run();
      }
    } catch (error) {
      log.warn({ error: errorMessage(error) }, "memory wipe failed");
      await this.audit(inv, scope, null, false);
      return notice("error", "清除失敗，資料沒有變更。", errorMessage(error));
    }
    log.info({ profile: this.profile, scope, counts }, "memory wiped");
    await this.audit(inv, scope, counts, true);

    const n = (...parts: string[]) => parts.reduce((sum, p) => sum + (counts[p] ?? 0), 0);
    const lines = [
      `記憶 ${n("memory_records")} 筆`,
      `關係 ${n("relationships")} 筆、變化紀錄 ${n("relationship_deltas")} 筆`,
      `聊天紀錄 ${n("message_log")} 則、決策紀錄 ${n("decision_log")} 筆`,
      `設定 ${n("memory_maintenance", "memory_watermarks", "self_state", "self_feelings", "mood", "initiative")} 項`,
    ];
    const blocks: CardBlock[] = [
      { type: "text", text: `已刪除：\n${lines.join("\n")}` },
      { type: "muted", text: `備份檔：${file.name}` },
    ];
    if (failed.length > 0) {
      blocks.push({
        type: "muted",
        text: `下列模組無法重新啟動，請手動重新啟動：${failed.join("、")}`,
      });
    }
    return cardReply(blocks, {
      title: `已清除：${WIPE_SCOPE_LABEL[scope]}`,
      accent: failed.length > 0 ? "warn" : "success",
    });
  }

  async audit(
    inv: Invocation,
    scope: WipeScope,
    counts: WipeCounts | null,
    ok: boolean,
  ): Promise<void> {
    const audit = this.deps.services.get(AuditLogKey);
    if (!audit) return;
    try {
      await audit.append({
        id: newId(),
        at: toTimestamp(this.clock.now()),
        actor: `${inv.invoker.platform}:${inv.invoker.id}`,
        action: "memory.wipe",
        target: this.profile,
        detail: { scope, counts: counts === null ? null : { ...counts } },
        ok,
      });
    } catch (error) {
      log.warn({ error: errorMessage(error) }, "cannot write audit entry");
    }
  }
}

function truncate(s: string, max: number): string {
  const chars = [...s];
  return chars.length <= max ? s : `${chars.slice(0, max - 1).join("")}…`;
}

const round2 = (x: number) => Math.round(x * 100) / 100;

/** Rust `DateTime::to_rfc3339`: `+00:00` instead of `Z`. */
function rfc3339(ts: string): string {
  return new Date(ts)
    .toISOString()
    .replace(/\.000Z$/, "Z")
    .replace(/Z$/, "+00:00");
}

/** How many went, by why, and what could not be checked. */
function forgetBreakdown(report: ForgetReport): string {
  const parts: string[] = [];
  if (report.about > 0) parts.push(`關於你的 ${report.about} 件`);
  if (report.derived > 0) parts.push(`你告訴她或從你的話整理出來的 ${report.derived} 件`);
  const lines = parts.length > 0 ? [`其中${parts.join("、")}。`] : [];
  const unverified = unverifiedNote(report);
  if (unverified !== "") lines.push(unverified);
  return lines.join("\n");
}

function unverifiedNote(report: ForgetReport): string {
  return report.unverified > 0
    ? `另有 ${report.unverified} 件記憶的來源事件已從事件紀錄移除，無法確認是否出自你，沒有刪除。`
    : "";
}

function originLabel(r: MemoryRecord): string {
  switch (r.origin ?? "unknown") {
    case "experienced":
      return "親歷";
    case "told":
      return r.source ? `聽 ${r.source.name} 說` : "聽說";
    case "unknown":
      return "來源不明";
  }
}

function evidenceLabel(r: MemoryRecord): string {
  const refs = r.source_events ?? [];
  if (refs.length === 0) return "舊資料，沒有證據";
  return refs.some(isEventRef) ? `有 ${refs.length} 筆證據` : "只有聊天紀錄當證據";
}

function exportItem(r: MemoryRecord, effective: number, derived: boolean): Record<string, unknown> {
  return {
    kind: r.kind,
    content: r.content,
    derived_from_you: derived,
    origin: r.origin ?? "unknown",
    said_by: r.source?.name ?? null,
    source_events: r.source_events ?? [],
    importance: round2(r.importance),
    confidence: round2(r.confidence),
    effective_confidence: round2(effective),
    scope: scopeLabel(r.scope),
    created_at: rfc3339(r.created_at),
    due: r.due === null ? null : rfc3339(r.due),
  };
}

function kindLabel(kind: MemoryKind): string {
  switch (kind) {
    case "episode":
      return "經歷";
    case "fact":
      return "事實";
    case "self_note":
      return "她的筆記";
    case "followup":
      return "之後要問";
  }
}

function unregister(registry: CommandRegistry): void {
  for (const path of PATHS) registry.unregister(path);
}

function isScope(raw: string | undefined): WipeScope | null {
  return SCOPES.includes(raw as WipeScope) ? (raw as WipeScope) : null;
}

function register(registry: CommandRegistry, handler: Handler): void {
  const showRoutes: AnyComponentRoute[] = [
    defineRoute<number>({
      route: R.showPage,
      parse: (p) => intParam(p[0]),
      handle: async (inv, page) => ComponentResult.update(await handler.show(inv, page)),
    }),
    {
      route: R.show,
      handle: async (inv) => ComponentResult.reply(await handler.show(inv, 0)),
    },
  ];
  registry.register(
    commandSpec("me memory show", "查看她記得的關於你的事（只有你看得到）", {
      permission: "memory.self.show",
      ephemeral: true,
    }),
    (inv) => handler.show(inv, 0),
    { components: showRoutes },
  );

  registry.register(
    commandSpec("me memory export", "把她記得的關於你的事匯出成 JSON 檔", {
      permission: "memory.self.export",
      ephemeral: true,
    }),
    (inv) => handler.export(inv),
  );

  const forgetRoutes: AnyComponentRoute[] = [
    { route: R.forgetAsk, handle: () => ComponentResult.update(handler.askForget("all")) },
    {
      route: R.forgetAll,
      handle: async (inv: ComponentInvocation) =>
        ComponentResult.update(await handler.forget(inv, null)),
    },
    {
      route: R.forgetKeyword,
      requiresSession: true,
      handle: async (inv: ComponentInvocation) => {
        const data = inv.session?.data;
        const keyword =
          data &&
          typeof data === "object" &&
          !Array.isArray(data) &&
          typeof data.keyword === "string"
            ? data.keyword
            : null;
        if (keyword === null)
          return ComponentResult.reply(notice("warn", "這個面板已過期，請重新執行指令。"));
        return ComponentResult.update(await handler.forget(inv, keyword));
      },
    },
    { route: R.forgetNo, handle: () => ComponentResult.update(cancelled()) },
  ];
  registry.register(
    commandSpec("me memory forget", "讓她忘記關於你的事（關鍵字，或 all 忘記全部）", {
      args: [argSpec("target", "要忘記的關鍵字，或輸入 all 忘記全部", ArgKind.string)],
      permission: "memory.self.forget",
      ephemeral: true,
    }),
    (inv) => handler.askForget(inv.str("target") ?? ""),
    { components: forgetRoutes },
  );

  const wipeRoutes: AnyComponentRoute[] = [
    {
      route: R.wipeScope,
      handle: async (inv: ComponentInvocation) => {
        const scope = isScope(inv.values[0]);
        if (scope === null) return ComponentResult.update(handler.wipeStart());
        return ComponentResult.update(await handler.wipeConfirm(scope));
      },
    },
    defineRoute<WipeScope>({
      route: R.wipeAsk,
      parse: (p) => isScope(p[0]),
      handle: (_inv, scope) =>
        ComponentResult.modal({
          id: componentId(R.wipeGo, scope),
          title: `確認清除：${WIPE_SCOPE_LABEL[scope]}`,
          fields: [
            {
              id: "profile",
              label: "請輸入 profile id 以確認",
              placeholder: handler.profile,
              maxLength: 100,
            },
          ],
        }),
    }),
    defineRoute<WipeScope>({
      route: R.wipeGo,
      parse: (p) => isScope(p[0]),
      handle: async (inv, scope) => {
        const result = await handler.wipe(inv, scope);
        if (result.tone === "warn" || result.tone === "error") return ComponentResult.reply(result);
        return ComponentResult.update(result);
      },
    }),
    {
      route: R.wipeNo,
      handle: () => ComponentResult.update(cancelled("已取消，沒有刪除任何資料。")),
    },
  ];
  registry.register(
    commandSpec("admin memory wipe", "清除她的記憶資料（限擁有者，刪除前會先備份）", {
      permission: NODE_WIPE,
      ephemeral: true,
    }),
    () => handler.wipeStart(),
    { components: wipeRoutes },
  );
}

/**
 * Remembers which registry the commands went into, so they can be removed on stop and
 * re-registered when the `commands` module provides a different registry.
 */
export class MemoryCommands {
  #installed: CommandRegistry | null = null;

  /** Registers the commands in `registry` unless already there. */
  install(registry: CommandRegistry, engine: MemoryEngine, deps: MemoryCommandDeps): void {
    if (this.#installed === registry) return;
    if (this.#installed !== null) {
      unregister(this.#installed);
      this.#installed = null;
    }
    const handler = new Handler(engine, deps);
    try {
      register(registry, handler);
      this.#installed = registry;
    } catch (error) {
      log.warn({ error: errorMessage(error) }, "could not register memory commands");
      unregister(registry);
    }
  }

  uninstall(): void {
    if (this.#installed !== null) {
      unregister(this.#installed);
      this.#installed = null;
    }
  }
}
