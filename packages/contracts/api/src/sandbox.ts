// The tools she wrote (`tool.propose`), for the owners: the list with the sandbox's state, one
// tool with its code, and approving or rejecting one exact version. Approving and rejecting need
// the owners' approval node, the one the Discord approval card uses; the bearer token is the owner.

import { z } from "zod";
import { JsonObjectSchema, TimestampSchema } from "../../wire/src/index.js";
import { route } from "./route.js";

/** The node a review needs. */
const NODE_APPROVE = "owner.autonomy.approve";

export const ProposedToolStatusSchema = z
  .enum(["pending", "approved", "rejected"])
  .meta({ id: "ApiProposedToolStatus" });
export type ProposedToolStatus = z.output<typeof ProposedToolStatusSchema>;

/** A tool she wrote. */
export const ProposedToolSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    language: z.enum(["python", "node"]),
    code: z.string(),
    /** JSON Schema of the arguments (an object schema). */
    args_schema: JsonObjectSchema,
    status: ProposedToolStatusSchema,
    /** Bumped on every re-proposal; approval names the version it approves. */
    version: z.number(),
    /** sha256 of the code (hex). */
    code_sha256: z.string(),
    /** Who proposed it (`self`, or a requester id from the gate). */
    proposed_by: z.string().nullable(),
    /** Who approved or rejected it. */
    reviewer: z.string().nullable(),
    review_note: z.string().nullable(),
    created_at: TimestampSchema,
    updated_at: TimestampSchema,
    reviewed_at: TimestampSchema.nullable(),
  })
  .meta({ id: "ApiProposedTool" });
export type ProposedTool = z.output<typeof ProposedToolSchema>;

/** A tool without its code (the list's view, and what a review answers). */
export const ProposedToolSummarySchema = z
  .object({
    ...ProposedToolSchema.omit({ code: true }).shape,
    code_bytes: z.number(),
  })
  .meta({ id: "ApiProposedToolSummary" });
export type ProposedToolSummary = z.output<typeof ProposedToolSummarySchema>;

/** Whether Docker can be used. */
export const SandboxHealthSchema = z
  .object({
    available: z.boolean(),
    /** Docker server version when available. */
    server_version: z.string().nullable(),
    /** Why it is not available. */
    error: z.string().nullable(),
    /** Epoch ms of the check; `null` before the first one. */
    checked_at: z.number().nullable(),
  })
  .meta({ id: "ApiSandboxHealth" });
export type SandboxHealth = z.output<typeof SandboxHealthSchema>;

/** `GET /api/sandbox/tools`. */
export const SandboxToolsSchema = z
  .object({
    /** `null` while the sandbox module is not running. */
    sandbox: SandboxHealthSchema.nullable(),
    tools: z.array(ProposedToolSummarySchema),
  })
  .meta({ id: "ApiSandboxTools" });
export type SandboxTools = z.output<typeof SandboxToolsSchema>;

/** Body of an approval or a rejection. */
export const ReviewToolRequestSchema = z
  .object({
    /** The version the owner looked at (a re-proposal in the meantime makes this a conflict). */
    version: z.number().int().positive(),
    note: z.string().max(1000).nullish(),
  })
  .meta({ id: "ApiReviewToolRequest" });
export type ReviewToolRequest = z.input<typeof ReviewToolRequestSchema>;

const NameParams = z.object({ params: z.object({ name: z.string() }) });

export const sandbox = {
  /** The tools she wrote, without their code, and the sandbox's state. */
  tools: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/sandbox/tools" })
    .output(SandboxToolsSchema),
  /** One tool with its code; `404` for a tool she did not propose. */
  tool: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/sandbox/tools/{name}" })
    .input(NameParams)
    .output(ProposedToolSchema),
  /** Approves one exact version; `409` when it is not pending or the version moved on. */
  approve: route
    .meta({
      audience: "admin",
      permission: NODE_APPROVE,
      refusal: `reviewing her tools needs \`${NODE_APPROVE}\``,
    })
    .route({ method: "POST", path: "/api/sandbox/tools/{name}/approve" })
    .input(z.object({ ...NameParams.shape, body: ReviewToolRequestSchema }))
    .output(ProposedToolSummarySchema),
  /** Rejects one exact version; `409` when it is not pending or the version moved on. */
  reject: route
    .meta({
      audience: "admin",
      permission: NODE_APPROVE,
      refusal: `reviewing her tools needs \`${NODE_APPROVE}\``,
    })
    .route({ method: "POST", path: "/api/sandbox/tools/{name}/reject" })
    .input(z.object({ ...NameParams.shape, body: ReviewToolRequestSchema }))
    .output(ProposedToolSummarySchema),
};
