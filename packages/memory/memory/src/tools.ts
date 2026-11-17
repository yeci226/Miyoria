// Model tools `remember` and `recall`.

import {
  type Tool,
  type ToolContext,
  type ToolMeta,
  type ToolSpec,
  toolParameters,
} from "@miyoria/llm/tools";
import type { MemoryKind } from "@miyoria/store";
import {
  type Clock,
  isJsonObject,
  type JsonValue,
  type PersonId,
  systemClock,
  toTimestamp,
} from "@miyoria/types";
import { z } from "zod";
import { formatLines, PROMPT_KINDS } from "./contributor.js";
import type { MemoryEngine } from "./engine.js";
import { LINE_REF_PREFIX, nameWords, supporting } from "./evidence.js";
import type { NotesRecall } from "./notes-recall.js";
import { noteAbout, scopeForNew, visibleScopes } from "./scope.js";

export const REMEMBER = "remember";
export const RECALL = "recall";

export class MemoryToolError extends Error {
  override readonly name = "MemoryToolError";
}

function arg(args: JsonValue, key: string): JsonValue | undefined {
  return isJsonObject(args) ? args[key] : undefined;
}

function requiredString(args: JsonValue, key: string): string {
  const v = arg(args, key);
  const s = typeof v === "string" ? v.trim() : "";
  if (s === "") throw new MemoryToolError(`\`${key}\` is required`);
  return s;
}

const RememberParams = z.object({
  content: z.string().describe("要記住的事,例如「Owen 下週三要考期末考」"),
  about: z.enum(["speaker", "self"]).describe("關於對方還是關於自己").optional(),
  importance: z.number().min(0).max(1).describe("重要程度 0~1").optional(),
  global: z
    .boolean()
    .describe("只有名字、希望怎麼被稱呼這類到哪都適用、不私密的事才設 true")
    .optional(),
});

/**
 * Saves a note about the current speaker or herself. The note records who said it
 * (`source`), so it is recalled as something that person said, not as a fact.
 */
export class RememberTool implements Tool {
  readonly spec: ToolSpec = {
    name: REMEMBER,
    description:
      "把一件值得長期記住的事記下來:關於正在跟你說話的人(about=speaker),或關於你自己的承諾、意見、經歷(about=self)。寫成日後單獨看也懂的一句話,包含名字。",
    parameters: toolParameters(RememberParams),
  };
  readonly parameters = RememberParams;
  readonly meta: ToolMeta = {
    effect: "act",
    speed: "instant",
    risk: "low",
    group: "memory",
    core: true,
  };
  readonly #engine: MemoryEngine;
  readonly #clock: Clock;

  constructor(engine: MemoryEngine, clock: Clock = systemClock) {
    this.#engine = engine;
    this.#clock = clock;
  }

  async call(ctx: ToolContext, args: JsonValue): Promise<string> {
    const content = requiredString(args, "content");
    const aboutSelf = arg(args, "about") === "self";
    const imp = arg(args, "importance");
    const importance = typeof imp === "number" ? Math.min(1, Math.max(0, imp)) : 0.6;
    const global = arg(args, "global") === true;

    const person = await this.#engine.personOf(ctx.account);
    // Who said it: read back as "X 說過…", never as a plain fact or an instruction.
    const name = (await this.#engine.nameOf(ctx.account)) ?? ctx.account.id;
    const kind: MemoryKind = aboutSelf ? "self_note" : "fact";
    let subjects: PersonId[] = aboutSelf || person === null ? [] : [person];
    const globalPerson = global && !aboutSelf ? person : null;
    // Something about her that someone told her in a server: global only when about her alone,
    // the person's when about them alone (the teller, say), else the server's.
    const about = aboutSelf
      ? noteAbout(
          content,
          [],
          [
            { name, person },
            ...(this.#engine.handles?.list() ?? []).map((h) => ({
              name: h.handle,
              person: h.person,
            })),
          ],
        )
      : undefined;
    const scope = scopeForNew(
      this.#engine.config,
      ctx.context,
      ctx.account,
      kind,
      globalPerson,
      about,
    );
    if (aboutSelf && scope.type === "person") subjects = [scope.person];
    const now = toTimestamp(this.#clock.now());

    // She was told it, so the telling has to be in the log: a note nobody said is not kept.
    // Without an EventLog there is nothing to check against, and the message that started the
    // turn is the evidence.
    const heard = await this.#engine.heard(ctx.context, ctx.account, now);
    let evidence: string[];
    if (heard === null) {
      evidence = [`${LINE_REF_PREFIX}${ctx.message.id}`];
    } else {
      const backing = supporting(content, heard, this.#engine.config.evidence, nameWords([name]));
      if (backing.length === 0) return "我沒有聽到有人這樣說過,所以沒有記下來。";
      evidence = backing.map((l) => l.ref);
    }
    const stored = await this.#engine.store(
      {
        kind,
        scope,
        subjects,
        content,
        importance,
        confidence: 0.9,
        source_context: ctx.context,
        source: { account: { ...ctx.account }, name },
        origin: "told",
        source_events: evidence,
        due: null,
      },
      now,
      ctx.signal,
    );
    switch (stored.type) {
      case "inserted":
        return "記住了。";
      case "reinforced":
        return "這件事我本來就記得,現在記得更牢了。";
      case "superseded":
        return "記住了(更新了之前記的內容)。";
      case "refused":
        return stored.reason === "present_state"
          ? "這是現在的狀態,不會記進長期記憶。"
          : "我沒有聽到有人這樣說過,所以沒有記下來。";
    }
  }
}

const RecallParams = z.object({
  query: z.string().describe("要想起什麼,例如「Owen 喜歡吃什麼」"),
  limit: z.int().min(1).max(20).optional(),
});

/** What `recall` answers when nothing came back. */
export const RECALL_NOTHING = "想不起來有關的事。";
/** Said after what `recall` found when none of it clearly stands out (`notes/src/precision.ts`). */
export const RECALL_WEAK = "(這幾則跟你要找的不一定有關,我不太確定。)";

/**
 * Searches memories visible in the current context: her notes and the records written since, once
 * the notes are the source (`NotesRecall`), the memory records before that.
 */
export class RecallTool implements Tool {
  /** Only marks what it found as recalled (access count), whatever the order. */
  readonly readOnly = true;
  readonly spec: ToolSpec = {
    name: RECALL,
    description: "在你的長期記憶裡搜尋跟某件事有關的回憶(只會找到這裡可以提的記憶)。",
    parameters: toolParameters(RecallParams),
  };
  readonly parameters = RecallParams;
  readonly meta: ToolMeta = {
    effect: "read",
    speed: "instant",
    risk: "low",
    group: "memory",
    core: true,
  };
  readonly #engine: MemoryEngine;
  readonly #clock: Clock;
  readonly #notes: NotesRecall | null;

  constructor(engine: MemoryEngine, clock: Clock = systemClock, notes: NotesRecall | null = null) {
    this.#engine = engine;
    this.#clock = clock;
    this.#notes = notes;
  }

  async call(ctx: ToolContext, args: JsonValue): Promise<string> {
    const query = requiredString(args, "query");
    const rawLimit = arg(args, "limit");
    const limit =
      typeof rawLimit === "number" && Number.isInteger(rawLimit) && rawLimit >= 0
        ? Math.min(20, Math.max(1, rawLimit))
        : this.#engine.config.recall_limit;
    const person = await this.#engine.personOf(ctx.account);
    const present = person === null ? [] : [person];
    const now = toTimestamp(this.#clock.now());
    if (this.#notes !== null) {
      const found = await this.#notes.recollect(
        { context: ctx.context, accounts: [ctx.account], present, text: query, limit, now },
        ctx.signal,
      );
      if (found.memories.length === 0) return RECALL_NOTHING;
      const body = this.#notes.format(found.memories, now);
      return found.weak ? `${body}\n${RECALL_WEAK}` : body;
    }
    const scopes = visibleScopes(ctx.context, [ctx.account], present);
    const recalled = await this.#engine.recall(
      scopes,
      present,
      query,
      PROMPT_KINDS,
      limit,
      now,
      ctx.signal,
    );
    if (recalled.length === 0) return RECALL_NOTHING;
    return formatLines(recalled, now);
  }
}
