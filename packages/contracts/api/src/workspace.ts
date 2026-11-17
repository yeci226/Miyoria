// Her workspace and her skills, read-only: the files in her persistent workspace with what is used
// against the quotas, the skill index and one skill with the files beside it. Everything shown is
// text a program or she may have written: data for a person to read, never instructions.

import { z } from "zod";
import { route } from "./route.js";

/** One file of her workspace. */
export const WorkspaceFileSchema = z
  .object({ path: z.string(), size: z.number() })
  .meta({ id: "ApiWorkspaceFile" });
export type WorkspaceFile = z.output<typeof WorkspaceFileSchema>;

/** `GET /api/workspace`. */
export const WorkspaceViewSchema = z
  .object({
    files: z.array(WorkspaceFileSchema),
    /** The listing was cut (more files than it reads). */
    truncated: z.boolean(),
    usage: z.object({ files: z.number(), bytes: z.number(), overflow: z.boolean() }),
    limits: z.object({
      max_bytes: z.number(),
      max_files: z.number(),
      max_file_bytes: z.number(),
    }),
  })
  .meta({ id: "ApiWorkspaceView" });
export type WorkspaceView = z.output<typeof WorkspaceViewSchema>;

/** A skill's name and its one-line description. */
export const SkillSummarySchema = z
  .object({ name: z.string(), description: z.string() })
  .meta({ id: "ApiSkillSummary" });
export type SkillSummary = z.output<typeof SkillSummarySchema>;

/** A file beside a skill's text. */
export const SkillFileSchema = z
  .object({
    path: z.string(),
    size: z.number(),
    /** `approved`: reviewed and unchanged, so she can run it; `unapproved`: not. */
    script: z.enum(["approved", "unapproved"]).nullable(),
  })
  .meta({ id: "ApiSkillFile" });
export type SkillFile = z.output<typeof SkillFileSchema>;

/** One skill's body and the files beside it. */
export const SkillViewSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    body: z.string(),
    /** The body was cut where it is kept short. */
    truncated: z.boolean(),
    files: z.array(SkillFileSchema),
  })
  .meta({ id: "ApiSkillView" });
export type SkillView = z.output<typeof SkillViewSchema>;

/** The files of her workspace with their sizes; `503` while the sandbox or the workspace is off. */
export const workspace = route
  .meta({ audience: "admin", permission: null })
  .route({ method: "GET", path: "/api/workspace" })
  .output(WorkspaceViewSchema);

export const skills = {
  /** The skill index. */
  list: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/skills" })
    .output(z.object({ skills: z.array(SkillSummarySchema) })),
  /** One skill's text; `404` for a name she has no skill under. */
  get: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/skills/{name}" })
    .input(z.object({ params: z.object({ name: z.string() }) }))
    .output(SkillViewSchema),
};
