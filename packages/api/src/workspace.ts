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
// may have written: it is data for a person to read, never instructions. On the route table
// (`@miyoria/contracts/api`): `workspaceRpc` and `skillsRpc`.

import type { SkillSummary, SkillView, WorkspaceView } from "@miyoria/contracts/api";
import { type SkillShelf, SkillShelfKey, type SkillShelfPage } from "@miyoria/types";
import { SandboxKey, type WorkspaceApi } from "@miyoria/workspace/sandbox";
import { os } from "./contract.js";
import { ApiError } from "./errors.js";
import type { ApiState } from "./state.js";

/** Most characters of one skill's body shown. */
export const MAX_BODY_CHARS = 20_000;
/** Pages of a body read at most (a page is the store's `read_chars`). */
const MAX_PAGES = 50;
/** Most files listed in one answer. */
const MAX_FILES = 2_000;

function workspace(state: ApiState): WorkspaceApi {
  const sandbox = state.service(SandboxKey, "sandbox module (her workspace)");
  const ws = sandbox.workspace;
  if (ws === null) throw ApiError.unavailable("her workspace is turned off");
  return ws;
}

async function files(state: ApiState): Promise<WorkspaceView> {
  const ws = workspace(state);
  const [listing, usage] = await Promise.all([ws.list(), ws.usage()]);
  const sorted = [...listing.entries].sort((a, b) => a.path.localeCompare(b.path));
  return {
    files: sorted.slice(0, MAX_FILES).map((e) => ({ path: e.path, size: e.size })),
    truncated: listing.truncated || sorted.length > MAX_FILES,
    usage: { files: usage.files, bytes: usage.bytes, overflow: usage.overflow },
    limits: {
      max_bytes: ws.limits.maxBytes,
      max_files: ws.limits.maxFiles,
      max_file_bytes: ws.limits.maxFileBytes,
    },
  };
}

function shelf(state: ApiState): SkillShelf {
  return state.service(SkillShelfKey, "skills module (needs the sandbox workspace)");
}

async function skillList(state: ApiState): Promise<{ skills: SkillSummary[] }> {
  const { skills } = await shelf(state).list();
  return { skills: skills.map((s) => ({ name: s.name, description: s.description })) };
}

async function skillShow(state: ApiState, name: string): Promise<SkillView> {
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
  return {
    name,
    description: first.description,
    body,
    truncated: cut || [...pages.join("")].length > MAX_BODY_CHARS,
    files: first.files.map((f) => ({ path: f.path, size: f.size, script: f.script })),
  };
}

/** `GET /api/workspace`. */
export const workspaceRpc = os.workspace.handler(({ context }) => files(context.state));

/** `GET /api/skills` and `GET /api/skills/{name}`. */
export const skillsRpc = {
  list: os.skills.list.handler(({ context }) => skillList(context.state)),
  get: os.skills.get.handler(({ input, context }) => skillShow(context.state, input.params.name)),
};
