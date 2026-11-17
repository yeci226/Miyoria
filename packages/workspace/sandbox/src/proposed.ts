// Tools she writes herself (`tool.propose`). A proposal is stored as `pending`; a reviewer (her
// own review call or a human, decided by the gate in phase A) approves or rejects one exact
// version; only an approved tool can be invoked, and it still runs in the sandbox with its
// arguments as JSON on stdin. Re-proposing a name replaces the code and needs a new approval.

import { createHash } from "node:crypto";
import type { SettingsStore } from "@miyoria/store";
import {
  type Clock,
  Events,
  type JsonObject,
  type JsonValue,
  type ProfileId,
  serviceKey,
  systemClock,
  type Timestamp,
  toTimestamp,
} from "@miyoria/types";
import { z } from "zod";
import { checkName } from "./paths.js";
import type { SandboxPublisher } from "./sandbox.js";
import {
  type Language,
  LanguageSchema,
  type RunResult,
  type Sandbox,
  SandboxError,
} from "./types.js";

/** Settings key prefix of the proposed tools (one key per tool). */
export const TOOL_KEY_PREFIX = "sandbox:tool:";

export type ProposedToolStatus = "pending" | "approved" | "rejected";

/** A tool she wrote (persisted; JSON shape is a contract). */
export interface ProposedTool {
  name: string;
  description: string;
  language: Language;
  code: string;
  /** JSON Schema of the arguments (an object schema), as shown to the model later. */
  args_schema: JsonObject;
  status: ProposedToolStatus;
  /** Bumped on every (re-)proposal; approval names the version it approves. */
  version: number;
  /** sha256 of `code` (hex). */
  code_sha256: string;
  /** Who proposed it (`self`, or a requester id from the gate). */
  proposed_by: string | null;
  /** Who approved / rejected it. */
  reviewer: string | null;
  review_note: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  reviewed_at: Timestamp | null;
}

const ProposedToolSchema = z.object({
  name: z.string(),
  description: z.string(),
  language: LanguageSchema,
  code: z.string(),
  args_schema: z.record(z.string(), z.json()),
  status: z.enum(["pending", "approved", "rejected"]),
  version: z.number().int(),
  code_sha256: z.string(),
  proposed_by: z.string().nullable(),
  reviewer: z.string().nullable(),
  review_note: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  reviewed_at: z.string().nullable(),
});

/** What `tool.propose` takes (also the model-facing argument schema of that capability). */
export const ToolProposalSchema = z.object({
  name: z.string().describe("Tool name: lowercase letters, digits, `_` or `-`, max 48"),
  description: z.string().min(1).max(1000).describe("What the tool does, for whoever uses it"),
  language: LanguageSchema,
  code: z.string().min(1).describe("Program; reads its arguments as JSON from stdin"),
  args_schema: z
    .record(z.string(), z.json())
    .describe("JSON Schema (type object) of the arguments"),
});
export type ToolProposal = z.output<typeof ToolProposalSchema>;

/** Largest accepted argument schema / invocation arguments, in bytes of JSON. */
export const MAX_SCHEMA_BYTES = 16 * 1024;
export const MAX_ARGS_BYTES = 64 * 1024;

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Checks an argument schema: a JSON Schema of `type: "object"` that zod can evaluate. */
export function compileArgsSchema(schema: JsonObject): z.ZodType {
  if (JSON.stringify(schema).length > MAX_SCHEMA_BYTES) {
    throw new SandboxError("invalid_request", `args_schema is over ${MAX_SCHEMA_BYTES} bytes`);
  }
  if (schema.type !== "object") {
    throw new SandboxError("invalid_request", 'args_schema must have `"type": "object"`');
  }
  try {
    return z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);
  } catch (error) {
    throw new SandboxError("invalid_request", "args_schema is not a supported JSON Schema", {
      cause: error,
    });
  }
}

export interface ProposedToolsOptions {
  store: SettingsStore;
  profile: ProfileId;
  /** Needed by `invoke` only. */
  sandbox: Sandbox | null;
  clock?: Clock;
  publisher?: SandboxPublisher;
  maxTools: number;
  maxCodeBytes: number;
}

/** A tool spec for the registry (phase A registers approved tools as LLM tools). */
export interface ApprovedToolSpec {
  name: string;
  description: string;
  parameters: JsonObject;
  version: number;
}

/** Store and lifecycle of proposed tools. Provided as `ProposedToolsKey` by module `sandbox`. */
export class ProposedTools {
  readonly #o: ProposedToolsOptions;
  readonly #clock: Clock;

  constructor(options: ProposedToolsOptions) {
    this.#o = options;
    this.#clock = options.clock ?? systemClock;
  }

  #key(name: string): string {
    return `${TOOL_KEY_PREFIX}${checkName(name)}`;
  }

  async #save(tool: ProposedTool): Promise<void> {
    await this.#o.store.set(this.#o.profile, this.#key(tool.name), tool as unknown as JsonValue);
  }

  #publish(
    definition: typeof Events.SandboxToolProposed | typeof Events.SandboxToolReviewed,
    tool: ProposedTool,
  ): void {
    this.#o.publisher?.(definition, {
      name: tool.name,
      version: tool.version,
      status: tool.status,
      language: tool.language,
      code_sha256: tool.code_sha256,
      proposed_by: tool.proposed_by,
      reviewer: tool.reviewer,
    });
  }

  async get(name: string): Promise<ProposedTool | null> {
    const raw = await this.#o.store.get(this.#o.profile, this.#key(name));
    if (raw === null) return null;
    const parsed = ProposedToolSchema.safeParse(raw);
    return parsed.success ? (parsed.data as ProposedTool) : null;
  }

  /** Every stored tool (optionally of one status), by name. */
  async list(filter: { status?: ProposedToolStatus } = {}): Promise<ProposedTool[]> {
    const rows = await this.#o.store.list(this.#o.profile, TOOL_KEY_PREFIX);
    const out: ProposedTool[] = [];
    for (const raw of rows.values()) {
      const parsed = ProposedToolSchema.safeParse(raw);
      if (!parsed.success) continue;
      if (filter.status === undefined || parsed.data.status === filter.status) {
        out.push(parsed.data as ProposedTool);
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Stores a proposal as `pending` (new, or a new version of an existing tool, which drops any
   * earlier approval). Throws `SandboxError` for bad names, schemas, sizes or the tool limit.
   */
  async propose(input: ToolProposal, proposedBy: string | null = null): Promise<ProposedTool> {
    const parsed = ToolProposalSchema.safeParse(input);
    if (!parsed.success) {
      throw new SandboxError("invalid_request", `invalid proposal: ${parsed.error.message}`);
    }
    const p = parsed.data;
    checkName(p.name);
    if (Buffer.byteLength(p.code, "utf8") > this.#o.maxCodeBytes) {
      throw new SandboxError("invalid_request", `code is over ${this.#o.maxCodeBytes} bytes`);
    }
    compileArgsSchema(p.args_schema as JsonObject);
    const existing = await this.get(p.name);
    if (!existing && (await this.list()).length >= this.#o.maxTools) {
      throw new SandboxError("limit", `at most ${this.#o.maxTools} proposed tools`);
    }
    const now = toTimestamp(this.#clock.now());
    const tool: ProposedTool = {
      name: p.name,
      description: p.description,
      language: p.language,
      code: p.code,
      args_schema: p.args_schema as JsonObject,
      status: "pending",
      version: (existing?.version ?? 0) + 1,
      code_sha256: sha256(p.code),
      proposed_by: proposedBy,
      reviewer: null,
      review_note: null,
      created_at: existing?.created_at ?? now,
      updated_at: now,
      reviewed_at: null,
    };
    await this.#save(tool);
    this.#publish(Events.SandboxToolProposed, tool);
    return tool;
  }

  async #review(
    name: string,
    status: "approved" | "rejected",
    review: { reviewer: string; version: number; note?: string | null },
  ): Promise<ProposedTool> {
    const tool = await this.get(name);
    if (!tool) throw new SandboxError("not_found", `no proposed tool \`${name}\``);
    if (tool.status !== "pending") {
      throw new SandboxError("wrong_state", `tool \`${name}\` is ${tool.status}, not pending`);
    }
    // The reviewer saw one version; a re-proposal in the meantime must not ride on it.
    if (tool.version !== review.version) {
      throw new SandboxError(
        "wrong_state",
        `tool \`${name}\` is at version ${tool.version}, not ${review.version}`,
      );
    }
    const now = toTimestamp(this.#clock.now());
    const next: ProposedTool = {
      ...tool,
      status,
      reviewer: review.reviewer,
      review_note: review.note ?? null,
      reviewed_at: now,
      updated_at: now,
    };
    await this.#save(next);
    this.#publish(Events.SandboxToolReviewed, next);
    return next;
  }

  /** `pending` → `approved`, for exactly `version`. */
  approve(
    name: string,
    review: { reviewer: string; version: number; note?: string | null },
  ): Promise<ProposedTool> {
    return this.#review(name, "approved", review);
  }

  /** `pending` → `rejected`, for exactly `version`. */
  reject(
    name: string,
    review: { reviewer: string; version: number; note?: string | null },
  ): Promise<ProposedTool> {
    return this.#review(name, "rejected", review);
  }

  /** Deletes a tool in any state. */
  async remove(name: string): Promise<boolean> {
    const tool = await this.get(name);
    if (!tool) return false;
    await this.#o.store.set(this.#o.profile, this.#key(name), null);
    this.#o.publisher?.(Events.SandboxToolRemoved, { name, version: tool.version });
    return true;
  }

  /** Approved tools as registry specs (name, description, JSON Schema). */
  async approvedSpecs(): Promise<ApprovedToolSpec[]> {
    return (await this.list({ status: "approved" })).map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.args_schema,
      version: t.version,
    }));
  }

  /**
   * Runs an approved tool in the sandbox: arguments are validated against its schema and passed
   * as JSON on stdin. Throws `SandboxError` (`not_found`, `wrong_state`, `invalid_request`,
   * `unavailable`, ...).
   */
  async invoke(
    name: string,
    args: JsonValue,
    options: { timeout_ms?: number; signal?: AbortSignal } = {},
  ): Promise<RunResult> {
    const tool = await this.get(name);
    if (!tool) throw new SandboxError("not_found", `no proposed tool \`${name}\``);
    if (tool.status !== "approved") {
      throw new SandboxError("wrong_state", `tool \`${name}\` is ${tool.status}, not approved`);
    }
    if (sha256(tool.code) !== tool.code_sha256) {
      throw new SandboxError("wrong_state", `tool \`${name}\` code does not match its approval`);
    }
    const stdin = JSON.stringify(args ?? {});
    if (Buffer.byteLength(stdin, "utf8") > MAX_ARGS_BYTES) {
      throw new SandboxError("invalid_request", `arguments are over ${MAX_ARGS_BYTES} bytes`);
    }
    const checked = compileArgsSchema(tool.args_schema).safeParse(args);
    if (!checked.success) {
      throw new SandboxError("invalid_request", `invalid arguments: ${checked.error.message}`);
    }
    const sandbox = this.#o.sandbox;
    if (!sandbox) throw new SandboxError("unavailable", "the sandbox is not running");
    return sandbox.run(
      {
        language: tool.language,
        code: tool.code,
        stdin,
        network: "none",
        ...(options.timeout_ms === undefined ? {} : { timeout_ms: options.timeout_ms }),
      },
      options.signal ? { signal: options.signal } : {},
    );
  }
}

export const ProposedToolsKey = serviceKey<ProposedTools>("ProposedTools");
