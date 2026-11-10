// Her workspace and her skills (docs/design/v4-plan.md §8.3 items 2 and 3), read-only:
//
// * `GET /api/workspace`: the files in her persistent workspace with their sizes, what is used
//   against the quotas.
// * `GET /api/skills`: the skill index (name and one-line description).
// * `GET /api/skills/{name}`: one skill's body and the files beside it (scripts say whether they
//   are approved to run).
//
// The files are the sandbox module's workspace; the skills are read through `SkillShelfKey`, which
// the skills module provides (so the file layout and the cleaning of a skill's text stay its
// business). Without the sandbox module, or with its workspace off, the files are a 503 that says
// which; without the skills module, so are the skills. Everything shown is text a program or she
// may have written: it is data for a person to read, never instructions.

import { SandboxKey, type WorkspaceApi } from "@miyoria/sandbox";
import { type SkillShelf, SkillShelfKey, type SkillShelfPage } from "@miyoria/types";
import { ApiError } from "./errors.js";
import { json, param, type Route } from "./route.js";
import type { ApiState } from "./state.js";

/** Most characters of one skill's body shown. */
export const MAX_BODY_CHARS = 20_000;
/** Pages of a body read at most (a page is the store's `read_chars`). */
const MAX_PAGES = 50;
/** Most files listed in one answer. */
const MAX_FILES = 2_000;

export interface WorkspaceFileView {
  path: string;
  size: number;
}

export interface WorkspaceView {
  files: WorkspaceFileView[];
  /** The listing was cut (more files than it reads). */
  truncated: boolean;
  usage: { files: number; bytes: number; overflow: boolean };
  limits: { max_bytes: number; max_files: number; max_file_bytes: number };
}

export interface SkillSummaryView {
  name: string;
  description: string;
}

export interface SkillFileView extends WorkspaceFileView {
  /** `approved`: reviewed and unchanged, so she can run it; `unapproved`: not (a program wrote it). */
  script: "approved" | "unapproved" | null;
}

export interface SkillView extends SkillSummaryView {
  body: string;
  /** The body was cut at `MAX_BODY_CHARS`. */
  truncated: boolean;
  files: SkillFileView[];
}

function workspace(state: ApiState): WorkspaceApi {
  const sandbox = state.service(SandboxKey, "sandbox module (her workspace)");
  const ws = sandbox.workspace;
  if (ws === null) throw ApiError.unavailable("her workspace is turned off");
  return ws;
}

async function files(state: ApiState): Promise<Response> {
  const ws = workspace(state);
  const [listing, usage] = await Promise.all([ws.list(), ws.usage()]);
  const sorted = [...listing.entries].sort((a, b) => a.path.localeCompare(b.path));
  const view: WorkspaceView = {
    files: sorted.slice(0, MAX_FILES).map((e) => ({ path: e.path, size: e.size })),
    truncated: listing.truncated || sorted.length > MAX_FILES,
    usage: { files: usage.files, bytes: usage.bytes, overflow: usage.overflow },
    limits: {
      max_bytes: ws.limits.maxBytes,
      max_files: ws.limits.maxFiles,
      max_file_bytes: ws.limits.maxFileBytes,
    },
  };
  return json(view);
}

function shelf(state: ApiState): SkillShelf {
  return state.service(SkillShelfKey, "skills module (needs the sandbox workspace)");
}

async function skillList(state: ApiState): Promise<Response> {
  const { skills } = await shelf(state).list();
  return json({ skills: skills.map((s) => ({ name: s.name, description: s.description })) });
}

async function skillShow(state: ApiState, name: string): Promise<Response> {
  const skills = shelf(state);
  const pages: string[] = [];
  let first: SkillShelfPage | null = null;
  let offset = 0;
  let cut = false;
  try {
    for (let guard = 0; guard < MAX_PAGES; guard++) {
      const page = await skills.read(name, offset);
      first ??= page;
      pages.push(page.text);
      if (page.truncated) cut = true;
      if (page.next_offset === null) break;
      offset = page.next_offset;
      if (offset >= MAX_BODY_CHARS) {
        cut = true;
        break;
      }
    }
  } catch (error) {
    const kind = (error as { kind?: string }).kind;
    if (kind === "not_found" || kind === "invalid") {
      throw ApiError.notFound(`no skill \`${name.slice(0, 60)}\``);
    }
    throw error;
  }
  if (first === null) throw ApiError.notFound(`no skill \`${name.slice(0, 60)}\``);
  const body = [...pages.join("")].slice(0, MAX_BODY_CHARS).join("");
  const view: SkillView = {
    name,
    description: first.description,
    body,
    truncated: cut || [...pages.join("")].length > MAX_BODY_CHARS,
    files: first.files.map((f) => ({ path: f.path, size: f.size, script: f.script })),
  };
  return json(view);
}

export function workspaceRoutes(state: ApiState): Route[] {
  return [
    { method: "GET", path: "/api/workspace", handler: () => files(state) },
    { method: "GET", path: "/api/skills", handler: () => skillList(state) },
    {
      method: "GET",
      path: "/api/skills/:name",
      handler: (c) => skillShow(state, param(c, "name")),
    },
  ];
}
