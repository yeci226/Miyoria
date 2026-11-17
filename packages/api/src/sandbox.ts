// Tools she wrote (`tool.propose`), for the owners: `GET /api/sandbox/tools` (list + sandbox
// state), `GET /api/sandbox/tools/:name` (with the code), and `POST .../approve` / `.../reject`
// for one exact version. Approving needs the owners' approval node (the same one as the
// Discord approval card); the bearer token is the owner.

import type { ProposedToolSummary, ReviewToolRequest } from "@miyoria/contracts/api";
import { errorMessage } from "@miyoria/runtime/kernel";
import {
  type ProposedTool,
  type ProposedTools,
  ProposedToolsKey,
  SandboxError,
  SandboxKey,
} from "@miyoria/workspace/sandbox";
import { os } from "./contract.js";
import { ApiError } from "./errors.js";
import { type ApiContext, type ApiState, actorOf } from "./state.js";

function summary(tool: ProposedTool): ProposedToolSummary {
  const { code, ...rest } = tool;
  return { ...rest, code_bytes: Buffer.byteLength(code, "utf8") };
}

function tools(state: ApiState): ProposedTools {
  return state.service(ProposedToolsKey, "sandbox module (with the settings store)");
}

function fromSandboxError(error: unknown): never {
  if (error instanceof SandboxError) {
    if (error.kind === "not_found") throw ApiError.notFound(error.message);
    if (error.kind === "wrong_state") throw ApiError.conflict(error.message);
    throw ApiError.badRequest(error.message);
  }
  throw error;
}

async function list(state: ApiState) {
  const sandbox = state.optional(SandboxKey);
  const all = await tools(state).list();
  return {
    sandbox: sandbox ? await sandbox.health() : null,
    tools: all.map(summary),
  };
}

/** Approves or rejects one exact version; the route's permission has been checked. */
async function review(
  state: ApiState,
  c: ApiContext,
  name: string,
  body: ReviewToolRequest,
  approve: boolean,
): Promise<ProposedToolSummary> {
  const store = tools(state);
  const reviewer = actorOf(c);
  const input = { reviewer, version: body.version, note: body.note ?? null };
  let tool: ProposedTool;
  try {
    tool = approve ? await store.approve(name, input) : await store.reject(name, input);
  } catch (error) {
    await state.audit(
      c,
      approve ? "sandbox.tool.approve" : "sandbox.tool.reject",
      name,
      { version: body.version, error: errorMessage(error) },
      false,
    );
    return fromSandboxError(error);
  }
  await state.audit(
    c,
    approve ? "sandbox.tool.approve" : "sandbox.tool.reject",
    name,
    { version: tool.version, code_sha256: tool.code_sha256 },
    true,
  );
  return summary(tool);
}

/** The sandbox routes on the route table (`@miyoria/contracts/api`). */
export const sandboxRpc = {
  tools: os.sandbox.tools.handler(({ context }) => list(context.state)),
  tool: os.sandbox.tool.handler(async ({ input, context }) => {
    const name = input.params.name;
    const tool = await tools(context.state)
      .get(name)
      .catch((error: unknown) => fromSandboxError(error));
    if (!tool) throw ApiError.notFound(`no proposed tool \`${name}\``);
    return tool;
  }),
  approve: os.sandbox.approve.handler(({ input, context }) =>
    review(context.state, context.c, input.params.name, input.body, true),
  ),
  reject: os.sandbox.reject.handler(({ input, context }) =>
    review(context.state, context.c, input.params.name, input.body, false),
  ),
};
