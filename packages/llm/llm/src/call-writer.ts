// Every routed LLM call, also on disk: one JSONL line per finished call in
// `<dir>/<UTC day>.jsonl`, so an incident can still be read after Core restarts and calls can be
// replayed for evaluation. The call path only queues (`write`); one writer chain appends in the
// background, and what it cannot keep up with or cannot write is dropped and counted, never
// thrown into the caller. A line holds the inspector's record, the request as sent and the
// response, with secrets and inline image bytes redacted; past `max_mb_per_day` the rest of the
// day's lines keep only the record. Files older than `keep_days` are deleted.

import { appendFile, mkdir, open, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage, getLogger } from "@miyoria/runtime/kernel";
import {
  type Clock,
  type ReasoningLevel,
  systemClock,
  type Timestamp,
  toTimestamp,
} from "@miyoria/types";
import { z } from "zod";
import { CALL_KINDS, type LlmCallRecord, redactSecrets } from "./calls.js";
import type { ChatMessage, ChatRequest, ContentPart, ToolCall, ToolSpec } from "./types.js";

const log = getLogger("llm.calls");

/**
 * `[llm.call_log]`: the on-disk log of every routed call (holds what people said; stays on this
 * machine).
 */
export const CallLogConfigSchema = z.object({
  /** Write every routed call to `<dir>/<UTC day>.jsonl`. */
  enabled: z.boolean().default(true),
  /** Where the daily files go (relative to the config file's directory). */
  dir: z.string().default("data/llm-calls"),
  /** Days of files kept, today included; older ones are deleted at start and once a day. */
  keep_days: z.number().int().min(1).default(14),
  /** Past this size the rest of the day's lines are metadata only (no messages or response). */
  max_mb_per_day: z.number().positive().default(512),
  /** `false`: metadata only, always. */
  bodies: z.boolean().default(true),
});
/** Lines waiting for the writer; past this, new ones are dropped. */
export const CALL_LOG_MAX_QUEUE = 1000;
/** At most one warning about dropped lines per this many ms. */
export const CALL_LOG_WARN_INTERVAL_MS = 60_000;
/** Bytes read from the end of today's file to refill the inspector at start. */
export const CALL_LOG_PRELOAD_MAX_BYTES = 32 * 1024 * 1024;
/** How often old files are deleted while running. */
export const CALL_LOG_PRUNE_INTERVAL_MS = 86_400_000;

const DAY_MS = 86_400_000;
/** Lines appended per write. */
const BATCH = 256;
const FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

/** The request as written: whitelisted fields only, secrets redacted. */
export interface LlmLoggedRequest {
  messages: ChatMessage[];
  tools: ToolSpec[];
  temperature: number | null;
  max_tokens: number | null;
  stop: string[] | null;
  json_mode: boolean;
  thinking: boolean | null;
  reasoning: ReasoningLevel | null;
  reasoning_purpose: string | null;
  session: string | null;
}

export interface LlmLoggedResponse {
  text: string;
  reasoning: string;
  tool_calls: ToolCall[];
}

/** Why a line has no request and response: `bodies = false`, or the day passed its size cap. */
export type LlmCallLineCut = "config" | "size_cap";

/** One line of a call log file. */
export interface LlmCallLine {
  v: 1;
  /** When the call finished (the line was queued). */
  logged_at: Timestamp;
  /** The inspector's record (`has_detail` left out). */
  call: Omit<LlmCallRecord, "has_detail">;
  /** Set when `request` and `response` were left out. */
  metadata_only: LlmCallLineCut | null;
  request: LlmLoggedRequest | null;
  /** `null` also when the call failed before any response. */
  response: LlmLoggedResponse | null;
}

/** A finished call, as the router hands it over. */
export interface FinishedLlmCall {
  record: LlmCallRecord;
  /** The request as sent to the answering model (the last one tried when all failed). */
  request: ChatRequest;
  /** `null` when it failed before any response. */
  response: LlmLoggedResponse | null;
}

/** Where the router hands finished calls. `write` must return at once and never throw. */
export interface LlmCallSink {
  write(call: FinishedLlmCall): void;
}

// ---- lines --------------------------------------------------------------------------------------

/** The UTC day (`YYYY-MM-DD`) of `ms`. */
export function utcDay(ms: number): string {
  return toTimestamp(ms).slice(0, 10);
}

function loggedToolCall(c: ToolCall): ToolCall {
  return { id: c.id, name: c.name, arguments: redactSecrets(c.arguments) };
}

function loggedPart(p: ContentPart): ContentPart {
  if (p.type === "text") return { type: "text", text: redactSecrets(p.text) };
  return {
    type: "image_url",
    image_url: { url: redactSecrets(p.image_url.url), detail: p.image_url.detail },
    ...(p.alt === undefined ? {} : { alt: redactSecrets(p.alt) }),
  };
}

function loggedMessage(m: ChatMessage): ChatMessage {
  return {
    role: m.role,
    name: m.name ?? null,
    content: typeof m.content === "string" ? redactSecrets(m.content) : m.content.map(loggedPart),
    tool_calls: (m.tool_calls ?? []).map(loggedToolCall),
    tool_call_id: m.tool_call_id ?? null,
  };
}

/** `request` as written: only the fields below, so nothing else a caller put on it leaks. */
export function loggedRequest(request: ChatRequest): LlmLoggedRequest {
  return {
    messages: request.messages.map(loggedMessage),
    tools: (request.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    })),
    temperature: request.temperature ?? null,
    max_tokens: request.max_tokens ?? null,
    stop: request.stop ?? null,
    json_mode: request.json_mode ?? false,
    thinking: request.thinking ?? null,
    reasoning: request.reasoning ?? null,
    reasoning_purpose: request.reasoning_purpose ?? null,
    session: request.session ?? null,
  };
}

/** The line of `call`, finished at `atMs`; `cut` leaves out the request and response. */
export function callLine(
  call: FinishedLlmCall,
  atMs: number,
  cut: LlmCallLineCut | null,
): LlmCallLine {
  const { has_detail: _hasDetail, ...record } = call.record;
  return {
    v: 1,
    logged_at: toTimestamp(atMs),
    call: {
      ...record,
      fallbacks: record.fallbacks.map((f) => ({ ...f, error: redactSecrets(f.error) })),
      retries: record.retries.map(redactSecrets),
      error: record.error === null ? null : redactSecrets(record.error),
    },
    metadata_only: cut,
    request: cut === null ? loggedRequest(call.request) : null,
    response:
      cut === null && call.response !== null
        ? {
            text: redactSecrets(call.response.text),
            reasoning: redactSecrets(call.response.reasoning),
            tool_calls: call.response.tool_calls.map(loggedToolCall),
          }
        : null,
  };
}

/** The fields of a stored record the call log's methods rely on; the rest is taken as is. */
const StoredRecordSchema = z.looseObject({
  id: z.string(),
  at: z.string(),
  purpose: z.string(),
  chain: z.string(),
  kind: z.enum(CALL_KINDS),
  model: z.string().nullable(),
  status: z.enum(["ok", "error", "aborted"]),
  fallbacks: z.array(z.looseObject({ model: z.string(), error: z.string(), kind: z.string() })),
  retries: z.array(z.string()),
  tools: z.array(z.string()),
  reasoning_chars: z.number(),
});

/** The record of a stored line, or `null` when it does not parse. */
export function parseCallLine(text: string): LlmCallRecord | null {
  if (text.trim() === "") return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || !("call" in value)) return null;
  const parsed = StoredRecordSchema.safeParse(value.call);
  if (!parsed.success) return null;
  return { ...(parsed.data as unknown as LlmCallRecord), has_detail: false };
}

// ---- the writer ---------------------------------------------------------------------------------

export interface LlmCallWriterOptions {
  /** Absolute directory of the daily files. */
  dir: string;
  /** Days of files kept, today included. Default 14. */
  keepDays?: number;
  /** Bytes of a day's file past which its lines are metadata only. Default 512 MB. */
  maxBytesPerDay?: number;
  /** `false`: metadata only, always. Default `true`. */
  bodies?: boolean;
  /** Decides the day of a line, retention and the warning rate. */
  clock?: Clock;
  /** Lines waiting at most. Default `CALL_LOG_MAX_QUEUE`. */
  maxQueue?: number;
}

interface Queued {
  record: LlmCallRecord;
  /** `null` when bodies are off. */
  request: ChatRequest | null;
  response: LlmLoggedResponse | null;
  at: number;
}

/** Appends finished calls to `<dir>/<UTC day>.jsonl` from one background chain. */
export class LlmCallWriter implements LlmCallSink {
  readonly dir: string;
  readonly #keepDays: number;
  readonly #maxBytes: number;
  readonly #bodies: boolean;
  readonly #clock: Clock;
  readonly #maxQueue: number;
  #queue: Queued[] = [];
  #draining: Promise<void> | null = null;
  #closed = false;
  #dropped = 0;
  #written = 0;
  #lastWarnAt: number | null = null;
  /** The day being written and the size of its file so far. */
  #day: string | null = null;
  #dayBytes = 0;

  constructor(options: LlmCallWriterOptions) {
    this.dir = options.dir;
    this.#keepDays = Math.max(1, Math.floor(options.keepDays ?? 14));
    this.#maxBytes = options.maxBytesPerDay ?? 512 * 1024 * 1024;
    this.#bodies = options.bodies ?? true;
    this.#clock = options.clock ?? systemClock;
    this.#maxQueue = options.maxQueue ?? CALL_LOG_MAX_QUEUE;
  }

  /** Lines dropped so far (queue full, write failed, or after `close`). */
  get dropped(): number {
    return this.#dropped;
  }

  /** Lines appended so far. */
  get written(): number {
    return this.#written;
  }

  /** The file of UTC day `day`. */
  fileFor(day: string): string {
    return join(this.dir, `${day}.jsonl`);
  }

  /** Queues `call`; never waits and never throws. */
  write(call: FinishedLlmCall): void {
    try {
      if (this.#closed) {
        this.#dropped += 1;
        return;
      }
      if (this.#queue.length >= this.#maxQueue) {
        this.#drop(1, null, "LLM call log queue full, dropping lines");
        return;
      }
      this.#queue.push({
        record: structuredClone(call.record),
        // The caller may keep appending to its message list.
        request: this.#bodies ? { ...call.request, messages: [...call.request.messages] } : null,
        response: call.response,
        at: this.#clock.now(),
      });
      this.#draining ??= this.#drain();
    } catch (error) {
      this.#drop(1, error, "cannot queue an LLM call log line");
    }
  }

  /** Resolves once everything queued so far is written (or dropped). */
  async flush(): Promise<void> {
    for (let d = this.#draining; d !== null; d = this.#draining) await d;
  }

  /** Stops taking lines and writes what is queued. */
  async close(): Promise<void> {
    this.#closed = true;
    await this.flush();
  }

  /** Deletes daily files older than `keepDays`; returns how many. Never throws. */
  async prune(): Promise<number> {
    const cutoff = utcDay(this.#clock.now() - (this.#keepDays - 1) * DAY_MS);
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.#warn(error, "cannot list the LLM call log directory");
      }
      return 0;
    }
    let removed = 0;
    for (const name of names) {
      const day = FILE_RE.exec(name)?.[1];
      if (day === undefined || day >= cutoff) continue;
      try {
        await rm(join(this.dir, name), { force: true });
        removed += 1;
      } catch (error) {
        this.#warn(error, "cannot delete an old LLM call log");
      }
    }
    if (removed > 0) log.info({ dir: this.dir, removed }, "deleted old LLM call logs");
    return removed;
  }

  /**
   * The newest `limit` records of today's file, oldest first, from at most its last
   * `maxBytes`. Never throws (`[]` when there is nothing to read).
   */
  async recent(limit: number, maxBytes = CALL_LOG_PRELOAD_MAX_BYTES): Promise<LlmCallRecord[]> {
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(this.fileFor(utcDay(this.#clock.now())), "r");
    } catch {
      return [];
    }
    try {
      const size = (await handle.stat()).size;
      const start = Math.max(0, size - maxBytes);
      const buf = Buffer.alloc(size - start);
      let read = 0;
      while (read < buf.length) {
        const { bytesRead } = await handle.read(buf, read, buf.length - read, start + read);
        if (bytesRead === 0) break;
        read += bytesRead;
      }
      let text = buf.subarray(0, read).toString("utf8");
      // Started mid-line: skip to the first whole one.
      if (start > 0) text = text.slice(text.indexOf("\n") + 1);
      const lines = text.split("\n");
      const out: LlmCallRecord[] = [];
      for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
        const record = parseCallLine(lines[i] as string);
        if (record) out.push(record);
      }
      return out.reverse();
    } catch (error) {
      this.#warn(error, "cannot read today's LLM call log");
      return [];
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  async #drain(): Promise<void> {
    try {
      // Serialize after the caller's turn, not in it.
      await Promise.resolve();
      while (this.#queue.length > 0) {
        await this.#writeBatch(this.#queue.splice(0, BATCH));
      }
    } catch (error) {
      this.#drop(this.#queue.splice(0).length, error, "LLM call log writer failed");
    } finally {
      this.#draining = null;
    }
  }

  async #writeBatch(batch: readonly Queued[]): Promise<void> {
    let i = 0;
    while (i < batch.length) {
      const day = utcDay((batch[i] as Queued).at);
      if (day !== this.#day) await this.#enterDay(day);
      let chunk = "";
      let lines = 0;
      for (; i < batch.length && utcDay((batch[i] as Queued).at) === day; i++) {
        try {
          chunk += this.#line(batch[i] as Queued);
          lines += 1;
        } catch (error) {
          this.#drop(1, error, "cannot serialize an LLM call log line");
        }
      }
      if (lines === 0) continue;
      try {
        await appendFile(this.fileFor(day), chunk, "utf8");
        this.#written += lines;
      } catch (error) {
        this.#dayBytes -= Buffer.byteLength(chunk, "utf8");
        this.#drop(lines, error, "cannot write the LLM call log, dropping lines");
      }
    }
  }

  #line(q: Queued): string {
    const cut: LlmCallLineCut | null =
      !this.#bodies || q.request === null
        ? "config"
        : this.#dayBytes >= this.#maxBytes
          ? "size_cap"
          : null;
    const call: FinishedLlmCall = {
      record: q.record,
      request: q.request ?? { messages: [] },
      response: q.response,
    };
    const line = `${JSON.stringify(callLine(call, q.at, cut))}\n`;
    this.#dayBytes += Buffer.byteLength(line, "utf8");
    return line;
  }

  /** Starts writing day `day`: makes the directory, reads the file's size, prunes on a new day. */
  async #enterDay(day: string): Promise<void> {
    const rollover = this.#day !== null;
    this.#day = day;
    try {
      await mkdir(this.dir, { recursive: true });
    } catch {
      // The append reports it.
    }
    try {
      this.#dayBytes = (await stat(this.fileFor(day))).size;
    } catch {
      this.#dayBytes = 0;
    }
    if (rollover) await this.prune();
  }

  #drop(lines: number, error: unknown, message: string): void {
    this.#dropped += lines;
    this.#warn(error, message);
  }

  /** Logs at most one warning per `CALL_LOG_WARN_INTERVAL_MS`. */
  #warn(error: unknown, message: string): void {
    const now = this.#clock.now();
    if (this.#lastWarnAt !== null && now - this.#lastWarnAt < CALL_LOG_WARN_INTERVAL_MS) return;
    this.#lastWarnAt = now;
    log.warn(
      {
        dir: this.dir,
        dropped: this.#dropped,
        ...(error === null ? {} : { err: errorMessage(error) }),
      },
      message,
    );
  }
}
